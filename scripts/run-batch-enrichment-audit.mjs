/**
 * Full-batch enrichment audit for the Clay Mimic dictionary + EXTRA test set.
 * Mirrors resolve → verify → enrich, then classifies Found / Potential / Unverified.
 *
 * Note: the live UI now always pauses at Potential until the user confirms a website.
 * For this audit, "Found & Verified" = recommended domain verified + enriched as if Confirm was clicked
 * on a high-confidence pick (dictionary / major firm / strong Clearbit). Ambiguous picks stay Potential.
 */
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const companyDictionary = {');
const end = html.indexOf('\n    };', start);
const block = html.slice(start, end);
const entries = [];
const re = /"([^"]+)":\s*\{[\s\S]*?domain:\s*"([^"]+)"[\s\S]*?industry:\s*"([^"]+)"/g;
let m;
while ((m = re.exec(block))) {
  entries.push({ key: m[1], domain: m[2], industry: m[3] });
}
const byDomain = new Map();
for (const e of entries) {
  const prev = byDomain.get(e.domain);
  if (!prev || e.key.length > prev.key.length) byDomain.set(e.domain, e);
}

const EXTRA = [
  { key: 'PIMCO', domain: 'pimco.com' },
  { key: 'Blackstone', domain: 'blackstone.com' },
  { key: 'Fordham University', domain: 'fordham.edu' },
  { key: 'Trinity Church Wall Street', domain: 'trinitywallstreet.org' },
  { key: 'Office of New York City Comptroller', domain: 'comptroller.nyc.gov' },
  { key: 'West Virginia University Foundation', domain: 'wvuf.org' },
  { key: 'NAV Fund Services', domain: 'navfundservices.com' },
  { key: 'Cara Advisory', domain: 'caraadvisory.com' },
  { key: 'Stable', domain: 'stableam.com' },
  { key: 'Disciplina Capital Management', domain: 'disciplina.com' },
  { key: 'Impactus Partners', domain: 'impactus-partners.com' },
  { key: 'Private Fund (Moderator)', domain: null }
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
const batch = [...batchMap.keys()];

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MAJOR = {
  blackstone: { domain: 'blackstone.com', label: 'The Blackstone Group' },
  blackstonegroup: { domain: 'blackstone.com', label: 'The Blackstone Group' },
  theblackstonegroup: { domain: 'blackstone.com', label: 'The Blackstone Group' },
  blackrock: { domain: 'blackrock.com', label: 'BlackRock' },
  pimco: { domain: 'pimco.com', label: 'PIMCO' },
  fordham: { domain: 'fordham.edu', label: 'Fordham University' },
  fordhamuniversity: { domain: 'fordham.edu', label: 'Fordham University' },
  cornell: { domain: 'cornell.edu', label: 'Cornell University' },
  cornelluniversity: { domain: 'cornell.edu', label: 'Cornell University' },
  google: { domain: 'google.com', label: 'Google' },
  microsoft: { domain: 'microsoft.com', label: 'Microsoft' },
  apple: { domain: 'apple.com', label: 'Apple' },
  amazon: { domain: 'amazon.com', label: 'Amazon' },
  meta: { domain: 'meta.com', label: 'Meta' },
  stripe: { domain: 'stripe.com', label: 'Stripe' },
  openai: { domain: 'openai.com', label: 'OpenAI' },
  netflix: { domain: 'netflix.com', label: 'Netflix' },
  tesla: { domain: 'tesla.com', label: 'Tesla' },
  notion: { domain: 'notion.so', label: 'Notion' },
  linkedin: { domain: 'linkedin.com', label: 'LinkedIn' }
};

function isNonEntity(name) {
  return /\(\s*moderator\s*\)/i.test(name) || /^private fund$/i.test(String(name).trim());
}

function inferEntityTypeIndustry(companyName, domain) {
  const host = String(domain || '').toLowerCase();
  const n = String(companyName || '').trim();
  const blob = `${n} ${host}`.toLowerCase();
  if (/\b(foundation|non-?profit|nonprofit|charity|ngo|church|temple|mosque|synagogue|parish|congregation)\b/i.test(blob)) {
    return 'Nonprofit / Foundation';
  }
  if (/\.edu$/i.test(host) || /\b(university|college|polytechnic|school|academy)\b/i.test(n)) return 'Education';
  if (/\.gov$/i.test(host) || /\b(comptroller|department of|ministry of|city of|government|agency|authority|commission)\b/i.test(n)) {
    return 'Government';
  }
  return null;
}

async function dnsOk(domain) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await (await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=A`)).json();
      if (j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200 + attempt * 300));
  }
  // Fallback: reachable HTTPS counts as live even if DNS API was rate-limited
  try {
    const r = await fetch(`https://${domain}`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicAudit/1.0)' }
    });
    if (r.status > 0 && r.status < 500) return true;
  } catch (_) {}
  try {
    const r = await fetch(`https://www.${domain}`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicAudit/1.0)' }
    });
    if (r.status > 0 && r.status < 500) return true;
  } catch (_) {}
  return false;
}

