/**
 * Generic cross-industry enrichment evaluation harness.
 * Scores identity (domain) separately from enrichment coverage.
 * Does NOT use expectedDomain as a production dictionary lookup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN,
  isBlankOrUnknown,
  sanitizeUserFacingNotes,
  normalizeIndustry,
  normalizeLocation,
  normalizeHeadcount,
  normalizeFounders,
  finalizeEnrichmentFields,
  extractFieldsFromSearchCorpus,
  preferField,
  expandPastedCompanyInput,
  dedupeCompanyNames
} from './lib/enrichment-quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evalPath = path.join(root, 'data/eval/cross-industry-companies.json');

const HARD_TIMEOUT_MS = 7000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = HARD_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function hostOf(domain) {
  return String(domain || '')
    .toLowerCase()
    .replace(/[\[\]]/g, '')
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
}

function scoreDomainForName(name, domain) {
  const host = hostOf(domain).replace(/\.[a-z]{2,}$/i, '').replace(/\./g, '');
  const key = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!host || !key) return 0;
  let score = 0;
  if (host === key) score += 100;
  if (host.includes(key) || key.includes(host)) score += 60;
  const tokens = String(name || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 2 && !/^(the|and|global|management|capital|ventures|company)$/.test(t));
  for (const tok of tokens) {
    if (host.includes(tok)) score += 20;
  }
  // Penalize news / wrong verticals
  if (/news|aircraft|msn|hci\.org|wikipedia/.test(hostOf(domain))) score -= 80;
  return score;
}

function domainMatches(got, expected, altDomains = []) {
  const g = hostOf(got);
  const targets = [expected, ...(altDomains || [])].map(hostOf).filter(Boolean);
  return targets.some((t) => g === t || g.endsWith(`.${t}`) || t.endsWith(`.${g}`));
}

async function resolveDomainCandidate(name) {
  const queries = [`${name} official website`, name];
  const candidates = [];
  let timeouts = 0;
  let searchUsed = false;

  for (const q of queries.slice(0, 2)) {
    try {
      searchUsed = true;
      const res = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`,
        {},
        5000
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.Infobox?.content) {
        const official = json.Infobox.content.find(
          (i) => i.data_type === 'official_website' || /official website|website/i.test(i.label || '')
        );
        if (official?.value) {
          const d = hostOf(official.value);
          if (d && d.includes('.')) candidates.push({ domain: d, source: 'ddg_infobox', confidence: 'high' });
        }
      }
      if (json.AbstractURL) {
        const d = hostOf(json.AbstractURL);
        if (d && d.includes('.') && !/wikipedia|wikidata|linkedin|crunchbase|pitchbook/i.test(d)) {
          candidates.push({ domain: d, source: 'ddg_abstract', confidence: 'medium' });
        }
      }
    } catch {
      timeouts += 1;
    }
  }

  // Clearbit autocomplete (same public endpoint the app uses)
  try {
    const res = await fetchWithTimeout(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' } },
      5000
    );
    if (res.ok) {
      const arr = await res.json();
      for (const row of (arr || []).slice(0, 3)) {
        if (row?.domain) {
          candidates.push({
            domain: hostOf(row.domain),
            source: 'clearbit',
            confidence: 'medium',
            name: row.name
          });
        }
      }
    }
  } catch {
    timeouts += 1;
  }

  // Prefer non-aggregator domains, ranked by name↔domain similarity
  const junk = /linkedin|crunchbase|pitchbook|bloomberg|wikipedia|facebook|twitter|youtube|msn\.com|hci\.org|mercurynews/i;
  const clean = candidates
    .filter((c) => c.domain && !junk.test(c.domain))
    .map((c) => ({ ...c, domain: hostOf(c.domain), _score: scoreDomainForName(name, c.domain) }))
    .sort((a, b) => b._score - a._score || (b.confidence === 'high' ? 1 : 0) - (a.confidence === 'high' ? 1 : 0));
  return { best: clean[0] || null, candidates: clean, timeouts, searchUsed };
}

async function fetchCorpus(name, domain) {
  let corpus = '';
  let timeouts = 0;
  const queries = [
    `"${name}" company`,
    `"${name}" headquarters`,
    `"${name}" founders`,
    `"${name}" employees industry`
  ];
  for (const q of queries.slice(0, 3)) {
    try {
      const res = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`,
        {},
        4500
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.AbstractText) corpus += ` ${json.AbstractText}`;
      if (json.Heading) corpus += ` ${json.Heading}`;
      if (Array.isArray(json.RelatedTopics)) {
        for (const topic of json.RelatedTopics.slice(0, 4)) {
          if (topic?.Text) corpus += ` ${topic.Text}`;
        }
      }
    } catch {
      timeouts += 1;
    }
  }

  if (domain) {
    try {
      const res = await fetchWithTimeout(`https://${domain}/`, {
        headers: { 'User-Agent': 'ClayMimicEval/1.0', Accept: 'text/html' },
        redirect: 'follow'
      }, 5000);
      if (res.ok) {
        const html = await res.text();
        const desc =
          html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
        if (desc) corpus += ` ${desc}`;
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 5000);
        corpus += ` ${text}`;
      }
    } catch {
      timeouts += 1;
    }
  }

  // Wikidata by exact official URL (fast VALUES query)
  if (domain) {
    const host = hostOf(domain);
    const urls = [`https://${host}/`, `https://www.${host}/`, `https://${host}`, `https://www.${host}`];
    const values = urls.map((u) => `<${u}>`).join(' ');
    const sparql = `SELECT ?hqLabel ?founderLabel ?employees ?desc WHERE {
      VALUES ?url { ${values} }
      ?item wdt:P856 ?url .
      OPTIONAL { ?item wdt:P159 ?hq . }
      OPTIONAL { ?item wdt:P112 ?founder . }
      OPTIONAL { ?item wdt:P1128 ?employees . }
      OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 6`;
    try {
      const res = await fetchWithTimeout(
        `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
        { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'ClayMimicEval/1.0' } },
        6000
      );
      if (res.ok) {
        const json = await res.json();
        for (const b of json?.results?.bindings || []) {
          if (b.desc?.value) corpus += ` ${b.desc.value}`;
          if (b.hqLabel?.value) corpus += ` headquartered in ${b.hqLabel.value}`;
          if (b.founderLabel?.value) corpus += ` founded by ${b.founderLabel.value}`;
          if (b.employees?.value) corpus += ` ${b.employees.value} employees`;
        }
      }
    } catch {
      timeouts += 1;
    }
  }

  return { corpus: corpus.trim(), timeouts };
}

async function enrichCompany(entry) {
  const started = Date.now();
  const metrics = { timeouts: 0, searchFallback: false };
  let identity;
  try {
    identity = await resolveDomainCandidate(entry.name);
    metrics.timeouts += identity.timeouts;
    metrics.searchFallback = identity.searchUsed;
  } catch {
    identity = { best: null, candidates: [], timeouts: 1, searchUsed: true };
    metrics.timeouts += 1;
  }

  const domain = identity.best?.domain || null;
  const { corpus, timeouts } = await fetchCorpus(entry.name, domain);
  metrics.timeouts += timeouts;

  const mined = extractFieldsFromSearchCorpus(corpus, entry.name);
  let row = finalizeEnrichmentFields({
    industry: mined.industry,
    headcount: mined.headcount,
    location: mined.location,
    contacts: mined.contacts,
    notes: mined.notes,
    gender: UNKNOWN
  });

  // Domain-confirmed notes from meta only if clean
  if (/may refer to|disambiguation/i.test(String(row.notes))) row.notes = UNKNOWN;

  const elapsedMs = Date.now() - started;
  const identityOk = domain && domainMatches(domain, entry.expectedDomain, entry.altDomains);

  const provenance = mined.provenance || {};
  const confCounts = { high: 0, medium: 0, low: 0 };
  for (const k of Object.keys(provenance)) {
    const c = provenance[k]?.confidence || 'low';
    if (confCounts[c] != null) confCounts[c] += 1;
  }

  return {
    name: entry.name,
    category: entry.category || 'general',
    expectedDomain: entry.expectedDomain,
    resolvedDomain: domain,
    domainSource: identity.best?.source || null,
    domainConfidence: identity.best?.confidence || null,
    identityCorrect: !!identityOk,
    industry: row.industry,
    headcount: row.headcount,
    location: row.location,
    founders: row.contacts,
    notes: sanitizeUserFacingNotes(row.notes) || '',
    notesHasPipelineLeak: /verifying selected domain|score \d+|sparql|retry/i.test(String(row.notes || '')),
    provenance,
    confCounts,
    elapsedMs,
    timeouts: metrics.timeouts,
    searchFallback: metrics.searchFallback,
    failed: !domain
  };
}

function summarize(rows) {
  const n = rows.length || 1;
  const fields = ['industry', 'headcount', 'location', 'founders'];
  const unknown = {};
  for (const f of fields) unknown[f] = rows.filter((r) => isBlankOrUnknown(r[f])).length;

  const identityCorrect = rows.filter((r) => r.identityCorrect).length;
  const correctlyResolved = rows.filter((r) => r.identityCorrect);
  const coverage = {};
  for (const f of fields) {
    const filled = correctlyResolved.filter((r) => !isBlankOrUnknown(r[f])).length;
    coverage[f] = correctlyResolved.length
      ? Math.round((filled / correctlyResolved.length) * 1000) / 10
      : 0;
  }

  const totalUnknownCells = Object.values(unknown).reduce((a, b) => a + b, 0);
  const totalCells = rows.length * fields.length;

  let high = 0;
  let medium = 0;
  let low = 0;
  for (const r of rows) {
    high += r.confCounts.high;
    medium += r.confCounts.medium;
    low += r.confCounts.low;
  }
  const confTotal = high + medium + low || 1;

  return {
    companyCount: rows.length,
    domainResolutionAccuracy: Math.round((identityCorrect / n) * 1000) / 10,
    identityCorrectCount: identityCorrect,
    enrichmentCoveragePct: coverage,
    unknownCounts: unknown,
    totalUnknownRate: Math.round((totalUnknownCells / totalCells) * 1000) / 10,
    highConfidencePct: Math.round((high / confTotal) * 1000) / 10,
    mediumConfidencePct: Math.round((medium / confTotal) * 1000) / 10,
    lowConfidencePct: Math.round((low / confTotal) * 1000) / 10,
    failedCompanies: rows.filter((r) => r.failed).map((r) => r.name),
    avgProcessingMs: Math.round(rows.reduce((a, r) => a + r.elapsedMs, 0) / n),
    timeoutCount: rows.reduce((a, r) => a + r.timeouts, 0),
    searchFallbackUsageRate: Math.round((rows.filter((r) => r.searchFallback).length / n) * 1000) / 10,
    notesPollutionCount: rows.filter((r) => r.notesHasPipelineLeak).length
  };
}

async function runBatch(label, companies, concurrency = 3) {
  console.log(`\n=== ${label} (${companies.length} companies) ===`);
  const rows = [];
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const entry = companies[idx];
      process.stdout.write(`  [${idx + 1}/${companies.length}] ${entry.name}... `);
      try {
        const row = await enrichCompany(entry);
        rows[idx] = row;
        console.log(
          `${row.identityCorrect ? 'ID✓' : 'ID✗'} ${row.resolvedDomain || '—'} | ${row.industry} | ${row.location}`
        );
      } catch (e) {
        rows[idx] = {
          name: entry.name,
          expectedDomain: entry.expectedDomain,
          resolvedDomain: null,
          identityCorrect: false,
          industry: UNKNOWN,
          headcount: UNKNOWN,
          location: UNKNOWN,
          founders: UNKNOWN,
          notes: '',
          notesHasPipelineLeak: false,
          provenance: {},
          confCounts: { high: 0, medium: 0, low: 0 },
          elapsedMs: 0,
          timeouts: 1,
          searchFallback: true,
          failed: true,
          error: String(e.message || e)
        };
        console.log('FAILED', e.message || e);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { rows, summary: summarize(rows) };
}

async function main() {
  const mode = process.argv[2] || 'all';
  const dataset = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  const outDir = path.join(root, 'data/eval');
  fs.mkdirSync(outDir, { recursive: true });

  // Quick unit sanity for paste helpers
  const expanded = expandPastedCompanyInput('1. Nvidia\n• Apple Inc\nRamp, M13, Shopify');
  const deduped = dedupeCompanyNames(['NVIDIA', 'NVIDIA Corporation', 'Apple']);
  console.log('Paste expand sample:', expanded);
  console.log('Dedupe sample:', deduped);

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    pasteExpandOk: expanded.length >= 4,
    dedupeOk: deduped.length === 2
  };

  if (mode === 'cross' || mode === 'all') {
    const { rows, summary } = await runBatch('Cross-industry', dataset.companies, 3);
    report.crossIndustry = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'cross-industry-results.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nCross-industry summary:', summary);
  }

  if (mode === 'vc' || mode === 'all') {
    const { rows, summary } = await runBatch('VC regression', dataset.vcRegression, 3);
    report.vcRegression = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'vc-regression-results.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nVC regression summary:', summary);
  }

  if (mode === 'unseen' || mode === 'all') {
    const { rows, summary } = await runBatch('Unseen holdout (5)', dataset.unseenHoldout, 2);
    report.unseenFive = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'unseen-five-results.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nUnseen-five summary:', summary);
  }

  fs.writeFileSync(path.join(outDir, 'eval-report.json'), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.join(outDir, 'eval-report.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
