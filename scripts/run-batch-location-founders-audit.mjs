/**
 * Post-Location-fix batch audit + Founders Unknown forensic dig.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// --- Load location validators from index.html ---
const sandbox = {
  console,
  Set,
  UNKNOWN: 'Unknown',
  isBlankOrUnknown(v) {
    if (v == null) return true;
    const s = String(v).trim();
    return !s || s === '-' || /^unknown$/i.test(s) || /^needs manual/i.test(s) || /^needs verification/i.test(s);
  }
};
vm.createContext(sandbox);
const blockStart = html.indexOf('const US_STATE_OR_PROVINCE = new Set([');
const blockEnd = html.indexOf('function applyBatchUniquenessGuard', blockStart);
vm.runInContext(
  html.slice(blockStart, blockEnd) +
    '\nthis.isValidLocationPlace=isValidLocationPlace;this.sanitizeLocationValue=sanitizeLocationValue;this.preferLocation=preferLocation;\n',
  sandbox
);
const { sanitizeLocationValue, preferLocation, isValidLocationPlace } = sandbox;

// --- Batch list (same as before) ---
const start = html.indexOf('const companyDictionary = {');
const end = html.indexOf('\n    };', start);
const block = html.slice(start, end);
const entries = [];
const re = /"([^"]+)":\s*\{[\s\S]*?domain:\s*"([^"]+)"[\s\S]*?industry:\s*"([^"]+)"[\s\S]*?location:\s*"([^"]*)"[\s\S]*?founder:\s*"([^"]*)"/g;
let m;
while ((m = re.exec(block))) {
  entries.push({ key: m[1], domain: m[2], industry: m[3], location: m[4], founder: m[5] });
}
const byDomain = new Map();
for (const e of entries) {
  const prev = byDomain.get(e.domain);
  if (!prev || e.key.length > prev.key.length) byDomain.set(e.domain, e);
}

const EXTRA = [
  { key: 'PIMCO', domain: 'pimco.com', industry: 'Investment Management', location: '', founder: '' },
  { key: 'Blackstone', domain: 'blackstone.com', industry: 'Private Equity', location: 'New York, NY', founder: 'Stephen A. Schwarzman (CEO)' },
  { key: 'Fordham University', domain: 'fordham.edu', industry: 'Education', location: 'New York, NY', founder: '' },
  { key: 'Trinity Church Wall Street', domain: 'trinitywallstreet.org', industry: 'Nonprofit / Foundation', location: '', founder: '' },
  { key: 'Office of New York City Comptroller', domain: 'comptroller.nyc.gov', industry: 'Government', location: '', founder: '' },
  { key: 'West Virginia University Foundation', domain: 'wvuf.org', industry: 'Nonprofit / Foundation', location: '', founder: '' },
  { key: 'NAV Fund Services', domain: 'navfundservices.com', industry: null, location: '', founder: '' },
  { key: 'Cara Advisory', domain: 'caraadvisory.com', industry: null, location: '', founder: '' },
  { key: 'Stable', domain: 'stableam.com', industry: null, location: '', founder: '' },
  { key: 'Disciplina Capital Management', domain: 'disciplina.com', industry: null, location: '', founder: '' },
  { key: 'Impactus Partners', domain: 'impactus-partners.com', industry: null, location: '', founder: '' },
  { key: 'Private Fund (Moderator)', domain: null, industry: null, location: '', founder: '' }
];

function prettyKey(key) {
  return key
    .split(' ')
    .map((w) => (w.length <= 3 && w === w.toLowerCase() ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const batchMap = new Map();
for (const e of byDomain.values()) batchMap.set(prettyKey(e.key), e);
for (const e of EXTRA) batchMap.set(e.key, e);
const batch = [...batchMap.entries()].map(([name, e]) => ({ name, ...e }));

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MAJOR = {
  blackstone: 'blackstone.com', blackstonegroup: 'blackstone.com', theblackstonegroup: 'blackstone.com',
  blackrock: 'blackrock.com', pimco: 'pimco.com', fordham: 'fordham.edu', fordhamuniversity: 'fordham.edu',
  cornell: 'cornell.edu', cornelluniversity: 'cornell.edu', google: 'google.com', microsoft: 'microsoft.com',
  apple: 'apple.com', amazon: 'amazon.com', meta: 'meta.com', stripe: 'stripe.com', openai: 'openai.com',
  netflix: 'netflix.com', tesla: 'tesla.com', notion: 'notion.so', linkedin: 'linkedin.com'
};

function isNonEntity(name) {
  return /\(\s*moderator\s*\)/i.test(name) || /^private fund$/i.test(String(name).trim());
}

async function dnsOk(domain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await (await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`)).json();
      if (j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150 + attempt * 200));
  }
  try {
    const r = await fetch(`https://${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(4500) });
    if (r.status > 0 && r.status < 500) return true;
  } catch (_) {}
  return false;
}

async function fetchPageHtml(url, timeoutMs = 4500) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicAudit/1.1)', Accept: 'text/html' },
      redirect: 'follow'
    });
    if (res.ok) {
      const t = await res.text();
      if (t && t.length >= 40) return t;
    }
  } catch (_) {}
  for (const build of [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`
  ]) {
    try {
      const res = await fetch(build(url), { signal: AbortSignal.timeout(3500) });
      if (!res.ok) continue;
      let t = await res.text();
      if (t.trim().startsWith('{') && t.includes('"contents"')) {
        try { t = JSON.parse(t).contents || ''; } catch (_) {}
      }
      if (t && t.length >= 40) return t;
    } catch (_) {}
  }
  return null;
}

function stripHtmlToText(h) {
  return String(h || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(page, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
  ];
  for (const p of patterns) {
    const mm = page.match(p);
    if (mm?.[1]) return mm[1].trim();
  }
  return '';
}

function inferEntityTypeIndustry(companyName, domain) {
  const host = String(domain || '').toLowerCase();
  const n = String(companyName || '').trim();
  const blob = `${n} ${host}`.toLowerCase();
  if (/\b(foundation|non-?profit|nonprofit|charity|ngo|church)\b/i.test(blob)) return 'Nonprofit / Foundation';
  if (/\.edu$/i.test(host) || /\b(university|college)\b/i.test(n)) return 'Education';
  if (/\.gov$/i.test(host) || /\b(comptroller|government|agency)\b/i.test(n)) return 'Government';
  return null;
}

function guessIndustry(name, domain, text, hint) {
  const entity = inferEntityTypeIndustry(name, domain);
  if (entity) return entity;
  if (hint && hint !== 'Unknown') return hint;
  const blob = `${name} ${domain} ${text}`.toLowerCase();
  const rules = [
    [/private equity|buyout/, 'Private Equity'],
    [/venture capital|\bvc\b/, 'Venture Capital'],
    [/asset management|investment management/, 'Investment Management'],
    [/fintech|payments/, 'Financial Services'],
    [/biotech|therapeutics/, 'Biotechnology'],
    [/software|saas|platform/, 'Software'],
    [/university|college/, 'Education']
  ];
  for (const [rx, label] of rules) if (rx.test(blob)) return label;
  return 'Unknown';
}

/** Mirror app founder patterns + capture ALL raw hits for forensics */
function extractFoundersForensic(corpus, companyName) {
  const founderPatterns = [
    /(?:[Ff]ounded by|[Cc]o-founded by|[Ff]ounder[:\s]+|[Cc]o-[Ff]ounder[:\s]+)([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s*,?\s*(?:Founder|Co-Founder|CEO|Chief Executive Officer|Managing Partner|Managing Director)\b/g
  ];
  const badName = /^(The|Our|This|With|And|Or|For|From|About|Meet|Team|Company|Board)\b|^(and|or)\b/i;
  const rawHits = [];
  for (const re of founderPatterns) {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(corpus)) !== null) {
      rawHits.push({ pattern: re.source.slice(0, 40) + '…', match: mm[0].slice(0, 120), captured: (mm[1] || '').trim() });
    }
  }
  // Broader keyword windows for forensics (not used as accepted founder unless it also passes app filters)
  const windows = [];
  const kw = /\b(founded by|co-founded by|founder|co-founder|ceo)\b/gi;
  let km;
  while ((km = kw.exec(corpus)) !== null && windows.length < 8) {
    const i = km.index;
    windows.push(corpus.slice(Math.max(0, i - 40), Math.min(corpus.length, i + 80)).replace(/\s+/g, ' ').trim());
  }

  let accepted = 'Unknown';
  for (const hit of rawHits) {
    const name = hit.captured;
    if (
      name.split(/\s+/).length >= 2 &&
      name.length < 60 &&
      !badName.test(name) &&
      !/\b(?:CEO|CTO|CFO|Founder)\b/i.test(name)
    ) {
      const c = name.toLowerCase();
      const n = String(companyName || '').toLowerCase();
      if (c === n || n.includes(c) || c.includes(n)) continue;
      accepted = name;
      break;
    }
  }
  return { accepted, rawHits: rawHits.slice(0, 12), windows };
}

