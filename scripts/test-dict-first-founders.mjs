/**
 * Confirm dict-first enrichment returns Cara Advisory / Disciplina founders.
 */
import fs from 'fs';
import vm from 'vm';
import { pathToFileURL } from 'url';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Extract companyDictionary object literal
const dictStart = html.indexOf('const companyDictionary = {');
const dictEnd = html.indexOf('\n    };', dictStart) + '\n    };'.length;
const dictBlock = html.slice(dictStart, dictEnd);

// Build a minimal sandbox with the helpers we need from index.html
const sandbox = {
  console,
  Set,
  Map,
  fetch,
  UNKNOWN: 'Unknown',
  companyDictionary: null,
  enrichCache: new Map(),
  enrichmentValueRegistry: {
    industry: new Map(),
    contacts: new Map(),
    notes: new Map()
  },
  resolveCache: new Map(),
  verifyCache: new Map()
};
vm.createContext(sandbox);

vm.runInContext(dictBlock + '\nthis.companyDictionary = companyDictionary;', sandbox);

function extractBetween(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  if (a < 0) throw new Error('missing ' + startMarker);
  const b = html.indexOf(endMarker, a);
  if (b < 0) throw new Error('missing end ' + endMarker);
  return html.slice(a, b);
}

// Pull dependency helpers in order
const chunks = [];
chunks.push(`
function isBlankOrUnknown(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return !s || s === '-' || /^unknown$/i.test(s) || /^needs manual/i.test(s) || /^needs verification/i.test(s);
}
function cleanName(name) {
  return String(name||'').trim().toLowerCase().replace(/[,.]\\s*(inc|llc|co|corp|ltd|gmbh)\\b/gi, '').trim();
}
function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function normalizeEnrichValue(v) {
  return String(v || '').trim().toLowerCase().replace(/\\s+/g, ' ');
}
`);

chunks.push(extractBetween('const PIPELINE_NOTES_RE =', 'const US_STATE_OR_PROVINCE = new Set(['));

// Location validators through preferLocation
const locBlock = extractBetween('const US_STATE_OR_PROVINCE = new Set([', 'function applyBatchUniquenessGuard');
chunks.push(locBlock);

// uniqueness + strip/meta/extract not fully needed if we mock scrape as Unknown
chunks.push(`
function applyBatchUniquenessGuard(domain, fields) {
  const out = { ...fields };
  if (isBlankOrUnknown(out.headcount)) out.headcount = UNKNOWN;
  out.location = sanitizeLocationValue(out.location);
  if (isBlankOrUnknown(out.gender)) out.gender = UNKNOWN;
  if (isBlankOrUnknown(out.contacts)) out.contacts = UNKNOWN;
  if (isBlankOrUnknown(out.industry)) out.industry = UNKNOWN;
  return out;
}
async function lookupWikidataEntityType() { return null; }
async function lookupWikidataCompanyFacts() {
  return { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, gender: UNKNOWN, notes: UNKNOWN, founderGenders: [], provenance: {} };
}
function lookupMajorKnownFirm() { return null; }
async function fetchPageHtml() { return null; }
function extractEnrichmentFromHtml() {
  return { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, gender: UNKNOWN, notes: UNKNOWN, source: 'none' };
}
async function enrichMissingViaSearch(_name, _domain, current) { return current; }
`);

// lookup + enrich functions
const lookupStart = html.indexOf('function lookupDictionaryByDomain(domain)');
const enrichEnd = html.indexOf('// --- CUSTOM SVG ICON COMPONENTS ---', lookupStart);
chunks.push(html.slice(lookupStart, enrichEnd));

vm.runInContext(chunks.join('\n') + `
this.lookupDictionaryEntry = lookupDictionaryEntry;
this.enrichCompanyDetails = enrichCompanyDetails;
this.preferDictThenScrape = preferDictThenScrape;
`, sandbox);

const cases = [
  ['Cara Advisory', 'caraadvisory.com', 'Alana Mag'],
  ['Disciplina Capital Management', 'disciplina.com', 'Alena Kuprevich']
];

let failed = 0;
for (const [name, domain, expectSubstr] of cases) {
  const entry = sandbox.lookupDictionaryEntry(domain, name);
  console.log(`\n${name}`);
  console.log('  dict entry founder:', entry?.founder || '(none)');
  const details = await sandbox.enrichCompanyDetails(domain, name, null);
  console.log('  enrichSource:', details.enrichSource);
  console.log('  Founders:', details.contacts);
  console.log('  Industry:', details.industry);
  console.log('  Location:', details.location);
  const ok = String(details.contacts || '').includes(expectSubstr);
  console.log(ok ? '  PASS' : '  FAIL');
  if (!ok) failed++;
}

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}

const apple = await sandbox.enrichCompanyDetails('apple.com', 'Apple', null);
const appleFounders = String(apple.contacts || '');
const appleOk = !/Tim Cook/i.test(appleFounders);
console.log('\nApple (CEO must not be treated as founder)');
console.log('  dict entry founder:', sandbox.lookupDictionaryEntry('apple.com', 'Apple')?.founder || '(none)');
console.log('  Founders:', appleFounders || '(blank)');
console.log('  Gender:', apple.gender);
console.log(appleOk ? '  PASS' : '  FAIL');
if (!appleOk) process.exit(1);

console.log('\nDictionary founders appear correctly for Cara Advisory and Disciplina.');
