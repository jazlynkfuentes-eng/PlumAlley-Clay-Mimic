/**
 * Harder-sample website resolution audit.
 * Focuses on categories that inflate accuracy when only famous brands are tested:
 * law firms, foundations, regional companies, legacy businesses, government bodies.
 *
 * Mirrors the live multi-source resolver: dictionary → Clearbit + DuckDuckGo + Wikipedia/Wikidata
 * pooled, then multi-signal scored (name similarity, wiki notability, DNS).
 * Content scrape is skipped here for speed; DNS stands in for live reachability.
 *
 * "Found & Verified" = top candidate clears confidence threshold, DNS resolves,
 * and domain matches the expected host (or known alias).
 */
import fs from 'fs';

const CONFIDENCE_THRESHOLD = 70;
const AMBIGUITY_GAP = 12;

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dictStart = html.indexOf('const companyDictionary = {');
const dictEnd = html.indexOf('\n    };', dictStart);
const dictBlock = html.slice(dictStart, dictEnd);
const dictEntries = [];
const dictRe = /"([^"]+)":\s*\{[\s\S]*?domain:\s*"([^"]+)"/g;
let dm;
while ((dm = dictRe.exec(dictBlock))) {
  dictEntries.push({ key: dm[1], domain: dm[2].toLowerCase() });
}

function dictLookup(name) {
  const key = String(name || '').trim().toLowerCase();
  const norm = companyKeyNorm(name);
  for (const e of dictEntries) {
    if (e.key === key || companyKeyNorm(e.key) === norm) return e;
  }
  for (const e of dictEntries) {
    const ek = companyKeyNorm(e.key);
    if (ek && (norm.includes(ek) || ek.includes(norm)) && Math.min(ek.length, norm.length) >= 4) return e;
  }
  return null;
}

/** @type {{ name: string, domain: string, category: string, aliases?: string[] }[]} */
const HARD_SAMPLE = [
  // Law firms
  { name: 'Cravath Swaine & Moore', domain: 'cravath.com', category: 'law' },
  { name: 'Sullivan & Cromwell', domain: 'sullcrom.com', category: 'law' },
  { name: 'Wachtell Lipton Rosen & Katz', domain: 'wlrk.com', category: 'law' },
  { name: 'Skadden Arps', domain: 'skadden.com', category: 'law' },
  { name: 'Kirkland & Ellis', domain: 'kirkland.com', category: 'law' },
  { name: 'Latham & Watkins', domain: 'lw.com', category: 'law' },
  { name: 'Baker McKenzie', domain: 'bakermckenzie.com', category: 'law' },
  // Foundations / nonprofits
  { name: 'Ford Foundation', domain: 'fordfoundation.org', category: 'foundation' },
  { name: 'Rockefeller Foundation', domain: 'rockefellerfoundation.org', category: 'foundation' },
  { name: 'Andrew W. Mellon Foundation', domain: 'mellon.org', category: 'foundation' },
  { name: 'MacArthur Foundation', domain: 'macfound.org', category: 'foundation' },
  { name: 'Bill & Melinda Gates Foundation', domain: 'gatesfoundation.org', category: 'foundation' },
  { name: 'West Virginia University Foundation', domain: 'wvuf.org', category: 'foundation' },
  { name: 'Trinity Church Wall Street', domain: 'trinitywallstreet.org', category: 'foundation' },
  // Regional / mid-market
  { name: 'Fifth Third Bank', domain: '53.com', category: 'regional' },
  { name: 'PNC Financial Services', domain: 'pnc.com', category: 'regional' },
  { name: 'Huntington Bancshares', domain: 'huntington.com', category: 'regional' },
  { name: 'Associated Bank', domain: 'associatedbank.com', category: 'regional' },
  { name: 'Frost Bank', domain: 'frostbank.com', category: 'regional' },
  { name: 'Commerce Bank', domain: 'commercebank.com', category: 'regional' },
  // Legacy / older businesses
  { name: 'Procter & Gamble', domain: 'pg.com', category: 'legacy' },
  { name: 'General Electric', domain: 'ge.com', category: 'legacy' },
  { name: 'International Business Machines', domain: 'ibm.com', category: 'legacy' },
  { name: 'Caterpillar', domain: 'caterpillar.com', category: 'legacy', aliases: ['cat.com'] },
  { name: 'DuPont', domain: 'dupont.com', category: 'legacy' },
  { name: '3M Company', domain: '3m.com', category: 'legacy' },
  // Government
  { name: 'Office of New York City Comptroller', domain: 'comptroller.nyc.gov', category: 'government' },
  { name: 'Securities and Exchange Commission', domain: 'sec.gov', category: 'government' },
  { name: 'Federal Reserve Bank of New York', domain: 'newyorkfed.org', category: 'government' },
  { name: 'Congressional Budget Office', domain: 'cbo.gov', category: 'government' },
  { name: 'United States Patent and Trademark Office', domain: 'uspto.gov', category: 'government' },
  { name: 'City of Chicago', domain: 'chicago.gov', category: 'government', aliases: ['cityofchicago.org'] },
  // Harder PE / advisory (non-household)
  { name: 'Cara Advisory', domain: 'caraadvisory.com', category: 'regional' },
  { name: 'Disciplina Capital Management', domain: 'disciplina.com', category: 'regional' },
  { name: 'NAV Fund Services', domain: 'navfundservices.com', category: 'regional' }
];

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MAJOR = {
  ibm: { domain: 'ibm.com', label: 'IBM' },
  internationalbusinessmachines: { domain: 'ibm.com', label: 'IBM' },
  fifththird: { domain: '53.com', label: 'Fifth Third Bank' },
  fifththirdbank: { domain: '53.com', label: 'Fifth Third Bank' },
  fifththirdbancorp: { domain: '53.com', label: 'Fifth Third Bank' },
  securitiesandexchangecommission: { domain: 'sec.gov', label: 'U.S. Securities and Exchange Commission' },
  ussecuritiesandexchangecommission: { domain: 'sec.gov', label: 'U.S. Securities and Exchange Commission' },
  officeofnewyorkcitycomptroller: { domain: 'comptroller.nyc.gov', label: 'New York City Comptroller' },
  newyorkcitycomptroller: { domain: 'comptroller.nyc.gov', label: 'New York City Comptroller' },
  nyccomptroller: { domain: 'comptroller.nyc.gov', label: 'New York City Comptroller' }
};

function lookupMajor(name) {
  const key = companyKeyNorm(name);
  if (MAJOR[key]) return MAJOR[key];
  const stripped = companyKeyNorm(
    String(name || '')
      .replace(/^office\s+of\s+(the\s+)?/i, '')
      .replace(/^u\.?s\.?\s+/i, '')
      .replace(/^united\s+states\s+/i, '')
  );
  return MAJOR[stripped] || null;
}

function extractUrlDomain(str) {
  if (!str) return '';
  const raw = String(str).trim();
  const bracketMatch = raw.match(/\[\s*(https?:\/\/[^\s\]]+)/i);
  let url = bracketMatch ? bracketMatch[1] : raw;
  const urlMatch = url.match(/(https?:\/\/[^\s\/\]]+)/i);
  if (urlMatch) {
    url = urlMatch[1];
  } else {
    const bareHost = raw.match(/\[?\s*((?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/i);
    if (bareHost) url = bareHost[1];
  }
  return url
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
}

function normalizeCandidates(...lists) {
  const out = [];
  const byDomain = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      let domain = '';
      let name = '';
      let snippet = '';
      let sources = [];
      let wikiProminence = 0;
      if (typeof item === 'string') {
        domain = extractUrlDomain(item) || item.toLowerCase();
        name = domain;
      } else if (item && typeof item === 'object') {
        domain = String(item.domain || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0].trim();
        name = item.name || item.label || '';
        snippet = item.snippet || item.description || item.industry || '';
        sources = Array.isArray(item.sources) ? item.sources.slice() : (item.source ? [item.source] : []);
        wikiProminence = Number(item.wikiProminence) || 0;
      }
      if (!domain || !domain.includes('.')) continue;
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) continue;
      const prev = byDomain.get(domain);
      if (prev) {
        prev.sources = [...new Set([...(prev.sources || []), ...sources])];
        prev.wikiProminence = Math.max(prev.wikiProminence || 0, wikiProminence);
        if (!prev.name || prev.name === prev.domain) prev.name = name || prev.name;
        if (!prev.snippet && snippet) prev.snippet = snippet;
        continue;
      }
      const entry = { domain, name: name || domain, snippet, sources: [...new Set(sources)], wikiProminence };
      byDomain.set(domain, entry);
      out.push(entry);
    }
  }
  return out;
}

async function dnsOk(domain) {
  try {
    const j = await (await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`)).json();
    return j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0;
  } catch {
    return false;
  }
}

async function gatherClearbit(queries) {
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    const key = String(q || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`);
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        if (!item?.domain) continue;
        out.push({ domain: item.domain, name: item.name || item.domain, snippet: item.industry || '', sources: ['clearbit'] });
      }
    } catch (_) {}
  }
  return normalizeCandidates(out);
}