function extractLocationCandidates(corpus) {
  const out = [];
  const locPatterns = [
    /\b(?:based in|headquartered in|headquarters(?:\s+in)?|located in|hq in)\s+([A-Z][a-zA-Z .'-]{1,40}?),\s*([A-Z]{2}|[A-Z][a-zA-Z][a-zA-Z .'-]{1,30})\b/,
    /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,3}),\s*([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?/,
    /\b(New York|San Francisco|Los Angeles|London|Paris|Berlin|Toronto|Austin|Seattle|Boston|Chicago|Nashville|Mountain View|Cupertino|Redmond|Menlo Park|Palo Alto|Ithaca),\s*([A-Z]{2}|UK|USA|United States|France|Germany|Canada|England)?\b/i,
    /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))\b/
  ];
  for (const rx of locPatterns) {
    const mm = corpus.match(rx);
    if (!mm) continue;
    const cand = mm[2] && String(mm[2]).trim() ? `${mm[1].trim()}, ${mm[2].trim()}` : mm[1].trim();
    out.push(cand.replace(/,\s*,/g, ',').trim());
  }
  return out;
}

async function resolveDomain(item) {
  if (isNonEntity(item.name) || !item.domain) return { domain: null, reason: isNonEntity(item.name) ? 'non-entity' : 'no-domain' };
  const major = MAJOR[companyKeyNorm(item.name)];
  if (major) return { domain: major, reason: 'major-firm' };
  return { domain: item.domain, reason: 'dictionary' };
}