async function clearbitSuggest(q) {
  try {
    const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function dictLookup(name) {
  const key = String(name || '').trim().toLowerCase();
  const norm = companyKeyNorm(name);
  for (const e of byDomain.values()) {
    if (e.key === key || companyKeyNorm(e.key) === norm) return e;
  }
  // fuzzy: entry key contained / contains
  for (const e of byDomain.values()) {
    const ek = companyKeyNorm(e.key);
    if (ek && (norm.includes(ek) || ek.includes(norm)) && Math.min(ek.length, norm.length) >= 4) return e;
  }
  return null;
}

async function resolveCompany(name) {
  if (isNonEntity(name)) {
    return { domain: null, confidence: 'none', reason: 'non-entity', candidates: [] };
  }
  const major = MAJOR[companyKeyNorm(name)];
  if (major) {
    const extras = await clearbitSuggest(name);
    const candidates = [
      { domain: major.domain, name: major.label },
      ...extras.map((x) => ({ domain: x.domain, name: x.name }))
    ].filter((c, i, arr) => c.domain && arr.findIndex((y) => y.domain === c.domain) === i);
    return { domain: major.domain, confidence: 'high', reason: 'major-firm', candidates, matchedName: major.label };
  }
  const dict = dictLookup(name);
  if (dict?.domain) {
    const extras = await clearbitSuggest(name);
    const candidates = [
      { domain: dict.domain, name: prettyKey(dict.key) },
      ...extras.map((x) => ({ domain: x.domain, name: x.name }))
    ].filter((c, i, arr) => c.domain && arr.findIndex((y) => y.domain === c.domain) === i);
    return {
      domain: dict.domain,
      confidence: 'high',
      reason: 'dictionary',
      candidates,
      matchedName: prettyKey(dict.key),
      industryHint: dict.industry
    };
  }

  const cleaned = String(name)
    .replace(/\b(llc|inc|ltd|limited|corp|corporation|co|gmbh|plc)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const suggestions = await clearbitSuggest(cleaned || name);
  if (!suggestions.length) {
    return { domain: null, confidence: 'none', reason: 'no-clearbit', candidates: [] };
  }
  const top = suggestions[0];
  const topName = String(top.name || '').toLowerCase();
  const q = cleaned.toLowerCase();
  const exactish =
    topName === q ||
    topName.includes(q) ||
    q.includes(topName) ||
    companyKeyNorm(top.name) === companyKeyNorm(name);
  const second = suggestions[1];
  const ambiguous = !exactish || (second && String(second.name || '').toLowerCase().includes(q.split(' ')[0]));
  return {
    domain: top.domain,
    confidence: ambiguous ? 'low' : 'high',
    reason: ambiguous ? 'clearbit-ambiguous' : 'clearbit',
    candidates: suggestions.slice(0, 8).map((x) => ({ domain: x.domain, name: x.name })),
    matchedName: top.name
  };
}

async function fetchPageHtml(absoluteUrl, timeoutMs = 4500) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(absoluteUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicAudit/1.0)', Accept: 'text/html' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (res.ok) {
      const htmlText = await res.text();
      if (htmlText && htmlText.length >= 40) return htmlText;
    }
  } catch (_) {}
  for (const build of [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`
  ]) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(build(absoluteUrl), { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      let text = await res.text();
      if (text.trim().startsWith('{') && text.includes('"contents"')) {
        try { text = JSON.parse(text).contents || ''; } catch (_) {}
      }
      if (text && text.length >= 40) return text;
    } catch (_) {}
  }
  return null;
}

function extractMeta(page, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
  ];
  for (const p of patterns) {
    const m2 = page.match(p);
    if (m2?.[1]) return m2[1].trim();
  }
  return '';
}

function guessIndustryFromText(name, domain, text) {
  const entity = inferEntityTypeIndustry(name, domain);
  if (entity) return entity;
  const blob = `${name} ${domain} ${text}`.toLowerCase();
  const rules = [
    [/private equity|buyout|alternative asset/, 'Private Equity'],
    [/venture capital|\bvc\b|seed fund/, 'Venture Capital'],
    [/asset management|investment management|investments\b/, 'Investment Management'],
    [/investment bank|capital markets/, 'Investment Banking'],
    [/fintech|payments|banking/, 'Financial Services'],
    [/biotech|therapeutics|life sciences/, 'Biotechnology'],
    [/robotics|aerospace|hardware/, 'Hardware / Robotics'],
    [/software|saas|platform|api/, 'Software'],
    [/university|college|education/, 'Education'],
    [/foundation|nonprofit|church/, 'Nonprofit / Foundation']
  ];
  for (const [rx, label] of rules) {
    if (rx.test(blob)) return label;
  }
  return 'Unknown';
}

function extractFounders(page) {
  const text = page.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const patterns = [
    /(?:founded by|co-?founders?|founder[s]?)\s*[:\-–]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}(?:\s+(?:and|&)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})?)/i,
    /"founder"\s*:\s*"([^"]+)"/i
  ];
  for (const p of patterns) {
    const m2 = text.match(p);
    if (m2?.[1] && m2[1].length < 80) return m2[1].trim();
  }
  return 'Unknown';
}

function extractLocation(page) {
  const loc =
    extractMeta(page, 'og:locale:alternate') ||
    extractMeta(page, 'geo.placename') ||
    (() => {
      const m2 = page.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))\b/);
      return m2?.[1] || '';
    })();
  if (loc && loc.length < 60 && !/utf-?8|en_US/i.test(loc)) return loc;
  return 'Unknown';
}

async function enrich(name, domain, industryHint) {
  const page = (await fetchPageHtml(`https://${domain}`)) || (await fetchPageHtml(`https://www.${domain}`)) || '';
  const desc = page ? extractMeta(page, 'og:description') || extractMeta(page, 'description') : '';
  return {
    website: domain,
    industry: industryHint || guessIndustryFromText(name, domain, `${desc} ${page.slice(0, 4000)}`),
    location: page ? extractLocation(page) : 'Unknown',
    founders: page ? extractFounders(page) : 'Unknown'
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

console.log(`Running enrichment audit on ${batch.length} companies (concurrency 5)...\n`);

const results = await mapPool(batch, 3, async (name) => {
  const resolved = await resolveCompany(name);
  if (!resolved.domain) {
    return { name, status: 'unverified', reason: resolved.reason, candidates: 0 };
  }
  const ok = await dnsOk(resolved.domain);
  if (!ok) {
    return {
      name,
      status: 'unverified',
      reason: `dns-fail:${resolved.domain}`,
      website: resolved.domain,
      candidates: resolved.candidates.length
    };
  }

  // Ambiguous Clearbit → Potential (options exist, not auto-trusted)
  if (resolved.confidence === 'low') {
    const details = await enrich(name, resolved.domain, resolved.industryHint);
    return {
      name,
      status: 'potential',
      reason: resolved.reason,
      website: resolved.domain,
      candidates: resolved.candidates.length,
      ...details
    };
  }

  const details = await enrich(name, resolved.domain, resolved.industryHint);
  return {
    name,
    status: 'found',
    reason: resolved.reason,
    website: resolved.domain,
    candidates: resolved.candidates.length,
    ...details
  };
});

const found = results.filter((r) => r.status === 'found');
const potential = results.filter((r) => r.status === 'potential');
const unverified = results.filter((r) => r.status === 'unverified');

console.log('=== BREAKDOWN ===');
console.log(`Total rows:           ${results.length}`);
console.log(`Found & Verified:     ${found.length}`);
console.log(`Potential:            ${potential.length}`);
console.log(`Unverified:           ${unverified.length}`);
console.log('');

console.log('--- Unverified ---');
for (const r of unverified) console.log(`  ${r.name}  (${r.reason})`);
console.log('');
console.log('--- Potential ---');
for (const r of potential) console.log(`  ${r.name}  → ${r.website}  (${r.reason}, ${r.candidates} options)`);
console.log('');

// Prefer diverse Found samples for manual check
const preferred = [
  'Blackstone',
  'Fordham University',
  'PIMCO',
  'Google',
  'Stripe',
  'Cornell University',
  'Trinity Church Wall Street',
  'Blackrock',
  'Openai',
  'Impactus Partners'
];
const samples = [];
for (const p of preferred) {
  const hit = found.find((r) => r.name.toLowerCase() === p.toLowerCase());
  if (hit && !samples.find((s) => s.name === hit.name)) samples.push(hit);
  if (samples.length >= 5) break;
}
for (const r of found) {
  if (samples.length >= 5) break;
  if (!samples.find((s) => s.name === r.name)) samples.push(r);
}

console.log('=== 5 FOUND & VERIFIED (full fields for manual check) ===');
for (const r of samples) {
  console.log(`\n${r.name}`);
  console.log(`  Website:   ${r.website}`);
  console.log(`  Industry:  ${r.industry}`);
  console.log(`  Location:  ${r.location}`);
  console.log(`  Founders:  ${r.founders}`);
  console.log(`  (resolve: ${r.reason})`);
}

fs.writeFileSync(
  new URL('../scripts/last-batch-enrichment-audit.json', import.meta.url),
  JSON.stringify({ summary: { total: results.length, found: found.length, potential: potential.length, unverified: unverified.length }, results, samples }, null, 2)
);
console.log('\nWrote scripts/last-batch-enrichment-audit.json');
