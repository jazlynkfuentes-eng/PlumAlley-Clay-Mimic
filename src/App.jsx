import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, 
  Download, 
  Trash2, 
  FileDown, 
  Check, 
  AlertCircle, 
  Clock, 
  Loader2, 
  Sparkles, 
  Sliders, 
  Search, 
  Upload, 
  X,
  RefreshCw,
  ExternalLink,
  Edit2
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { resolveDomain, enrichCompanyDetails } from './aiSimulator';

export default function App() {
  // Spreadsheet row state
  // Terminal statuses: found (Found & Verified), unverified (Found but Unverified), not_found (Not Found)
  // Schema: { id, companyName, website, industry, headcount, location, notes, status }
  const [rows, setRows] = useState([]);
  
  // Input text field state
  const [inputText, setInputText] = useState('');
  
  // Queue processing states
  const [queue, setQueue] = useState([]);
  const [processingId, setProcessingId] = useState(null);
  const [isProcessingActive, setIsProcessingActive] = useState(false);
  
  // Setting speed/latency
  const [latencySpeed, setLatencySpeed] = useState('normal'); // 'calm', 'normal', 'fast'
  const [showSettings, setShowSettings] = useState(false);

  // Cell editing states
  // editingCell: { id, column }
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  // Dashboard password protection
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const DASHBOARD_PASSWORD = 'dashboard2026';

  // Refs
  const fileInputRef = useRef(null);
  const textInputRef = useRef(null);
  const editInputRef = useRef(null);
  const prevQueueLength = useRef(0);

  // Auto-focus editable cell input when double clicked
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Adjust simulator delay factor based on speed setting
  const getDelayFactor = () => {
    if (latencySpeed === 'calm') return 1.8;
    if (latencySpeed === 'fast') return 0.4;
    return 1.0;
  };

  // Queue listener & execution loop
  useEffect(() => {
    if (queue.length === 0 && !processingId) {
      if (isProcessingActive) {
        // Queue just finished
        const successCount = rows.filter(r => r.status === 'found' || r.status === 'unverified').length;
        if (successCount > 0) {
          // Trigger a gentle confetti shower
          confetti({
            particleCount: 80,
            spread: 60,
            origin: { y: 0.8 },
            colors: ['#5B7FA6', '#7DB89A', '#D8E2EC', '#A5C4D4']
          });
        }
        setIsProcessingActive(false);
      }
      return;
    }

    if (!processingId && queue.length > 0) {
      const nextId = queue[0];
      setQueue(prev => prev.slice(1));
      setProcessingId(nextId);
      setIsProcessingActive(true);
    }
  }, [queue, processingId, isProcessingActive, rows]);

  // Run the enrichment for a single row
  useEffect(() => {
    if (!processingId) return;

    const rowToProcess = rows.find(r => r.id === processingId);
    if (!rowToProcess) {
      setProcessingId(null);
      return;
    }

    const processRow = async () => {
      const factor = getDelayFactor();
      const blankFields = {
        industry: '-',
        headcount: '-',
        location: '-',
      };
      
      // If there's no company name, we can't search.
      if (!rowToProcess.companyName || !rowToProcess.companyName.trim()) {
        updateRow(processingId, { 
          status: 'not_found',
          website: '',
          ...blankFields,
          notes: 'No company name provided'
        });
        setProcessingId(null);
        return;
      }

      // Step 1: Resolve Domain (unless it was already overridden manually)
      let domain = rowToProcess.website;
      let isDomainPrepopulated = !!domain && domain.includes('.');
      let verification = 'verified'; // manual override treated as confirmed for enrichment path

      if (!isDomainPrepopulated) {
        updateRow(processingId, { status: 'searching' });
        
        try {
          const delayStart = Date.now();
          // Pass any user-provided industry/location as disambiguation context
          const resolved = await resolveDomain(rowToProcess.companyName, {
            industry: rowToProcess.industry,
            location: rowToProcess.location
          });
          const elapsed = Date.now() - delayStart;
          
          const remainingDelay = (1000 * factor) - elapsed;
          if (remainingDelay > 0) {
            await new Promise(r => setTimeout(r, remainingDelay));
          }

          verification = resolved?.verification || 'not_found';
          domain = resolved?.domain || '';

          if (verification === 'not_found' || !domain) {
            updateRow(processingId, { 
              status: 'not_found',
              website: '',
              ...blankFields,
              notes: resolved?.reason || 'Could not resolve official domain'
            });
            setProcessingId(null);
            return;
          }

          if (verification === 'unverified') {
            // Found but Unverified: show candidate + warning, do NOT enrich from a guess
            updateRow(processingId, {
              website: domain,
              status: 'unverified',
              ...blankFields,
              notes: resolved?.reason || 'Possible website found but not confidently verified'
            });
            setProcessingId(null);
            return;
          }

          // Verified — proceed to enrichment only after confirmation
          updateRow(processingId, { website: domain, status: 'enriching' });
        } catch (err) {
          updateRow(processingId, { 
            status: 'not_found',
            website: '',
            ...blankFields,
            notes: 'Search engine error while resolving domain'
          });
          setProcessingId(null);
          return;
        }
      } else {
        updateRow(processingId, { status: 'enriching' });
      }

      // Step 2: Enrich details only for verified websites
      try {
        const delayStart = Date.now();
        const details = await enrichCompanyDetails(domain, rowToProcess.companyName);
        const elapsed = Date.now() - delayStart;
        
        const remainingDelay = (800 * factor) - elapsed;
        if (remainingDelay > 0) {
          await new Promise(r => setTimeout(r, remainingDelay));
        }

        updateRow(processingId, {
          industry: details.industry || 'Unknown',
          headcount: details.headcount || 'Unknown',
          location: details.location || 'Unknown',
          notes: details.notes || 'Verified website; enrichment complete',
          status: 'found'
        });
      } catch (err) {
        updateRow(processingId, {
          website: domain,
          status: 'found',
          industry: 'Unknown',
          headcount: 'Unknown',
          location: 'Unknown',
          notes: 'Website verified, but enrichment could not complete confidently'
        });
      }

      setProcessingId(null);
    };

    processRow();
  }, [processingId]);

  // Helper to update a row's details in local state
  const updateRow = (id, newFields) => {
    setRows(prev => prev.map(row => {
      if (row.id === id) {
        return { ...row, ...newFields };
      }
      return row;
    }));
  };

  // Run enrichment on multiple lines
  const handleRunEnrichment = () => {
    if (!inputText.trim()) return;

    const names = inputText
      .split('\n')
      .map(name => name.trim())
      .filter(name => name.length > 0);

    const newRows = names.map(name => ({
      id: crypto.randomUUID(),
      companyName: name,
      website: '',
      industry: '-',
      headcount: '-',
      location: '-',
      notes: 'Queueing...',
      status: 'pending'
    }));

    setRows(prev => [...prev, ...newRows]);
    setQueue(prev => [...prev, ...newRows.map(r => r.id)]);
    setInputText('');
  };

  // Add a single blank row
  const handleAddBlankRow = () => {
    const newRow = {
      id: crypto.randomUUID(),
      companyName: '',
      website: '',
      industry: '',
      headcount: '',
      location: '',
      notes: '',
      status: 'pending'
    };
    setRows(prev => [...prev, newRow]);
  };

  // Parse TXT or CSV file uploads
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text !== 'string') return;

      let companyNames = [];

      if (file.name.endsWith('.csv')) {
        // Parse CSV simply
        const lines = text.split(/\r?\n/);
        if (lines.length > 0) {
          // Check headers
          const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
          let compIdx = headers.findIndex(h => h.includes('company') || h.includes('name') || h.includes('business'));
          
          if (compIdx === -1) compIdx = 0; // fallback to first column
          
          for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            // Simple split with quote stripping
            const columns = lines[i].split(',').map(c => c.replace(/^["']|["']$/g, '').trim());
            if (columns[compIdx]) {
              companyNames.push(columns[compIdx]);
            }
          }
        }
      } else {
        // Plain text file - one name per line
        companyNames = text
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0);
      }

      if (companyNames.length > 0) {
        const newRows = companyNames.map(name => ({
          id: crypto.randomUUID(),
          companyName: name,
          website: '',
          industry: '-',
          headcount: '-',
          location: '-',
          notes: 'Queueing...',
          status: 'pending'
        }));

        setRows(prev => [...prev, ...newRows]);
        setQueue(prev => [...prev, ...newRows.map(r => r.id)]);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // clear target
  };

  // Re-run single row process
  const triggerRowReRun = (rowId, { clearWebsite = true } = {}) => {
    // If already in queue or processing, skip
    if (queue.includes(rowId) || processingId === rowId) return;

    setRows(prev => prev.map(row => {
      if (row.id === rowId) {
        return { 
          ...row,
          // Clear prior website so resolution runs again (unless user just set it manually)
          ...(clearWebsite ? { website: '' } : {}),
          industry: '-',
          headcount: '-',
          location: '-',
          status: 'pending',
          notes: 'Re-running enrichment...'
        };
      }
      return row;
    }));
    setQueue(prev => [...prev, rowId]);
  };

  // Cell editing triggers
  const handleCellDoubleClick = (rowId, colName, currentValue) => {
    // If currently processing that specific row, disable edits to prevent race conditions
    if (processingId === rowId) return;

    setEditingCell({ id: rowId, column: colName });
    setEditingValue(currentValue || '');
  };

  const handleCellSave = () => {
    if (!editingCell) return;

    const { id, column } = editingCell;
    const currentRow = rows.find(r => r.id === id);
    if (!currentRow) return;

    const oldValue = currentRow[column];
    const newValue = editingValue.trim();

    setEditingCell(null);

    // If value did not change, do nothing
    if (oldValue === newValue) return;

    // Update row cell state
    updateRow(id, { [column]: newValue });

    // Core rule: "edited row re-runs enrichment with corrected value"
    // Trigger re-enrichment if companyName or website was changed
    if (column === 'companyName') {
      // Name change → re-resolve from scratch
      triggerRowReRun(id, { clearWebsite: true });
    } else if (column === 'website') {
      // Manual website override → enrich using the edited domain
      triggerRowReRun(id, { clearWebsite: false });
    }
  };

  const handleCellKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleCellSave();
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    }
  };

  // Clear table state entirely
  const handleClearTable = () => {
    setRows([]);
    setQueue([]);
    setProcessingId(null);
    setIsProcessingActive(false);
  };

  // Export spreadsheet state to CSV
  const handleExportCSV = () => {
    if (rows.length === 0) return;

    const headers = ['Company Name', 'Website', 'Industry', 'Headcount (est.)', 'Location', 'Notes'];
    const csvRows = [headers.join(',')];

    rows.forEach(row => {
      const line = [
        `"${(row.companyName || '').replace(/"/g, '""')}"`,
        `"${(row.website || '').replace(/"/g, '""')}"`,
        `"${(row.industry || '').replace(/"/g, '""')}"`,
        `"${(row.headcount || '').replace(/"/g, '""')}"`,
        `"${(row.location || '').replace(/"/g, '""')}"`,
        `"${(row.notes || '').replace(/"/g, '""')}"`
      ];
      csvRows.push(line.join(','));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `company_enrichment_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Stats calculators
  const stats = {
    total: rows.length,
    pending: rows.filter(r => r.status === 'pending').length + queue.length,
    searching: rows.filter(r => r.status === 'searching' || r.status === 'enriching').length + (processingId ? 1 : 0),
    found: rows.filter(r => r.status === 'found').length,
    unverified: rows.filter(r => r.status === 'unverified').length,
    notFound: rows.filter(r => r.status === 'not_found').length
  };

  // Normalize searching indicators
  const totalCompleted = stats.total - stats.pending - stats.searching;
  const progressPercent = stats.total > 0 ? Math.round((totalCompleted / stats.total) * 100) : 0;

  if (!isAuthenticated) {
    return (
      <div className="password-container" style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg)'}}>
        <h2>Enter Dashboard Password</h2>
        <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" style={{margin:'0.5rem',padding:'0.5rem'}} />
        <button className="btn btn-primary" onClick={()=>{
          if (password===DASHBOARD_PASSWORD){ setIsAuthenticated(true); setAuthError(''); } else { setAuthError('Incorrect password'); }
        }}>Enter</button>
        {authError && <p style={{color:'var(--error-text)'}}>{authError}</p>}
      </div>
    );
  }
  return (
    <div className="app-container">
      {/* Top Header Bar */}
      <header className="top-bar">
        <div className="brand-section">
          <div className="logo-container">🔹</div>
          <h1 className="brand-title">Enrich</h1>
          <span className="brand-tagline">Paste company names. Get websites and data.</span>
        </div>
        <div className="actions-section">
          <button 
            className="btn" 
            title="Configure processing behavior"
            onClick={() => setShowSettings(true)}
          >
            <Sliders size={15} />
            <span>Settings</span>
          </button>
          
          <button 
            className="btn btn-danger"
            disabled={rows.length === 0}
            onClick={handleClearTable}
          >
            <Trash2 size={15} />
            <span>Clear Table</span>
          </button>
          
          <button 
            className="btn btn-primary"
            disabled={rows.length === 0}
            onClick={handleExportCSV}
          >
            <Download size={15} />
            <span>Export CSV</span>
          </button>
        </div>
      </header>

      {/* Input panel area */}
      <section className="input-section">
        <div className="input-header">
          <div>
            <h2 className="input-title">Batch Company List</h2>
            <span className="input-subtitle">Enter company names to fetch and resolve official domains.</span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <label className="file-upload-label">
              <Upload size={14} />
              <span>Import TXT / CSV</span>
              <input 
                type="file" 
                ref={fileInputRef}
                accept=".csv,.txt" 
                className="file-upload-input" 
                onChange={handleFileUpload} 
              />
            </label>
          </div>
        </div>

        <div className="textarea-container">
          <textarea
            ref={textInputRef}
            className="company-textarea"
            placeholder="Paste your company names here, one per line (e.g. Google&#10;Microsoft&#10;Plum Alley Ventures)..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                handleRunEnrichment();
              }
            }}
          />
        </div>

        <div className="input-controls">
          <span className="input-subtitle" style={{ fontStyle: 'italic' }}>
            Tip: Press Ctrl + Enter to run enrichment instantly
          </span>
          <button 
            className="btn btn-primary" 
            onClick={handleRunEnrichment}
            disabled={!inputText.trim()}
          >
            <Sparkles size={15} />
            <span>Run Enrichment</span>
          </button>
        </div>
      </section>

      {/* Stats Bar */}
      {rows.length > 0 && (
        <section className="stats-panel">
          <div className="stat-item">
            <span className="stat-label">Total Rows:</span>
            <span className="stat-value">{stats.total}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Found & Verified:</span>
            <span className="stat-value" style={{ color: 'var(--success-text)' }}>{stats.found}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Found but Unverified:</span>
            <span className="stat-value" style={{ color: '#B45309' }}>{stats.unverified}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Not Found:</span>
            <span className="stat-value" style={{ color: 'var(--error-text)' }}>{stats.notFound}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Remaining Queue:</span>
            <span className="stat-value">{stats.pending + stats.searching}</span>
          </div>

          {(stats.pending > 0 || stats.searching > 0) && (
            <div className="stat-progress-bar-container">
              <div className="stat-progress-track">
                <div 
                  className="stat-progress-bar" 
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="stat-subtitle">{progressPercent}%</span>
            </div>
          )}
        </section>
      )}

      {/* Spreadsheet Workspace */}
      <section className="table-workspace">
        {rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Search size={40} strokeWidth={1.5} />
            </div>
            <h3 className="empty-state-title">Quiet Productivity Dashboard</h3>
            <p className="empty-state-subtitle">
              Paste a list of company names above, or drag in a CSV file, to resolve official domains and enrich datasets.
            </p>
          </div>
        ) : (
          <div className="table-scroll-container">
            <table className="spreadsheet-table">
              <thead>
                <tr>
                  <th className="col-status">Status</th>
                  <th className="col-name">Company Name</th>
                  <th className="col-website">Website</th>
                  <th className="col-industry">Industry</th>
                  <th className="col-headcount">Headcount (est.)</th>
                  <th className="col-location">Location</th>
                  <th className="col-notes">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isRowProcessing = processingId === row.id;
                  
                  return (
                    <tr key={row.id} className="table-row">
                      {/* Status Column */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          {row.status === 'pending' && (
                            <span className="status-badge pending">
                              <Clock size={12} />
                              <span>Pending</span>
                            </span>
                          )}
                          {row.status === 'searching' && (
                            <span className="status-badge searching">
                              <Loader2 size={12} className="spinner" />
                              <span>Searching...</span>
                            </span>
                          )}
                          {row.status === 'enriching' && (
                            <span className="status-badge searching">
                              <Loader2 size={12} className="spinner" />
                              <span>Enriching...</span>
                            </span>
                          )}
                          {row.status === 'found' && (
                            <span className="status-badge found" title={row.notes}>
                              <Check size={12} />
                              <span>Found & Verified</span>
                            </span>
                          )}
                          {row.status === 'unverified' && (
                            <span className="status-badge unverified" title={row.notes}>
                              <AlertCircle size={12} />
                              <span>Found but Unverified</span>
                            </span>
                          )}
                          {row.status === 'not_found' && (
                            <span className="status-badge not-found" title={row.notes}>
                              <AlertCircle size={12} />
                              <span>Not Found</span>
                            </span>
                          )}
                          
                          {/* Re-run button for non-processing rows */}
                          {!isRowProcessing && row.status !== 'pending' && (
                            <button 
                              className="btn" 
                              style={{ padding: '0.15rem 0.35rem', fontSize: '0.7rem', borderRadius: '4px', height: 'auto' }}
                              title="Re-run enrichment"
                              onClick={() => triggerRowReRun(row.id)}
                            >
                              <RefreshCw size={10} />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Company Name Cell */}
                      <td 
                        className="editable-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'companyName', row.companyName)}
                        title="Double-click to edit"
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'companyName' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          <div style={{ display: 'flex', justifyContent: 'between', alignItems: 'center', width: '100%' }}>
                            <span style={{ flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {row.companyName || <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Double-click to name</span>}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Website Cell */}
                      <td 
                        className="editable-cell url-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'website', row.website)}
                        title="Double-click to override website"
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'website' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor mono"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          row.website ? (
                            <a 
                              href={row.website.startsWith('http') ? row.website : `https://${row.website}`} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="url-link"
                              onClick={(e) => e.stopPropagation()} // don't trigger cell edit
                            >
                              <span>{row.website}</span>
                              <ExternalLink size={10} />
                            </a>
                          ) : (
                            <span style={{ color: 'var(--text-secondary)' }}>-</span>
                          )
                        )}
                      </td>

                      {/* Industry Cell */}
                      <td 
                        className="editable-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'industry', row.industry)}
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'industry' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          row.industry || '-'
                        )}
                      </td>

                      {/* Headcount Cell */}
                      <td 
                        className="editable-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'headcount', row.headcount)}
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'headcount' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          row.headcount || '-'
                        )}
                      </td>

                      {/* Location Cell */}
                      <td 
                        className="editable-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'location', row.location)}
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'location' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          row.location || '-'
                        )}
                      </td>

                      {/* Notes Cell */}
                      <td 
                        className="editable-cell"
                        onDoubleClick={() => handleCellDoubleClick(row.id, 'notes', row.notes)}
                      >
                        {editingCell?.id === row.id && editingCell?.column === 'notes' ? (
                          <input
                            ref={editInputRef}
                            className="cell-editor"
                            value={editingValue}
                            onChange={(e) => setEditingValue(e.target.value)}
                            onBlur={handleCellSave}
                            onKeyDown={handleCellKeyDown}
                          />
                        ) : (
                          <span title={row.notes}>{row.notes || '-'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Add row bar */}
        {rows.length > 0 && (
          <div className="table-bottom-actions">
            <button className="btn-add-row" onClick={handleAddBlankRow}>
              <Plus size={12} />
              <span>Add Empty Row</span>
            </button>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Double-click any cell to edit details. Changing the company name or website will auto-trigger re-enrichment.
            </span>
          </div>
        )}
      </section>

      {/* Settings Modal */}
      {showSettings && (
        <div className="settings-modal-overlay">
          <div className="settings-modal">
            <div className="settings-header">
              <h3 className="settings-title">Processing Preferences</h3>
              <button className="settings-close" onClick={() => setShowSettings(false)}>
                <X size={18} />
              </button>
            </div>
            
            <div className="form-group">
              <label className="form-label">Simulation Processing Speed</label>
              <select 
                className="form-input" 
                value={latencySpeed}
                onChange={(e) => setLatencySpeed(e.target.value)}
              >
                <option value="calm">Calm & Restful (Slow latency)</option>
                <option value="normal">Standard (Default network speed)</option>
                <option value="fast">Speed Demon (Immediate replies)</option>
              </select>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                Adjusts the artificial lag of the Base44 simulation calls to let you inspect cell transitions.
              </p>
            </div>

            <div className="form-group" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
              <label className="form-label">Simulated AI Model Prompt</label>
              <textarea 
                className="form-input" 
                style={{ fontSize: '0.8rem', resize: 'none', height: '110px' }} 
                readOnly
                value='Search the web for candidate domains for [X] (use industry/location if provided). Cross-check before returning a domain; only mark Verified when confident it is the official site. Otherwise return Unverified or Not Found — never silently guess. Enrich Industry/Headcount/Location/Notes only after verification, from website content; leave Unknown when not confident.'
              />
            </div>

            <button 
              className="btn btn-primary" 
              style={{ alignSelf: 'flex-end', marginTop: '0.5rem' }}
              onClick={() => setShowSettings(false)}
            >
              Save & Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