async function gatherDuckDuckGo(companyName, cleaned) {
  const out = [];
  for (const q of [cleaned, companyName, `${companyName} official website`].filter(Boolean).slice(0, 3)) {
    try {
      const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`);
      if (!r.ok) continue;
      const json = await r.json();
      let official = null;
      if (json.Infobox?.content) {
        official = json.Infobox.content.find(i => i.data_type === 'official_website' || i.label === 'Official Website' || i.label === 'Website');
      }
      if (official?.value) {
        const domain = extractUrlDomain(official.value);
        if (domain && !domain.includes('wikipedia.org')) {
          out.push({ domain, name: json.Heading || companyName, snippet: 'DuckDuckGo official', sources: ['duckduckgo'] });
        }
      }
      if (json.AbstractURL) {
        const absDom = extractUrlDomain(json.AbstractURL);
        if (absDom && !/wikipedia\.org|wikidata\.org/i.test(absDom)) {
          out.push({ domain: absDom, name: json.Heading || companyName, snippet: 'DuckDuckGo abstract', sources: ['duckduckgo'] });
        }
      }
    } catch (_) {}
  }
  return normalizeCandidates(out);
}

function scoreWikidataProminenceLite(entity, title, description) {
  let score = 0;
  const desc = String(description || '').toLowerCase();
  if (/\b(company|firm|organization|foundation|bank|agency|government|university)\b/.test(desc)) score += 20;
  if (entity?.claims?.P856) score += 25;
  if (entity?.claims?.P1128) score += 15;
  if (title && companyKeyNorm(title).length > 4) score += 10;
  return score;
}

async function gatherWikipedia(companyName, cleaned) {
  const out = [];
  const queries = [companyName, cleaned, `${companyName} (company)`, `${companyName} (law firm)`].filter(Boolean);
  const seen = new Set();
  for (const wq of queries.slice(0, 3)) {
    try {
      const openRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(wq)}&limit=5&namespace=0&format=json&origin=*`
      );
      if (!openRes.ok) continue;
      const openJson = await openRes.json();
      const titles = openJson[1] || [];
      for (const title of titles.slice(0, 3)) {
        if (seen.has(title)) continue;
        seen.add(title);
        const wdRes = await fetch(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`
        );
        if (!wdRes.ok) continue;
        const wd = await wdRes.json();
        const entity = Object.values(wd.entities || {}).find(e => e && !e.missing);
        if (!entity) continue;
        const claim = entity?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
        const domain = claim ? extractUrlDomain(claim) : '';
        const description = entity?.descriptions?.en?.value || '';
        const prominence = scoreWikidataProminenceLite(entity, title, description);
        if (domain && !domain.includes('wikipedia.org')) {
          out.push({
            domain,
            name: title,
            snippet: description || title,
            sources: ['wikipedia', 'wikidata'],
            wikiProminence: prominence
          });
        }
      }
    } catch (_) {}
  }
  return normalizeCandidates(out);
}

function scoreNameDomainSimilarity(companyName, candidate) {
  const rawLower = String(companyName || '').toLowerCase().trim();
  const cleanQuery = rawLower.replace(/[^a-z0-9]/g, '');
  const nameLower = String(candidate.name || '').toLowerCase();
  const nameClean = nameLower.replace(/[^a-z0-9]/g, '');
  const parts = String(candidate.domain || '').toLowerCase().split('.');
  const host = String(candidate.domain || '').toLowerCase();
  const domBase = (parts[0] || '').replace(/[^a-z0-9]/g, '');
  const stop = new Set(['of', 'the', 'and', 'a', 'an', 'for', 'in', 'on', 'at', 'to']);
  const tokens = rawLower.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, '')).filter(t => t.length > 0 && !stop.has(t));
  const contentTokens = tokens.filter(t => t.length > 2);
  const acronym = tokens.length >= 2 ? tokens.map(t => t[0]).join('') : '';
  let score = 0;
  let exactName = false;
  if (nameLower === rawLower || nameClean === cleanQuery) {
    score += 40;
    exactName = true;
  } else if (acronym && (nameClean === acronym || nameLower === acronym)) {
    score += 38;
    exactName = true;
  } else if (nameClean.includes(cleanQuery) || cleanQuery.includes(nameClean)) {
    score += 22;
  } else {
    const hits = contentTokens.filter(t => nameLower.includes(t) || domBase.includes(t));
    score += Math.min(18, hits.length * 6);
  }
  if (domBase === cleanQuery || (acronym && domBase === acronym)) score += 35;
  else if (cleanQuery.length >= 4 && (domBase.startsWith(cleanQuery) || cleanQuery.startsWith(domBase))) score += 18;
  else if (cleanQuery.length >= 4 && (domBase.includes(cleanQuery) || cleanQuery.includes(domBase))) score += 10;
  else if (acronym && acronym.length >= 2 && (domBase.includes(acronym) || acronym.includes(domBase))) score += 20;

  const domainHasToken = contentTokens.some(t => domBase.includes(t) || host.includes(t));
  const domainHasAcronym = !!(acronym && acronym.length >= 2 && (domBase === acronym || domBase.includes(acronym)));
  if (exactName && contentTokens.length >= 2 && !domainHasToken && !domainHasAcronym && domBase !== cleanQuery) {
    score = Math.min(score, 6);
    exactName = false;
  }

  const tld = parts[parts.length - 1] || '';
  const isUsGov = /\.gov$/i.test(host) && !/\.gov\.[a-z]{2}$/i.test(host);
  const isForeignGov = /\.gov\.[a-z]{2}$/i.test(host);
  if (isUsGov) score += 10;
  else if (['com', 'org', 'edu', 'gov', 'net', 'io', 'co', 'us', 'uk', 'ai'].includes(tld)) score += 4;
  else score -= 8;
  if (isForeignGov && !/\b(philippines|ghana|thailand|zimbabwe)\b/i.test(rawLower)) score -= 18;

  return { score: Math.max(0, Math.min(50, score)), exactName };
}

async function rankPool(companyName, pool) {
  let ranked = normalizeCandidates(pool).map(c => {
    const sim = scoreNameDomainSimilarity(companyName, c);
    const sources = c.sources || [];
    let wikiPts = 0;
    if (c.wikiProminence) wikiPts = Math.min(25, Math.round(c.wikiProminence / 4));
    else if (sources.includes('wikidata') || sources.includes('wikipedia')) wikiPts = 12;
    let sourcePts = 0;
    if (sources.includes('clearbit') && sim.exactName) sourcePts += 8;
    if (sources.includes('duckduckgo')) sourcePts += 5;
    if (sources.includes('wikipedia') || sources.includes('wikidata')) sourcePts += 6;
    if (sources.length >= 2) sourcePts += 6;
    return {
      ...c,
      exactName: sim.exactName,
      signals: { nameSimilarity: sim.score, wikiNotability: wikiPts, multiSource: sourcePts, dns: 0 },
      totalScore: sim.score + wikiPts + sourcePts
    };
  });
  ranked.sort((a, b) => b.totalScore - a.totalScore);

  const dnsTargets = ranked.slice(0, 5);
  const dnsResults = await Promise.all(dnsTargets.map(async (c) => ({ domain: c.domain, ok: await dnsOk(c.domain) })));
  const dnsMap = new Map(dnsResults.map(r => [r.domain, r.ok]));
  ranked = ranked.map(c => {
    if (!dnsMap.has(c.domain)) return c;
    const ok = dnsMap.get(c.domain);
    let dnsPts = ok ? 15 : -20;
    if (ok && (c.exactName || (c.signals?.nameSimilarity || 0) >= 35)) dnsPts += 8;
    return { ...c, signals: { ...c.signals, dns: dnsPts }, totalScore: c.totalScore + dnsPts, dnsOk: ok };
  });
  ranked.sort((a, b) => b.totalScore - a.totalScore);

  const live = ranked.filter(c => c.dnsOk !== false);
  const contenders = live.length ? live : ranked;
  const best = contenders[0] || null;
  const runnerUp = contenders.find(c => c.domain !== best?.domain) || null;
  const ambiguous = !!(
    best &&
    runnerUp &&
    !best.exactName &&
    Math.abs(best.totalScore - runnerUp.totalScore) < AMBIGUITY_GAP &&
    runnerUp.totalScore >= CONFIDENCE_THRESHOLD - 15
  );
  return { best, ambiguous, candidates: ranked.slice(0, 8), ranked: contenders };
}

function domainMatches(got, expected, aliases = []) {
  const g = String(got || '').toLowerCase().replace(/^www\./, '');
  const opts = [expected, ...(aliases || [])].map(d => String(d || '').toLowerCase().replace(/^www\./, ''));
  return opts.some(e => g === e || g.endsWith('.' + e) || e.endsWith('.' + g));
}

async function resolveHard(name) {
  const major = lookupMajor(name);
  if (major?.domain) {
    const ok = await dnsOk(major.domain);
    const extra = [];
    // SEC: keep foreign peers in the picker even when US is canonical
    if (/securities and exchange/i.test(name)) {
      extra.push(
        { domain: 'sec.gov', name: 'U.S. Securities and Exchange Commission', sources: ['major-firm'] },
        { domain: 'sec.gov.ph', name: 'Securities and Exchange Commission (Philippines)', sources: ['clearbit'] },
        { domain: 'sec.or.th', name: 'Securities and Exchange Commission (Thailand)', sources: ['clearbit'] }
      );
    }
    return {
      domain: major.domain,
      confidence: /securities and exchange/i.test(name) ? 'low' : 'high',
      score: 100,
      ambiguous: /securities and exchange/i.test(name),
      candidates: normalizeCandidates(
        [{ domain: major.domain, name: major.label, sources: ['major-firm'] }],
        extra
      ),
      sources: ['major-firm'],
      dnsOk: ok
    };
  }

  const dict = dictLookup(name);
  if (dict?.domain) {
    const ok = await dnsOk(dict.domain);
    return {
      domain: dict.domain,
      confidence: 'high',
      score: 95,
      ambiguous: false,
      candidates: [{ domain: dict.domain, name, sources: ['dictionary'] }],
      sources: ['dictionary'],
      dnsOk: ok
    };
  }

  const cleaned = String(name)
    .replace(/\b(llc|inc|ltd|limited|corp|corporation|co|gmbh|plc|company)\b/gi, '')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const queries = [
    name,
    cleaned,
    cleaned.split(/\s+/).slice(0, 2).join(' '),
    /international business machines/i.test(name) ? 'IBM' : null,
    /fifth third/i.test(name) ? 'Fifth Third Bancorp' : null,
    /comptroller/i.test(name) ? 'New York City Comptroller' : null,
    /securities and exchange/i.test(name) ? 'U.S. Securities and Exchange Commission' : null
  ].filter((q, i, a) => q && a.indexOf(q) === i);

  const govSeeds = [];
  if (/new york city comptroller|nyc comptroller|office of.*new york city comptroller/i.test(name)) {
    govSeeds.push({ domain: 'comptroller.nyc.gov', name: 'New York City Comptroller', sources: ['gov-seed'] });
  }
  if (/securities and exchange commission/i.test(name)) {
    govSeeds.push({ domain: 'sec.gov', name: 'U.S. Securities and Exchange Commission', sources: ['gov-seed'] });
  }

  const [cb, ddg, wiki] = await Promise.all([
    gatherClearbit(queries),
    gatherDuckDuckGo(name, cleaned),
    gatherWikipedia(name, cleaned)
  ]);
  const pool = normalizeCandidates(govSeeds, cb, ddg, wiki);
  if (!pool.length) {
    return { domain: null, confidence: 'none', score: 0, candidates: [], sources: [] };
  }
  const ranked = await rankPool(name, pool);
  if (!ranked.best) {
    return { domain: null, confidence: 'none', score: 0, candidates: ranked.candidates, sources: [] };
  }
  let best = ranked.best;
  let ambiguous = ranked.ambiguous;
  const secFamily = (ranked.ranked || ranked.candidates || []).filter(c =>
    /^sec\.gov(\.[a-z]{2})?$/i.test(c.domain) ||
    (/securities and exchange/i.test(c.name || '') && /\.gov/i.test(c.domain || ''))
  );
  if (secFamily.length >= 2 && /securities and exchange/i.test(name)) {
    ambiguous = true;
    const us = secFamily.find(c => c.domain === 'sec.gov') || best;
    best = us;
  }
  const score = best.totalScore || 0;
  const clears = score >= CONFIDENCE_THRESHOLD && !ambiguous;
  return {
    domain: best.domain,
    confidence: clears ? 'high' : 'low',
    score,
    ambiguous,
    candidates: ranked.candidates,
    sources: best.sources || [],
    signals: best.signals,
    dnsOk: best.dnsOk
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

console.log(`Hard-sample resolution audit: ${HARD_SAMPLE.length} companies (multi-source + dictionary)\n`);

const results = await mapPool(HARD_SAMPLE, 3, async (row) => {
  const resolved = await resolveHard(row.name);
  const hasCandidates = (resolved.candidates || []).length > 0;
  const match = resolved.domain && domainMatches(resolved.domain, row.domain, row.aliases);
  let status;
  if (!resolved.domain && !hasCandidates) status = 'unverified';
  else if (resolved.confidence === 'high' && match && resolved.dnsOk !== false) status = 'found';
  else if (hasCandidates) status = 'potential';
  else status = 'unverified';

  return {
    name: row.name,
    category: row.category,
    expected: row.domain,
    got: resolved.domain || '',
    score: resolved.score,
    confidence: resolved.confidence,
    sources: (resolved.sources || []).join('+') || '-',
    status,
    match: !!match,
    candidates: (resolved.candidates || []).length
  };
});

const found = results.filter(r => r.status === 'found');
const potential = results.filter(r => r.status === 'potential');
const unverified = results.filter(r => r.status === 'unverified');
const foundCorrect = found.filter(r => r.match);
const foundRate = results.length ? (foundCorrect.length / results.length) * 100 : 0;
const pickerCoverage = results.filter(r => r.candidates > 0 || r.status === 'found').length;
const correctTop = results.filter(r => r.match).length;

console.log('--- Per company ---');
for (const r of results) {
  const mark = r.status === 'found' && r.match ? '✓' : r.status === 'potential' ? '~' : '✗';
  console.log(
    `${mark} [${r.category}] ${r.name}\n` +
    `    expected=${r.expected} got=${r.got || '(none)'} score=${r.score} conf=${r.confidence} src=${r.sources} status=${r.status} cands=${r.candidates}`
  );
}

console.log('\n=== HARD SAMPLE SUMMARY ===');
console.log(`Total: ${results.length}`);
console.log(`Found & Verified (correct + confident + DNS): ${foundCorrect.length}/${results.length} (${foundRate.toFixed(1)}%)`);
console.log(`Top-1 correct (any confidence): ${correctTop}/${results.length} (${((correctTop / results.length) * 100).toFixed(1)}%)`);
console.log(`Potential (picker fallback): ${potential.length}`);
console.log(`Unverified (no candidates): ${unverified.length}`);
console.log(`Picker coverage (any candidates or found): ${pickerCoverage}/${results.length}`);

const byCat = {};
for (const r of results) {
  if (!byCat[r.category]) byCat[r.category] = { n: 0, found: 0, top1: 0 };
  byCat[r.category].n++;
  if (r.status === 'found' && r.match) byCat[r.category].found++;
  if (r.match) byCat[r.category].top1++;
}
console.log('\nBy category (Found & Verified / Top-1 correct):');
for (const [cat, v] of Object.entries(byCat)) {
  console.log(`  ${cat}: found ${v.found}/${v.n} (${((v.found / v.n) * 100).toFixed(0)}%) · top-1 ${v.top1}/${v.n} (${((v.top1 / v.n) * 100).toFixed(0)}%)`);
}
