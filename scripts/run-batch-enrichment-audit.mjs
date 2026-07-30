/**
 * Batch enrichment audit — modes mirror (or explicitly diverge from) the live UI.
 *
 * Modes:
 *   live-ui      Default. Same short-circuits as Enrich All: learned → major-firm → dictionary,
 *                then multi-source. Finance filter ON (matches UI default).
 *   live-parity  Multi-source only (skip dictionary short-circuit). Finance ON.
 *                Use this when measuring wiki-less / Clearbit scoring without catalogue bypass.
 *
 * Usage:
 *   node scripts/run-batch-enrichment-audit.mjs
 *   node scripts/run-batch-enrichment-audit.mjs --mode=live-parity
 *   node scripts/run-batch-enrichment-audit.mjs --mode=live-ui
 */
import fs from 'fs';
import {
  resolveHard,
  shouldAutoFound,
  classifyFinanceAffinity,
  mapPool,
  CONFIDENCE_THRESHOLD,
  AUTO_FOUND_THRESHOLD,
  companyKeyNorm
} from './lib/hard-sample-resolver.mjs';

const args = process.argv.slice(2);
const modeArg = (args.find((a) => a.startsWith('--mode=')) || '--mode=live-ui').split('=')[1];
const MODE = modeArg === 'live-parity' ? 'live-parity' : 'live-ui';
const SKIP_DICTIONARY = MODE === 'live-parity';
const FINANCE_ON = true;

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

function classifyStatus(resolved) {
  if (!resolved?.domain) return { status: 'unverified', reason: resolved?.reason || 'no-domain' };
  const score = Number(resolved.score) || 0;
  const method = resolved.resolveMethod || (resolved.sources || [])[0] || 'multi-source';
  const auto = shouldAutoFound(resolved);
  if (auto) {
    const soleNote = resolved.soleFinanceMatch ? ', sole-finance' : '';
    return {
      status: 'found',
      reason: `${method}@${score} (auto-found ≥${AUTO_FOUND_THRESHOLD}${soleNote})`
    };
  }
  if (score >= CONFIDENCE_THRESHOLD || resolved.confidence === 'high' || (resolved.candidates || []).length) {
    const band = score >= CONFIDENCE_THRESHOLD && score < AUTO_FOUND_THRESHOLD
      ? `mid-band ${score} (confirm required)`
      : `not-auto (${method}@${score}${resolved.ambiguous ? ', ambiguous' : ''})`;
    return { status: 'potential', reason: band };
  }
  return { status: 'unverified', reason: `below-threshold:${score}` };
}

console.log('='.repeat(64));
console.log(`MODE: ${MODE}${MODE === 'live-parity' ? '  ← labeled live-parity (finance ON, no dictionary short-circuit)' : '  ← live UI path (dictionary/major/learned short-circuits ON)'}`);
console.log(`Finance filter: ${FINANCE_ON ? 'ON' : 'OFF'} | auto-Found ≥${AUTO_FOUND_THRESHOLD} | picker ≥${CONFIDENCE_THRESHOLD}`);
console.log(`Companies: ${batch.length} | concurrency 2`);
console.log('='.repeat(64));
console.log('');