async function enrichOne(item) {
  const resolved = await resolveDomain(item);
  if (!resolved.domain) {
    return { name: item.name, status: 'unverified', reason: resolved.reason, location: 'Unknown', founders: 'Unknown', website: '' };
  }
  const ok = await dnsOk(resolved.domain);
  if (!ok) {
    return { name: item.name, status: 'unverified', reason: `dns-fail:${resolved.domain}`, website: resolved.domain, location: 'Unknown', founders: 'Unknown' };
  }

  const page =
    (await fetchPageHtml(`https://${resolved.domain}/`)) ||
    (await fetchPageHtml(`https://www.${resolved.domain}/`)) ||
    (await fetchPageHtml(`https://${resolved.domain}/about`)) ||
    '';
  const desc = page ? (extractMeta(page, 'og:description') || extractMeta(page, 'description') || '') : '';
  const corpus = page ? `${desc} ${stripHtmlToText(page).slice(0, 10000)}` : '';

  const rawLocs = extractLocationCandidates(corpus);
  let scrapedLoc = 'Unknown';
  for (const c of rawLocs) {
    const s = sanitizeLocationValue(c);
    if (s !== 'Unknown') { scrapedLoc = s; break; }
  }
  const dictLoc = sanitizeLocationValue(item.location || '');
  const location = preferLocation(scrapedLoc, dictLoc);

  const founderInfo = extractFoundersForensic(corpus, item.name);
  const dictFounder = item.founder && !/^needs /i.test(item.founder) && item.founder.trim() ? item.founder.trim() : '';
  // Mirror app: dict founder preferred when present
  const founders = dictFounder || founderInfo.accepted || 'Unknown';

  const industry = guessIndustry(item.name, resolved.domain, corpus, item.industry);

  // Location regression flags
  const noisyLoc = ['Prerna Gupta', 'Avenue, Suite', 'Jesuit, Catholic', 'Fixed Income', 'Apple Watch', 'Pa,Qa', 'Diversity, Equity']
    .some((x) => String(location).includes(x));

  return {
    name: item.name,
    status: 'found',
    reason: resolved.reason,
    website: resolved.domain,
    industry,
    location,
    scrapedLoc,
    dictLoc,
    rawLocCandidates: rawLocs.slice(0, 6),
    noisyLoc,
    founders,
    founderSource: dictFounder ? 'dictionary' : (founderInfo.accepted !== 'Unknown' ? 'scrape' : 'none'),
    founderRawHits: founderInfo.rawHits,
    founderWindows: founderInfo.windows,
    pageFetched: !!page,
    pageChars: page ? page.length : 0
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

console.log(`Re-running full batch (${batch.length}) with Location validation...\n`);
const results = await mapPool(batch, 3, enrichOne);

const found = results.filter((r) => r.status === 'found');
const unverified = results.filter((r) => r.status === 'unverified');
const noisy = results.filter((r) => r.noisyLoc);
const badExamples = ['PIMCO', 'Stripe', 'Fordham University', 'Google', 'Blackstone', 'Cornell University', 'Notion', 'Apple', 'Gilder Partners FOR Growth', 'Trinity Church Wall Street'];

console.log('=== BREAKDOWN ===');
console.log(`Total: ${results.length}`);
console.log(`Found & Verified: ${found.length}`);
console.log(`Potential: 0 (audit treats high-confidence as Found-after-confirm)`);
console.log(`Unverified: ${unverified.length}`);
console.log(`Location noisy regressions: ${noisy.length}`);
if (noisy.length) noisy.forEach((r) => console.log(`  NOISE ${r.name}: ${r.location}`));

console.log('\n=== SPOT-CHECK (Location) ===');
for (const name of badExamples) {
  const r = results.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!r) continue;
  console.log(`${r.name}: Location=${r.location} (scraped=${r.scrapedLoc}, dict=${r.dictLoc || '—'}) raw=${JSON.stringify(r.rawLocCandidates || [])}`);
}

const unknownFounders = found.filter((r) => r.founders === 'Unknown');
const knownFounders = found.filter((r) => r.founders !== 'Unknown');
console.log(`\n=== FOUNDERS SUMMARY ===`);
console.log(`Found rows with Founders filled: ${knownFounders.length}`);
console.log(`Found rows with Founders Unknown: ${unknownFounders.length}`);
console.log('Filled examples:', knownFounders.slice(0, 8).map((r) => `${r.name}=${r.founders} (${r.founderSource})`).join(' | '));

// Pick 8 Unknown founder cases with page fetched for forensic dig
const dig = unknownFounders.filter((r) => r.pageFetched).slice(0, 8);
// Prefer well-known names in the dig
const prefer = ['Google', 'Stripe', 'PIMCO', 'Blackstone', 'Fordham University', 'Apple', 'Microsoft', 'Openai', 'Tesla', 'Netflix', 'Notion', 'Linkedin'];
const digOrdered = [];
for (const p of prefer) {
  const hit = unknownFounders.find((r) => r.name.toLowerCase() === p.toLowerCase());
  if (hit && !digOrdered.find((d) => d.name === hit.name)) digOrdered.push(hit);
}
for (const r of unknownFounders) {
  if (digOrdered.length >= 8) break;
  if (!digOrdered.find((d) => d.name === r.name)) digOrdered.push(r);
}

console.log('\n=== FOUNDERS UNKNOWN FORENSICS (8) ===');
for (const r of digOrdered.slice(0, 8)) {
  console.log(`\n--- ${r.name} (${r.website}) pageChars=${r.pageChars} ---`);
  console.log(`  Final Founders: ${r.founders} (source=${r.founderSource})`);
  console.log(`  Dict founder available: ${byDomain.get(r.website)?.founder || EXTRA.find((e) => e.domain === r.website)?.founder || '(none in dict)'}`);
  console.log(`  App-pattern raw hits (${r.founderRawHits?.length || 0}):`);
  if (!r.founderRawHits?.length) console.log('    (no founder-pattern matches on homepage/about text)');
  else for (const h of r.founderRawHits.slice(0, 5)) {
    console.log(`    captured=${JSON.stringify(h.captured)} | match=${JSON.stringify(h.match)}`);
  }
  console.log(`  Keyword windows:`);
  if (!r.founderWindows?.length) console.log('    (no founder/CEO keyword windows found in scraped text)');
  else for (const w of r.founderWindows.slice(0, 5)) console.log(`    …${w}…`);

  // Verdict
  const hasUsableHit = (r.founderRawHits || []).some((h) => {
    const name = h.captured || '';
    return name.split(/\s+/).length >= 2 && name.length < 60 && !/^(The|Our|Team|Company)\b/i.test(name);
  });
  const hasWindow = (r.founderWindows || []).length > 0;
  let verdict = 'HONEST Unknown — scrape had no usable founder attribution';
  if (hasUsableHit) verdict = 'POSSIBLE FALSE NEGATIVE — pattern matched a name but filters rejected it';
  else if (hasWindow) verdict = 'LIKELY HONEST — founder keywords present but no clean Name capture';
  console.log(`  Verdict: ${verdict}`);
}

const out = {
  summary: {
    total: results.length,
    found: found.length,
    unverified: unverified.length,
    locationNoisy: noisy.length,
    foundersFilled: knownFounders.length,
    foundersUnknown: unknownFounders.length
  },
  spotCheck: badExamples.map((n) => results.find((r) => r.name.toLowerCase() === n.toLowerCase())).filter(Boolean),
  founderDig: digOrdered.slice(0, 8),
  results
};
fs.writeFileSync(path.join(root, 'scripts/last-batch-location-founders-audit.json'), JSON.stringify(out, null, 2));
console.log('\nWrote scripts/last-batch-location-founders-audit.json');
