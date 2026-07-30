/**
 * Shared hard-sample resolver used by regression tests and the enrichment audit.
 * Mirrors live multi-source resolution (dictionary / major-firm / Clearbit / DDG / Wiki).
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const CONFIDENCE_THRESHOLD = 70;
// 80: wiki-less Clearbit+DNS correct matches commonly land ~81; 90 was too strict under Wiki 429s.
const AUTO_FOUND_THRESHOLD = 80;
const AMBIGUITY_GAP = 12;

const FINANCE_AFFINITY_PHRASES = [
  'investment management', 'venture capital', 'private equity', 'asset management',
  'financial advisory', 'financial advisor', 'wealth management', 'hedge fund',
  'capital markets', 'family office', 'broker dealer', 'broker-dealer',
  'investment bank', 'investment banking', 'fund services', 'fund administration',
  'alternative asset', 'growth equity', 'private credit', 'credit fund',
  'sovereign wealth', 'merchant bank', 'private bank', 'buyout', 'fintech',
  'financial technology', 'financial services', 'payments', 'payment processing',
  'payment platform', 'neobank', 'robo-advisor', 'robo advisor'
];
const FINANCE_AFFINITY_TOKENS = [
  'capital', 'ventures', 'venture', 'investment', 'investments', 'investor', 'investors',
  'equity', 'hedge', 'wealth', 'fintech', 'securities', 'banking', 'bank',
  'asset', 'assets', 'advisory', 'advisor', 'advisors', 'fund', 'funds',
  'holdings', 'credit', 'lending', 'brokerage', 'broker', 'pe', 'vc',
  'payments', 'payment', 'financing'
];
const FINANCE_KNOWN_BRANDS = new Set([
  'stripe', 'square', 'block', 'plaid', 'paypal', 'visa', 'mastercard', 'adyen', 'checkout',
  'klarna', 'affirm', 'brex', 'ramp', 'mercury', 'coinbase', 'robinhood', 'sofi',
  'pimco', 'blackrock', 'blackstone', 'kkr', 'apollo', 'carlyle', 'bridgewater', 'citadel',
  'fidelity', 'vanguard', 'schroders', 'goldman', 'goldmansachs', 'morganstanley', 'jpmorgan',
  'heardcapital', 'caraadvisory', 'navfundservices', 'disciplina', 'stableam', 'gilderpartners',
  'plumalley', 'marex'
]);
const FINANCE_KNOWN_DOMAINS = new Set([
  'stripe.com', 'square.com', 'plaid.com', 'paypal.com', 'adyen.com', 'checkout.com',
  'pimco.com', 'blackrock.com', 'blackstone.com', 'heardcapital.com', 'caraadvisory.com',
  'navfundservices.com', 'disciplina.com', 'stableam.com', 'gilderpartners.com',
  'plumalley.co', 'marex.com', 'bridgewater.com', 'citadel.com'
]);
const UNRELATED_INDUSTRY_PHRASES = [
  'retail', 'grocery', 'supermarket', 'restaurant', 'restaurants', 'cafe', 'coffee shop',
  'entertainment', 'media', 'publishing', 'newspaper', 'magazine', 'music',
  'gaming', 'video game', 'cinema', 'film studio', 'movie', 'television',
  'fashion', 'apparel', 'clothing', 'cosmetics', 'beauty',
  'food & beverage', 'food and beverage', 'hotel', 'hospitality', 'travel agency',
  'sports', 'nightlife', 'casino', 'e-commerce', 'ecommerce', 'marketplace',
  'consumer goods', 'consumer electronics', 'cpg', 'toys', 'grocery store',
  'fast food', 'streaming entertainment',
  'biotech', 'biotechnology', 'therapeutics', 'pharmaceutical', 'medical device',
  'robotics', 'aerospace', 'semiconductor'
];

export function classifyFinanceAffinity(candidate, queryCompanyName = '') {
  const domain = String(candidate?.domain || '').toLowerCase().replace(/^www\./, '');
  const name = String(candidate?.name || '');
  const blob = `${name} ${domain} ${candidate?.snippet || ''} ${candidate?.industry || ''}`.toLowerCase();
  if (!blob.trim()) return 'neutral';

  if (FINANCE_KNOWN_DOMAINS.has(domain)) return 'finance';
  const nameKey = companyKeyNorm(name);
  const domBase = domain.split('.')[0] || '';
  if (FINANCE_KNOWN_BRANDS.has(nameKey) || FINANCE_KNOWN_BRANDS.has(domBase)) return 'finance';
  const qKey = companyKeyNorm(queryCompanyName);
  if (qKey && FINANCE_KNOWN_BRANDS.has(qKey)) {
    if (nameKey === qKey || domBase === qKey || domain.startsWith(qKey + '.')) return 'finance';
  }

  if (UNRELATED_INDUSTRY_PHRASES.some(p => blob.includes(p)) && !FINANCE_AFFINITY_PHRASES.some(p => blob.includes(p))) {
    const host = domain.replace(/\./g, ' ');
    if (!/\b(capital|ventures|venture|invest|advisory|advisor|wealth|asset|fund|equity|fintech|bank|hedge|payment)\b/.test(host)) {
      return 'unrelated';
    }
  }
  if (FINANCE_AFFINITY_PHRASES.some(p => blob.includes(p))) return 'finance';
  const hostTokens = domain.replace(/\./g, ' ');
  if (/\b(capital|ventures|venture|invest|advisory|advisor|wealth|assetmgmt|asset|fund|equity|fintech|bank|hedge|payment)\b/.test(hostTokens)) {
    return 'finance';
  }
  if (FINANCE_AFFINITY_TOKENS.some(t => new RegExp(`\\b${t}\\b`, 'i').test(blob))) return 'finance';
  return 'neutral';
}

export function isFinanceTypedCandidate(c, queryCompanyName = '') {
  return classifyFinanceAffinity(c, queryCompanyName) === 'finance';
}

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
  nyccomptroller: { domain: 'comptroller.nyc.gov', label: 'New York City Comptroller' },
  // Short ambiguous name: Clearbit "Stable" → usestable.com; canonical is Stable Asset Management
  stable: { domain: 'stableam.com', label: 'Stable Asset Management' },
  stableam: { domain: 'stableam.com', label: 'Stable Asset Management' },
  stableassetmanagement: { domain: 'stableam.com', label: 'Stable Asset Management' }
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

async function fetchWikiApiJson(url, label = 'wiki') {
  try {
    let res = await fetch(url);
    if (res.status === 429) {
      const waitMs = 900 + Math.floor(Math.random() * 500);
      console.warn(`[wiki] 429 on ${label}, backoff ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(url);
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function shouldAutoFound(resolved) {
  if (!resolved?.domain || resolved.ambiguous) return false;
  const score = Number(resolved.score ?? resolved.confidenceScore) || 0;
  const method = String((resolved.sources || [])[0] || resolved.resolveMethod || '');
  const sources = resolved.sources || [];
  if (
    (sources.includes('major-firm') || sources.includes('dictionary') || sources.includes('learned') ||
      method === 'major-firm' || method === 'dictionary' || method === 'learned') &&
    score >= 90
  ) {
    return true;
  }
  if (
    resolved.financeFilterActive &&
    resolved.soleFinanceMatch &&
    score >= CONFIDENCE_THRESHOLD &&
    resolved.confidence === 'high'
  ) {
    return true;
  }
  if (score < AUTO_FOUND_THRESHOLD || resolved.confidence !== 'high') return false;
  if (score >= 90) return true;
  const nameSim = Number(resolved.signals?.nameSimilarity ?? resolved.confidenceSignals?.nameSimilarity) || 0;
  const financePts = Number(resolved.signals?.finance ?? resolved.confidenceSignals?.finance) || 0;
  const multiPts = Number(resolved.signals?.multiSource ?? resolved.confidenceSignals?.multiSource) || 0;
  const host = String(resolved.domain || '').toLowerCase().replace(/^www\./, '');
  const tldMatch = host.match(/\.(co\.uk|com\.au|co\.nz|com\.br|co\.za|org\.uk)$/i);
  const tld = tldMatch ? tldMatch[1] : (host.split('.').pop() || '');
  const commonTld = [
    'com', 'org', 'edu', 'gov', 'net', 'io', 'co', 'ai', 'us', 'uk', 'health', 'tech', 'bio',
    'com.au', 'co.uk', 'org.uk', 'co.nz', 'com.br', 'co.za'
  ].includes(tld);
  const nameKey = companyKeyNorm(resolved.matchedName || resolved.domain || '');
  const base = (host.split('.')[0] || '').replace(/[^a-z0-9]/g, '');
  const nameLock = !!(
    resolved.exactName ||
    (base && nameKey && (base === nameKey || nameKey.includes(base) || base.includes(nameKey.slice(0, 12))))
  );
  const financeTldOk = ['capital', 'fund', 'finance', 'ventures', 'investments'].includes(tld)
    && financePts > 0
    && nameLock;
  if (!commonTld && !financeTldOk) return false;
  return !!(
    resolved.exactName ||
    nameSim >= 40 ||
    financePts > 0 ||
    resolved.soleFinanceMatch ||
    multiPts >= 11 ||
    !!(resolved.signals?.soleDominant ?? resolved.confidenceSignals?.soleDominant)
  );
}

async function gatherOfficialWebsiteFallback(companyName) {
  const out = [];
  const q = `${String(companyName || '').trim()} official website`;
  if (q.length < 8) return [];

  try {
    const short = String(companyName || '')
      .replace(/\b(llc|llp|inc|ltd|limited|corp|corporation|group|partners|management|foundation|system|university|investment|wealth|markets|solutions|hedge|fund|capital|office|growth)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = short.split(/\s+/).filter(Boolean);
    const cb = await gatherClearbit([
      q,
      short,
      tokens.slice(0, 2).join(' '),
      tokens[0],
      companyName
    ].filter((x, i, a) => x && a.indexOf(x) === i));
    for (const c of cb) {
      out.push({ ...c, sources: [...new Set([...(c.sources || []), 'fallback-clearbit'])], snippet: c.snippet || 'Fallback Clearbit' });
    }
  } catch (_) {}

  const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const proxies = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`
  ];
  const spam = /wikipedia\.org|wikidata\.org|duckduckgo\.com|google\.com|bing\.com|yahoo\.com|facebook\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|instagram\.com|crunchbase\.com|bloomberg\.com|reuters\.com|pitchbook\.com|zoominfo\.com|apollo\.io|rocketreach/i;

  for (const build of proxies) {
    try {
      const res = await fetch(build(ddgHtmlUrl), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const html = await res.text();
      if (!html || html.length < 80) continue;
      const domains = [];
      const uddgRe = /uddg=([^&"']+)/gi;
      let m;
      while ((m = uddgRe.exec(html)) && domains.length < 10) {
        try {
          const decoded = decodeURIComponent(m[1]);
          const dom = extractUrlDomain(decoded);
          if (dom && dom.includes('.') && !spam.test(dom)) domains.push(dom);
        } catch (_) {}
      }
      const hrefRe = /href="(https?:\/\/[^"]+)"/gi;
      while ((m = hrefRe.exec(html)) && domains.length < 12) {
        const url = m[1];
        if (/duckduckgo\.com|spreadingprivacy/i.test(url)) continue;
        const dom = extractUrlDomain(url);
        if (dom && dom.includes('.') && !spam.test(dom)) domains.push(dom);
      }
      const seen = new Set();
      for (const domain of domains) {
        const d = domain.toLowerCase().replace(/^www\./, '');
        if (seen.has(d)) continue;
        seen.add(d);
        out.push({
          domain: d,
          name: companyName,
          snippet: 'Web search · official website',
          sources: ['web-fallback']
        });
        if (seen.size >= 6) break;
      }
      if (seen.size) break;
    } catch (_) {}
  }
  return normalizeCandidates(out);
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
          const wd = await fetchWikiApiJson(
            `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`,
            `ddg→wd:${title}`
          );
          await new Promise((r) => setTimeout(r, 120));
          if (wd) {
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
      const openJson = await fetchWikiApiJson(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(wq)}&limit=5&namespace=0&format=json&origin=*`,
        `opensearch:${wq}`
      );
      if (!openJson) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const titles = openJson[1] || [];
      for (const title of titles.slice(0, 3)) {
        if (seen.has(title)) continue;
        seen.add(title);
        const wd = await fetchWikiApiJson(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`,
          `wb:${title}`
        );
        await new Promise((r) => setTimeout(r, 120));
        if (!wd) continue;
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

async function rankPool(companyName, pool, options = {}) {
  const financeFilterActive = !!options.financeFilterActive;
  const anyFinanceInPool = normalizeCandidates(pool).some(c => isFinanceTypedCandidate(c, companyName));

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
    if (sources.includes('dictionary') || sources.includes('major-firm') || sources.includes('dict-seed')) sourcePts += 40;
    if (sources.length >= 2) sourcePts += 6;

    let financePts = 0;
    const financeAffinity = classifyFinanceAffinity(c, companyName);
    if (financeFilterActive) {
      if (financeAffinity === 'finance') financePts = 34;
      else if (financeAffinity === 'unrelated' && anyFinanceInPool) financePts = -30;
    }

    return {
      ...c,
      exactName: sim.exactName,
      financeAffinity,
      signals: { nameSimilarity: sim.score, wikiNotability: wikiPts, multiSource: sourcePts, dns: 0, finance: financePts },
      totalScore: sim.score + wikiPts + sourcePts + financePts
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
  let best = contenders[0] || null;
  const runnerUp = contenders.find(c => c.domain !== best?.domain) || null;
  let ambiguous = !!(
    best &&
    runnerUp &&
    !best.exactName &&
    Math.abs(best.totalScore - runnerUp.totalScore) < AMBIGUITY_GAP &&
    runnerUp.totalScore >= CONFIDENCE_THRESHOLD - 15
  );

  let soleFinanceMatch = false;
  if (financeFilterActive && best && isFinanceTypedCandidate(best, companyName)) {
    const competingFinance = contenders.filter(c =>
      c.domain !== best.domain &&
      isFinanceTypedCandidate(c, companyName) &&
      Math.abs(c.totalScore - best.totalScore) < AMBIGUITY_GAP + 8 &&
      c.totalScore >= CONFIDENCE_THRESHOLD - 20
    );
    if (!competingFinance.length) {
      soleFinanceMatch = true;
      ambiguous = false;
      if (best.totalScore >= CONFIDENCE_THRESHOLD && best.totalScore < AUTO_FOUND_THRESHOLD) {
        const lift = AUTO_FOUND_THRESHOLD - best.totalScore;
        best = {
          ...best,
          signals: { ...best.signals, finance: (best.signals?.finance || 0) + lift, soleFinanceLift: lift },
          totalScore: AUTO_FOUND_THRESHOLD
        };
      }
    } else if (runnerUp && classifyFinanceAffinity(runnerUp, companyName) === 'unrelated') {
      ambiguous = false;
    }
  }

  // Sole-dominant bonus (+6): clean single-best match just under auto-Found (e.g. 78→84)
  // without lifting the 60–69 band into auto-Found (67+6=73 < 80).
  if (best && !ambiguous && best.totalScore >= 70) {
    const gap = runnerUp ? (best.totalScore - runnerUp.totalScore) : 999;
    const weakRunner = !runnerUp || runnerUp.totalScore < CONFIDENCE_THRESHOLD - 15 || gap >= 18;
    if (weakRunner) {
      const bonus = 6;
      best = {
        ...best,
        signals: { ...best.signals, soleDominant: bonus },
        totalScore: best.totalScore + bonus
      };
    }
  }

  return { best, ambiguous, candidates: ranked.slice(0, 8), ranked: contenders, soleFinanceMatch };
}

export function domainMatches(got, expected, aliases = []) {
  const g = String(got || '').toLowerCase().replace(/^www\./, '');
  const opts = [expected, ...(aliases || [])].map(d => String(d || '').toLowerCase().replace(/^www\./, ''));
  return opts.some(e => g === e || g.endsWith('.' + e) || e.endsWith('.' + g));
}

export async function resolveHard(name, options = {}) {
  const financeFilterActive = !!options.financeFilterActive;
  const skipDictionary = !!options.skipDictionary;

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
        resolveMethod: 'learned',
        financeFilterActive,
        soleFinanceMatch: false,
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
      confidence: 'high',
      score: 100,
      ambiguous: /securities and exchange/i.test(name),
      candidates: normalizeCandidates(
        [{ domain: major.domain, name: major.label, sources: ['major-firm'] }],
        extra
      ),
      sources: ['major-firm'],
      resolveMethod: 'major-firm',
      financeFilterActive,
      soleFinanceMatch: false,
      dnsOk: ok
    };
  }

  if (!skipDictionary) {
    const dict = dictLookup(name);
    if (dict?.domain) {
      const ok = await dnsOk(dict.domain);
      return {
        domain: dict.domain,
        confidence: 'high',
        score: 100,
        ambiguous: false,
        candidates: [{ domain: dict.domain, name, sources: ['dictionary'] }],
        sources: ['dictionary'],
        resolveMethod: 'dictionary',
        financeFilterActive,
        soleFinanceMatch: isFinanceTypedCandidate({ name, domain: dict.domain, snippet: '' }),
        dnsOk: ok
      };
    }
  }

  const cleaned = String(name)
    .replace(/\b(llc|inc|ltd|limited|corp|corporation|co|gmbh|plc|company)\b/gi, '')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Soft-seed catalogue even when skipDictionary: short names like "Stable" otherwise
  // lose to Clearbit imposters (usestable.com) because Clearbit never returns stableam.com
  // for the bare query.
  const dictSoft = dictLookup(name);
  const dictSlug = dictSoft?.domain ? String(dictSoft.domain).split('.')[0] : null;

  // Aggressive shortening for Clearbit coverage (MetLife Investment Management → MetLife)
  const brandShort = cleaned
    .replace(/\b(the|and|of|for)\b/gi, ' ')
    .replace(/\b(investment|management|wealth|markets|solutions|advisors?|advisory|partners|group|foundation|system|university|retirement|board|office|growth|hedge|fund|capital|introductions|marketplace|global|limited|llc|llp)\b/gi, ' ')
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const brandTokens = brandShort.split(/\s+/).filter(Boolean);
  const brandCore = brandTokens.slice(0, 2).join(' ');
  // Avoid ultra-short leftovers (e.g. "CANY" alone → Canyon Partners false positive)
  const usableShort = brandShort && companyKeyNorm(brandShort).length >= 5 ? brandShort : null;
  const usableCore = brandCore && companyKeyNorm(brandCore).length >= 5 ? brandCore : null;
  const usableFirst = brandTokens[0] && brandTokens[0].length >= 5 ? brandTokens[0] : null;

  const queries = [
    name,
    cleaned,
    cleaned.split(/\s+/).slice(0, 2).join(' '),
    usableShort,
    usableCore,
    usableFirst,
    financeFilterActive && !/\b(capital|partners|ventures|investment|fund|equity|advisory|advisors|wealth|finance|bank)\b/i.test(cleaned)
      ? `${cleaned} capital`
      : null,
    dictSlug || null,
    dictSoft ? `${name} asset management` : null,
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
  const dictSeeds = dictSoft?.domain
    ? [{ domain: dictSoft.domain, name, snippet: 'Catalogue', sources: ['dictionary', 'dict-seed'] }]
    : [];

  const [cb, ddg, wiki] = await Promise.all([
    gatherClearbit(queries),
    gatherDuckDuckGo(name, cleaned),
    gatherWikipedia(name, cleaned)
  ]);
  let pool = normalizeCandidates(dictSeeds, govSeeds, cb, ddg, wiki);
  if (!pool.length) {
    const fallback = await gatherOfficialWebsiteFallback(name);
    pool = normalizeCandidates(fallback);
  }
  if (!pool.length) {
    return { domain: null, confidence: 'none', score: 0, candidates: [], sources: [], financeFilterActive };
  }
  const ranked = await rankPool(name, pool, { financeFilterActive });
  if (!ranked.best) {
    return { domain: null, confidence: 'none', score: 0, candidates: ranked.candidates, sources: [], financeFilterActive };
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
    exactName: !!best.exactName,
    matchedName: best.name || name,
    candidates: ranked.candidates,
    sources: best.sources || [],
    signals: best.signals,
    resolveMethod: (best.sources || [])[0] || 'multi-source',
    financeFilterActive,
    soleFinanceMatch: !!ranked.soleFinanceMatch,
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

export { CONFIDENCE_THRESHOLD, AUTO_FOUND_THRESHOLD };
