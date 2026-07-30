/**
 * Evidence dump: raw Clearbit / DDG / Wikipedia pools + scored confidence
 * for 5 well-known companies that should easily auto-resolve.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENCE_THRESHOLD = 70;

const COMPANIES = [
  'PIMCO',
  'Blackstone',
  'Stripe',
  'Microsoft',
  'Goldman Sachs'
];

function extractUrlDomain(str) {
  if (!str) return '';
  const raw = String(str).trim();
  const bracketMatch = raw.match(/\[\s*(https?:\/\/[^\s\]]+)/i);
  let url = bracketMatch ? bracketMatch[1] : raw;
  const urlMatch = url.match(/(https?:\/\/[^\s\/\]]+)/i);
  if (urlMatch) url = urlMatch[1];
  else {
    const bareHost = raw.match(/\[?\s*((?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/i);
    if (bareHost) url = bareHost[1];
  }
  return url.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/^\[/, '').replace(/\]$/, '')
    .split('/')[0].split('?')[0].trim();
}

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchRaw(url, label) {
  const started = Date.now();
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      label,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      ms: Date.now() - started,
      headers: {
        'retry-after': res.headers.get('retry-after'),
        'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining'),
        'x-ratelimit-limit': res.headers.get('x-ratelimit-limit')
      },
      bodyPreview: text.slice(0, 500),
      json,
      error: null
    };
  } catch (e) {
    return {
      label,
      ok: false,
      status: 0,
      statusText: 'FETCH_ERROR',
      ms: Date.now() - started,
      headers: {},
      bodyPreview: '',
      json: null,
      error: e.message || String(e)
    };
  }
}

async function clearbitRaw(q) {
  const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`;
  const raw = await fetchRaw(url, `clearbit:${q}`);
  const items = Array.isArray(raw.json) ? raw.json : [];
  return {
    ...raw,
    candidates: items.map(i => ({
      domain: i.domain,
      name: i.name,
      industry: i.industry || '',
      source: 'clearbit'
    }))
  };
}

async function ddgRaw(q) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`;
  const raw = await fetchRaw(url, `ddg:${q}`);
  const json = raw.json || {};
  const candidates = [];
  let official = null;
  if (json.Infobox?.content) {
    official = json.Infobox.content.find(i =>
      i.data_type === 'official_website' || i.label === 'Official Website' || i.label === 'Website'
    );
  }
  if (official?.value) {
    const domain = extractUrlDomain(official.value);
    if (domain && !domain.includes('wikipedia.org')) {
      candidates.push({ domain, name: json.Heading || q, source: 'duckduckgo', via: 'infobox' });
    }
  }
  if (json.AbstractURL) {
    const abs = String(json.AbstractURL);
    const wiki = abs.match(/wikipedia\.org\/wiki\/([^?#]+)/i);
    if (wiki) {
      candidates.push({
        domain: null,
        name: decodeURIComponent(wiki[1].replace(/_/g, ' ')),
        source: 'duckduckgo',
        via: 'wikipedia-abstract',
        wikiTitle: decodeURIComponent(wiki[1].replace(/_/g, ' '))
      });
    }
    const absDom = extractUrlDomain(abs);
    if (absDom && !/wikipedia|wikidata/i.test(absDom)) {
      candidates.push({ domain: absDom, name: json.Heading || q, source: 'duckduckgo', via: 'abstract-url' });
    }
  }
  return {
    ...raw,
    heading: json.Heading || null,
    abstractURL: json.AbstractURL || null,
    hasInfobox: !!json.Infobox,
    candidates
  };
}

async function wikiRaw(q) {
  const openUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=5&namespace=0&format=json&origin=*`;
  const open = await fetchRaw(openUrl, `wiki-opensearch:${q}`);
  const titles = Array.isArray(open.json) ? (open.json[1] || []) : [];
  const entities = [];
  for (const title of titles.slice(0, 3)) {
    const wdUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`;
    const wd = await fetchRaw(wdUrl, `wikidata:${title}`);
    const entity = Object.values(wd.json?.entities || {}).find(e => e && !e.missing);
    const claim = entity?.claims?.P856?.[0]?.mainsnak?.datavalue?.value || null;
    const domain = claim ? extractUrlDomain(claim) : null;
    entities.push({
      title,
      ok: wd.ok,
      status: wd.status,
      description: entity?.descriptions?.en?.value || '',
      P856: claim,
      domain,
      bodyPreview: wd.bodyPreview?.slice(0, 200)
    });
  }
  return {
    openSearch: {
      ok: open.ok,
      status: open.status,
      ms: open.ms,
      error: open.error,
      titles,
      bodyPreview: open.bodyPreview
    },
    entities,
    candidates: entities.filter(e => e.domain).map(e => ({
      domain: e.domain,
      name: e.title,
      source: 'wikipedia+wikidata',
      description: e.description
    }))
  };
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
    score += 40; exactName = true;
  } else if (acronym && (nameClean === acronym || nameLower === acronym)) {
    score += 38; exactName = true;
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
  if (isUsGov) score += 10;
  else if (['com', 'org', 'edu', 'gov', 'net', 'io', 'co', 'us', 'uk', 'ai'].includes(tld)) score += 4;
  else score -= 8;
  return { score: Math.max(0, Math.min(50, score)), exactName };
}

async function dnsOk(domain) {
  try {
    const j = await (await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`)).json();
    return j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0;
  } catch { return false; }
}

async function scorePool(companyName, pool) {
  let ranked = pool.filter(c => c.domain).map(c => {
    const sim = scoreNameDomainSimilarity(companyName, c);
    const sources = c.sources || (c.source ? [c.source] : []);
    let wikiPts = sources.includes('wikipedia') || sources.includes('wikidata') || String(c.source || '').includes('wikipedia') ? 12 : 0;
    let sourcePts = 0;
    if (sources.includes('clearbit') && sim.exactName) sourcePts += 8;
    if (sources.some(s => String(s).includes('duckduckgo'))) sourcePts += 5;
    if (sources.some(s => /wiki/i.test(s)) || String(c.source || '').includes('wikipedia')) sourcePts += 6;
    if (new Set(sources.map(String)).size >= 2 || (c.source && pool.filter(p => p.domain === c.domain).length > 1)) sourcePts += 6;
    return {
      domain: c.domain,
      name: c.name,
      sources,
      exactName: sim.exactName,
      signals: { nameSimilarity: sim.score, wikiNotability: wikiPts, multiSource: sourcePts, dns: 0 },
      totalScore: sim.score + wikiPts + sourcePts
    };
  });
  // merge duplicate domains
  const byDom = new Map();
  for (const r of ranked) {
    const prev = byDom.get(r.domain);
    if (!prev) { byDom.set(r.domain, r); continue; }
    prev.sources = [...new Set([...prev.sources, ...r.sources])];
    prev.signals.wikiNotability = Math.max(prev.signals.wikiNotability, r.signals.wikiNotability);
    prev.signals.multiSource = Math.max(prev.signals.multiSource, r.signals.multiSource);
    prev.signals.nameSimilarity = Math.max(prev.signals.nameSimilarity, r.signals.nameSimilarity);
    prev.totalScore = prev.signals.nameSimilarity + prev.signals.wikiNotability + prev.signals.multiSource;
    prev.exactName = prev.exactName || r.exactName;
  }
  ranked = [...byDom.values()].sort((a, b) => b.totalScore - a.totalScore);
  const top = ranked.slice(0, 5);
  for (const c of top) {
    const ok = await dnsOk(c.domain);
    let dnsPts = ok ? 15 : -20;
    if (ok && (c.exactName || c.signals.nameSimilarity >= 35)) dnsPts += 8;
    c.signals.dns = dnsPts;
    c.dnsOk = ok;
    c.totalScore += dnsPts;
  }
  ranked.sort((a, b) => b.totalScore - a.totalScore);
  return ranked;
}

const MAJOR = {
  pimco: 'pimco.com',
  blackstone: 'blackstone.com',
  blackstonegroup: 'blackstone.com',
  stripe: 'stripe.com',
  microsoft: 'microsoft.com',
  goldmansachs: 'goldmansachs.com'
};

const report = [];

for (const name of COMPANIES) {
  console.log('\n' + '='.repeat(72));
  console.log(`COMPANY: ${name}`);
  console.log('='.repeat(72));

  const major = MAJOR[companyKeyNorm(name)];
  console.log(`major-firm fast-path key: ${companyKeyNorm(name)} → ${major || '(none)'}`);

  console.log('\n--- CLEARBIT ---');
  const cb = await clearbitRaw(name);
  console.log(`HTTP ${cb.status} ${cb.statusText} (${cb.ms}ms) ok=${cb.ok} error=${cb.error || 'none'}`);
  console.log(`rate-limit headers: ${JSON.stringify(cb.headers)}`);
  if (!cb.ok || cb.status === 429 || !cb.candidates.length) {
    console.log(`RAW BODY PREVIEW:\n${cb.bodyPreview || '(empty)'}`);
  }
  console.log(`candidates (${cb.candidates.length}):`);
  for (const c of cb.candidates.slice(0, 8)) {
    console.log(`  - ${c.domain} | name="${c.name}" | industry="${c.industry}"`);
  }

  console.log('\n--- DUCKDUCKGO ---');
  const ddg = await ddgRaw(name);
  console.log(`HTTP ${ddg.status} ${ddg.statusText} (${ddg.ms}ms) ok=${ddg.ok} error=${ddg.error || 'none'}`);
  console.log(`Heading=${ddg.heading || '-'} AbstractURL=${ddg.abstractURL || '-'} Infobox=${ddg.hasInfobox}`);
  if (!ddg.ok || ddg.status === 429 || (!ddg.candidates.length && !ddg.heading)) {
    console.log(`RAW BODY PREVIEW:\n${ddg.bodyPreview || '(empty)'}`);
  }
  console.log(`candidates (${ddg.candidates.length}):`);
  for (const c of ddg.candidates) {
    console.log(`  - ${c.domain || '(wiki-title-only)'} | name="${c.name}" | via=${c.via}`);
  }

  console.log('\n--- WIKIPEDIA / WIKIDATA ---');
  const wiki = await wikiRaw(name);
  console.log(`opensearch HTTP ${wiki.openSearch.status} ok=${wiki.openSearch.ok} (${wiki.openSearch.ms}ms) error=${wiki.openSearch.error || 'none'}`);
  console.log(`titles: ${JSON.stringify(wiki.openSearch.titles)}`);
  if (!wiki.openSearch.ok || wiki.openSearch.status === 429 || !wiki.openSearch.titles.length) {
    console.log(`RAW OPENSEARCH PREVIEW:\n${wiki.openSearch.bodyPreview || '(empty)'}`);
  }
  for (const e of wiki.entities) {
    console.log(`  entity "${e.title}" HTTP ${e.status} P856=${e.P856 || '(none)'} domain=${e.domain || '-'} desc=${(e.description || '').slice(0, 60)}`);
  }
  console.log(`candidates with official site (${wiki.candidates.length}):`);
  for (const c of wiki.candidates) {
    console.log(`  - ${c.domain} | name="${c.name}"`);
  }

  // Merge like live app (without major-firm short-circuit for score visibility)
  const pool = [];
  for (const c of cb.candidates) pool.push({ ...c, sources: ['clearbit'] });
  for (const c of ddg.candidates) if (c.domain) pool.push({ ...c, sources: ['duckduckgo'] });
  for (const c of wiki.candidates) pool.push({ ...c, sources: ['wikipedia', 'wikidata'] });

  const ranked = await scorePool(name, pool);
  console.log('\n--- SCORED RANKING (multi-source, no major-firm short-circuit) ---');
  for (const r of ranked.slice(0, 5)) {
    console.log(
      `  score=${r.totalScore} domain=${r.domain} exact=${r.exactName} dnsOk=${r.dnsOk}` +
      ` signals=${JSON.stringify(r.signals)} sources=${(r.sources || []).join('+')}`
    );
  }
  const best = ranked[0];
  const clears = best && best.totalScore >= CONFIDENCE_THRESHOLD;
  console.log(`\nFINAL: best=${best?.domain || '(none)'} score=${best?.totalScore ?? 'n/a'} threshold=${CONFIDENCE_THRESHOLD} clearsThreshold=${!!clears}`);
  console.log(`NOTE: live UI still forces Potential until user Confirm even when clearsThreshold=true`);

  report.push({
    name,
    majorFirmDomain: major || null,
    clearbit: { status: cb.status, ok: cb.ok, count: cb.candidates.length, top: cb.candidates[0]?.domain || null },
    ddg: { status: ddg.status, ok: ddg.ok, count: ddg.candidates.filter(c => c.domain).length, heading: ddg.heading },
    wiki: { status: wiki.openSearch.status, ok: wiki.openSearch.ok, titles: wiki.openSearch.titles.length, withP856: wiki.candidates.length },
    bestDomain: best?.domain || null,
    bestScore: best?.totalScore ?? null,
    clearsThreshold: !!clears,
    topSignals: best?.signals || null
  });
}

console.log('\n\n' + '='.repeat(72));
console.log('SUMMARY TABLE');
console.log('='.repeat(72));
console.log('company | cb_http/n | ddg_http/n | wiki_http/titles/p856 | best | score | >=70');
for (const r of report) {
  console.log(
    `${r.name} | ${r.clearbit.status}/${r.clearbit.count} | ${r.ddg.status}/${r.ddg.count} | ` +
    `${r.wiki.status}/${r.wiki.titles}/${r.wiki.withP856} | ${r.bestDomain} | ${r.bestScore} | ${r.clearsThreshold}`
  );
}

const outPath = path.join(__dirname, 'last-batch-resolve-evidence.json');
fs.writeFileSync(outPath, JSON.stringify({ threshold: CONFIDENCE_THRESHOLD, generatedAt: new Date().toISOString(), report }, null, 2));
console.log(`\nWrote ${outPath}`);
