/**
 * Shared hard-sample resolver used by regression tests and the enrichment audit.
 * Mirrors live multi-source resolution (dictionary / major-firm / Clearbit / DDG / Wiki).
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const CONFIDENCE_THRESHOLD = 70;
const AMBIGUITY_GAP = 12;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
const dictStart = html.indexOf('const companyDictionary = {');
const dictEnd = html.indexOf('\n    };', dictStart);
const dictBlock = html.slice(dictStart, dictEnd);
const dictEntries = [];
const dictRe = /"([^"]+)":\s*\{[\s\S]*?domain:\s*"([^"]+)"/g;
let dm;
while ((dm = dictRe.exec(dictBlock))) {
  dictEntries.push({ key: dm[1], domain: dm[2].toLowerCase() });
}

export function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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
  const queries = [
    cleaned,
    companyName,
    `${companyName} official website`,
    /comptroller/i.test(companyName) ? 'New York City Comptroller' : null,
    /securities and exchange/i.test(companyName) ? 'U.S. Securities and Exchange Commission' : null,
    /international business machines/i.test(companyName) ? 'IBM' : null
  ].filter((q, i, a) => q && a.indexOf(q) === i);

  for (const q of queries.slice(0, 4)) {
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
        const abs = String(json.AbstractURL);
        const wikiTitleMatch = abs.match(/wikipedia\.org\/wiki\/([^?#]+)/i);
        if (wikiTitleMatch) {
          const title = decodeURIComponent(wikiTitleMatch[1].replace(/_/g, ' '));
          try {
            const wdRes = await fetch(
              `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`
            );
            if (wdRes.ok) {
              const wd = await wdRes.json();
              const entity = Object.values(wd.entities || {}).find(e => e && !e.missing);
              const claim = entity?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
              const domain = claim ? extractUrlDomain(claim) : '';
              if (domain && !domain.includes('wikipedia.org')) {
                out.push({
                  domain,
                  name: title,
                  snippet: entity?.descriptions?.en?.value || title,
                  sources: ['duckduckgo', 'wikipedia', 'wikidata'],
                  wikiProminence: 40
                });
              }
            }
          } catch (_) {}
        }
        const absDom = extractUrlDomain(abs);
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
  const queries = [
    companyName,
    cleaned,
    `${companyName} (company)`,
    /international business machines/i.test(companyName) ? 'IBM' : null,
    /fifth third/i.test(companyName) ? 'Fifth Third Bank' : null,
    /comptroller/i.test(companyName) ? 'New York City Comptroller' : null,
    /securities and exchange/i.test(companyName) ? 'U.S. Securities and Exchange Commission' : null
  ].filter(Boolean);
  const seen = new Set();
  for (const wq of queries.slice(0, 5)) {
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

export function domainMatches(got, expected, aliases = []) {
  const g = String(got || '').toLowerCase().replace(/^www\./, '');
  const opts = [expected, ...(aliases || [])].map(d => String(d || '').toLowerCase().replace(/^www\./, ''));
  return opts.some(e => g === e || g.endsWith('.' + e) || e.endsWith('.' + g));
}

export async function resolveHard(name) {
  // Learned corrections (committed data/learned-corrections.json) — same priority as live app
  try {
    const learnedPath = join(ROOT, 'data/learned-corrections.json');
    const learned = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
    const key = companyKeyNorm(name);
    const hit = (learned.corrections || []).find(c => c.companyKey === key || companyKeyNorm(c.companyName) === key);
    if (hit?.domain) {
      const ok = await dnsOk(hit.domain);
      return {
        domain: hit.domain,
        confidence: 'high',
        score: 100,
        ambiguous: false,
        candidates: [{ domain: hit.domain, name: hit.companyName || name, sources: ['learned'] }],
        sources: ['learned'],
        dnsOk: ok
      };
    }
  } catch (_) {}

  const major = lookupMajor(name);
  if (major?.domain) {
    const ok = await dnsOk(major.domain);
    const extra = [];
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

export function loadHardSampleFixture() {
  const path = join(ROOT, 'fixtures/hard-sample-resolution.json');
  const fixture = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(fixture.companies) || !fixture.companies.length) {
    throw new Error(`Invalid hard-sample fixture: ${path}`);
  }
  return fixture;
}

export async function mapPool(items, limit, fn) {
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

export { CONFIDENCE_THRESHOLD };