const results = await mapPool(batch, 2, async (name) => {
  if (isNonEntity(name)) {
    return { name, status: 'unverified', reason: 'non-entity', candidates: 0, score: 0, mode: MODE };
  }

  const resolved = await resolveHard(name, {
    financeFilterActive: FINANCE_ON,
    skipDictionary: SKIP_DICTIONARY
  });
  const score = Number(resolved.score) || 0;
  const method = resolved.resolveMethod || (resolved.sources || [])[0] || 'none';
  const candidates = resolved.candidates || [];
  const financeAffinity = resolved.domain
    ? classifyFinanceAffinity({ name, domain: resolved.domain, snippet: '' }, name)
    : 'n/a';

  if (!resolved.domain) {
    return {
      name, status: 'unverified', reason: 'no-domain', candidates: candidates.length,
      score, method, financePts: null, financeAffinity, mode: MODE
    };
  }

  const ok = resolved.dnsOk === true || resolved.dnsOk === false
    ? resolved.dnsOk
    : await dnsOk(resolved.domain);
  if (!ok) {
    return {
      name,
      status: 'unverified',
      reason: `dns-fail:${resolved.domain}`,
      website: resolved.domain,
      candidates: candidates.length,
      score,
      method,
      financePts: resolved.signals?.finance ?? null,
      financeAffinity,
      mode: MODE
    };
  }

  const { status, reason } = classifyStatus(resolved);
  const expected = batchMap.get(name);
  const industryHint = expected?.industry || null;
  const details = status === 'unverified'
    ? { website: resolved.domain }
    : await enrich(name, resolved.domain, industryHint);

  return {
    name,
    status,
    reason,
    website: resolved.domain,
    candidates: candidates.length,
    score,
    method,
    ambiguous: !!resolved.ambiguous,
    autoFound: shouldAutoFound(resolved),
    soleFinanceMatch: !!resolved.soleFinanceMatch,
    financePts: resolved.signals?.finance ?? null,
    financeAffinity,
    exactName: !!resolved.exactName,
    nameSimilarity: resolved.signals?.nameSimilarity ?? null,
    financeFilterActive: FINANCE_ON,
    mode: MODE,
    ...details
  };
});

const found = results.filter((r) => r.status === 'found');
const potential = results.filter((r) => r.status === 'potential');
const unverified = results.filter((r) => r.status === 'unverified');

console.log(`=== BREAKDOWN [${MODE}] ===`);
console.log(`Total rows:           ${results.length}`);
console.log(`Found & Verified:     ${found.length}`);
console.log(`Potential:            ${potential.length}`);
console.log(`Unverified:           ${unverified.length}`);
console.log('');

console.log('--- Unverified ---');
for (const r of unverified) console.log(`  ${r.name}  (${r.reason}${r.score != null ? `, score ${r.score}` : ''})`);
console.log('');
console.log('--- Potential (manual Confirm) ---');
for (const r of potential) {
  console.log(
    `  ${r.name}  → ${r.website}  score=${r.score} financePts=${r.financePts ?? '-'} ` +
    `affinity=${r.financeAffinity} (${r.reason})`
  );
}
console.log('');
console.log('--- Found (auto) sample ---');
for (const r of found.slice(0, 25)) {
  console.log(
    `  ${r.name}  → ${r.website}  ${r.method}@${r.score}` +
    ` financePts=${r.financePts ?? '-'} affinity=${r.financeAffinity}` +
    `${r.soleFinanceMatch ? ' sole-finance' : ''}`
  );
}
if (found.length > 25) console.log(`  ... +${found.length - 25} more Found`);
console.log('');

// Spotlight the previously sticky / diagnostic names
const spotlight = [
  'Stripe',
  'Trinity Church Wall Street',
  'Stable',
  'Epibone',
  'ONE Concern',
  'Cara Advisory',
  'PIMCO',
  'Heard Capital'
];
console.log('=== SPOTLIGHT ===');
for (const n of spotlight) {
  const r = results.find((x) => x.name.toLowerCase() === n.toLowerCase());
  if (!r) {
    console.log(`  ${n}: (not in batch)`);
    continue;
  }
  console.log(
    `  ${r.name}: ${r.status} → ${r.website || '-'} score=${r.score} ` +
    `financePts=${r.financePts ?? '-'} affinity=${r.financeAffinity} method=${r.method}`
  );
}

const outName = MODE === 'live-parity'
  ? '../scripts/last-live-parity-batch.json'
  : '../scripts/last-batch-enrichment-audit.json';
fs.writeFileSync(
  new URL(outName, import.meta.url),
  JSON.stringify({
    mode: MODE,
    label: MODE === 'live-parity'
      ? 'live-parity (finance ON, no dictionary short-circuit)'
      : 'live-ui (dictionary/major/learned short-circuits like Enrich All)',
    summary: {
      total: results.length,
      found: found.length,
      potential: potential.length,
      unverified: unverified.length,
      autoFoundThreshold: AUTO_FOUND_THRESHOLD,
      pickerThreshold: CONFIDENCE_THRESHOLD,
      financeFilterActive: FINANCE_ON,
      skipDictionary: SKIP_DICTIONARY
    },
    results
  }, null, 2)
);
console.log(`\nWrote ${outName.replace('../', '')}`);
void companyKeyNorm;
