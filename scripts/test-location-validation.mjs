/**
 * Verify Location validation rejects scraped garbage and that
 * PIMCO / Stripe / Fordham end as a real place or Unknown.
 */
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Extract helper functions from the Babel script block
function extractFn(name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n    \\}\\n`);
  const m = html.match(re);
  if (!m) throw new Error('Could not extract ' + name);
  return m[0];
}

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

// Pull the const sets + functions that live between isBlankOrUnknown and sanitizeLocationValue
const start = html.indexOf('const US_STATE_OR_PROVINCE');
const end = html.indexOf('function normalizeEnrichValue', html.indexOf('function sanitizeLocationValue'));
// Actually sanitizeLocationValue comes after isValidLocationPlace; normalizeEnrichValue is before US_STATE
const blockStart = html.indexOf('const US_STATE_OR_PROVINCE = new Set([');
const blockEnd = html.indexOf('function applyBatchUniquenessGuard', blockStart);
const block = html.slice(blockStart, blockEnd);
vm.runInContext(block + '\nthis.isValidLocationPlace = isValidLocationPlace;\nthis.sanitizeLocationValue = sanitizeLocationValue;\n', sandbox);

const { isValidLocationPlace, sanitizeLocationValue } = sandbox;

const shouldReject = [
  'Prerna Gupta, Fixed Income',
  'Avenue, Suite',
  'Jesuit, Catholic',
  'Apple Watch, Mac',
  'Pa,Qa',
  'Web Communications, Cornell University',
  'BlackRock, Inc',
  'Diversity, Equity'
];
const shouldAccept = [
  'New York, NY',
  'San Francisco, CA',
  'London, UK',
  'Paris, France',
  'Ithaca, NY',
  'Mountain View, CA',
  'United States'
];

console.log('=== Validation unit checks ===');
let failed = 0;
for (const v of shouldReject) {
  const ok = !isValidLocationPlace(v) && sanitizeLocationValue(v) === 'Unknown';
  console.log(`${ok ? 'PASS' : 'FAIL'} reject: ${JSON.stringify(v)} → ${sanitizeLocationValue(v)}`);
  if (!ok) failed++;
}
for (const v of shouldAccept) {
  const ok = isValidLocationPlace(v);
  console.log(`${ok ? 'PASS' : 'FAIL'} accept: ${JSON.stringify(v)}`);
  if (!ok) failed++;
}

// Live enrich path: scrape + dictionary merge mirroring app rules
async function fetchPageHtml(absoluteUrl, timeoutMs = 4500) {
  try {
    const res = await fetch(absoluteUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicLocTest/1.0)', Accept: 'text/html' },
      redirect: 'follow'
    });
    if (res.ok) {
      const t = await res.text();
      if (t && t.length >= 40) return t;
    }
  } catch (_) {}
  return null;
}

function stripHtmlToText(htmlStr) {
  return String(htmlStr || '')
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
    const m = page.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function extractRawLocationCandidates(corpus) {
  const out = [];
  const locPatterns = [
    /\b(?:based in|headquartered in|headquarters(?:\s+in)?|located in|hq in)\s+([A-Z][a-zA-Z .'-]{1,40}?),\s*([A-Z]{2}|[A-Z][a-zA-Z][a-zA-Z .'-]{1,30})\b/,
    /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,3}),\s*([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?/,
    /\b(New York|San Francisco|Los Angeles|London|Paris|Berlin|Toronto|Austin|Seattle|Boston|Chicago|Nashville|Mountain View|Cupertino|Redmond|Menlo Park|Palo Alto|Ithaca),\s*([A-Z]{2}|UK|USA|United States|France|Germany|Canada|England)?\b/i,
    // Old noisy pattern (what produced Avenue/Suite etc.) — should be rejected by sanitize
    /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*(?:[A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))\b/
  ];
  for (const re of locPatterns) {
    const m = corpus.match(re);
    if (!m) continue;
    let candidate = m[2] && String(m[2]).trim()
      ? `${m[1].trim()}, ${m[2].trim()}`
      : m[1].trim();
    out.push(candidate.replace(/,\s*,/g, ',').trim());
  }
  return out;
}

const DICT = {
  // Mirror curated dictionary entries used by the app (PIMCO has no dict location)
  'pimco.com': '',
  'stripe.com': 'San Francisco, CA',
  'fordham.edu': 'New York, NY'
};

async function enrichLocation(name, domain) {
  const page =
    (await fetchPageHtml(`https://${domain}/`)) ||
    (await fetchPageHtml(`https://www.${domain}/`)) ||
    '';
  const corpus = page
    ? `${extractMeta(page, 'description')} ${extractMeta(page, 'og:description')} ${stripHtmlToText(page).slice(0, 9000)}`
    : '';
  const rawCandidates = extractRawLocationCandidates(corpus);
  let scraped = 'Unknown';
  for (const c of rawCandidates) {
    const s = sanitizeLocationValue(c);
    if (s !== 'Unknown') {
      scraped = s;
      break;
    }
  }
  // Prefer valid scrape; else dictionary. Prefer City, Region over bare city.
  function preferLocation(scraped, dict) {
    const s = sanitizeLocationValue(scraped);
    const d = sanitizeLocationValue(dict);
    if (s === 'Unknown' && d === 'Unknown') return 'Unknown';
    if (s === 'Unknown') return d;
    if (d === 'Unknown') return s;
    if (d.includes(',') && !s.includes(',')) return d;
    if (s.includes(',') && !d.includes(',')) return s;
    return s;
  }
  const dictLoc = sanitizeLocationValue(DICT[domain] || '');
  const finalLoc = preferLocation(scraped, dictLoc);
  return { name, domain, rawCandidates: rawCandidates.slice(0, 8), scraped, dictLoc, location: finalLoc };
}

console.log('\n=== Live PIMCO / Stripe / Fordham ===');
const companies = [
  ['PIMCO', 'pimco.com'],
  ['Stripe', 'stripe.com'],
  ['Fordham University', 'fordham.edu']
];
for (const [name, domain] of companies) {
  const r = await enrichLocation(name, domain);
  const noisy = ['Prerna Gupta', 'Avenue', 'Suite', 'Jesuit', 'Catholic'].some((x) =>
    String(r.location).includes(x)
  );
  const ok = !noisy && (r.location === 'Unknown' || isValidLocationPlace(r.location));
  console.log(`\n${name}`);
  console.log(`  raw scrape hits: ${JSON.stringify(r.rawCandidates)}`);
  console.log(`  after sanitize scrape: ${r.scraped}`);
  console.log(`  dictionary fallback: ${r.dictLoc}`);
  console.log(`  FINAL Location: ${r.location}  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll location checks passed.');
