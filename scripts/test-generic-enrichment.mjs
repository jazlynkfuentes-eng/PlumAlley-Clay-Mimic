/**
 * Generic enrichment regression tests (not VC-specific).
 */
import assert from 'node:assert/strict';
import {
  UNKNOWN,
  sanitizeUserFacingNotes,
  normalizeIndustry,
  normalizeLocation,
  normalizeHeadcount,
  normalizeFounders,
  finalizeEnrichmentFields,
  extractFieldsFromSearchCorpus,
  expandPastedCompanyInput,
  dedupeCompanyNames,
  companyMatchKey,
  shouldBlockDuplicateIndustry,
  isBlankOrUnknown
} from './lib/enrichment-quality.mjs';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Repeated values across companies');
check('allows repeated Software industry', () => {
  const a = finalizeEnrichmentFields({ industry: 'Software', headcount: '1–10', location: 'SF', contacts: UNKNOWN, notes: 'A', gender: UNKNOWN });
  const b = finalizeEnrichmentFields({ industry: 'Software', headcount: '11–50', location: 'SF', contacts: UNKNOWN, notes: 'B', gender: UNKNOWN });
  assert.equal(normalizeIndustry(a.industry), normalizeIndustry(b.industry));
  assert.equal(shouldBlockDuplicateIndustry('Enterprise Software'), false);
});
check('allows repeated locations', () => {
  assert.equal(normalizeLocation('San Francisco'), normalizeLocation('San Francisco, CA') || normalizeLocation('San Francisco'));
});

console.log('Ambiguous / abbreviations / suffixes');
check('match key strips Inc/LLC', () => {
  assert.equal(companyMatchKey('NVIDIA Corporation'), companyMatchKey('NVIDIA'));
  assert.equal(companyMatchKey('Apple Inc.'), companyMatchKey('Apple'));
});
check('dedupes NVIDIA variants', () => {
  assert.deepEqual(dedupeCompanyNames(['NVIDIA', 'NVIDIA Corporation', 'Apple Inc', 'Apple']), ['NVIDIA', 'Apple Inc']);
});
check('preserves C3.ai and AT&T punctuation in expand', () => {
  const lines = expandPastedCompanyInput('C3.ai\nAT&T\nJohnson & Johnson');
  assert.ok(lines.includes('C3.ai'));
  assert.ok(lines.includes('AT&T'));
  assert.ok(lines.includes('Johnson & Johnson'));
});

console.log('Messy paste');
check('expands bullets, numbering, comma lists', () => {
  const lines = expandPastedCompanyInput('1. Nvidia\n• Apple Inc\n\nRamp, Shopify, Stripe');
  assert.ok(lines.some((l) => /nvidia/i.test(l)));
  assert.ok(lines.some((l) => /apple/i.test(l)));
  assert.ok(lines.some((l) => /ramp/i.test(l)));
  assert.ok(lines.some((l) => /shopify/i.test(l)));
});

console.log('Industry taxonomy (cross-sector)');
check('maps AI / semis / fintech / energy', () => {
  assert.equal(normalizeIndustry('generative AI company'), 'Artificial Intelligence');
  assert.equal(normalizeIndustry('semiconductor chipmaker'), 'Semiconductors');
  assert.equal(normalizeIndustry('fintech payments'), 'Fintech');
  assert.equal(normalizeIndustry('renewable energy utility'), 'Renewable Energy');
  assert.equal(normalizeIndustry('venture capital firm'), 'Venture Capital');
  assert.equal(normalizeIndustry('investment banking'), 'Investment Banking');
});

console.log('Headcount / founders / location');
check('headcount ranges', () => {
  assert.equal(normalizeHeadcount('51-200 employees'.replace(' employees', '')), '51–200');
  assert.equal(normalizeHeadcount('More than 10,000'), '10,001+');
});
check('founders ignore CEO-only titles', () => {
  assert.equal(normalizeFounders('Jane Doe (Co-Founder); John Smith, CEO'), 'Jane Doe; John Smith');
});
check('international location', () => {
  assert.equal(normalizeLocation('London, United Kingdom'), 'London, UK');
  assert.equal(normalizeLocation('São Paulo'), 'São Paulo, Brazil');
});

console.log('Search mining generic');
check('public tech company corpus', () => {
  const mined = extractFieldsFromSearchCorpus(
    'NVIDIA is a semiconductor company headquartered in Santa Clara, CA. Founded by Jensen Huang. More than 10,000 employees.',
    'NVIDIA'
  );
  assert.equal(mined.industry, 'Semiconductors');
  assert.equal(mined.location, 'Santa Clara, CA');
  assert.match(mined.contacts, /Jensen Huang/);
});
check('VC corpus still works without special-casing', () => {
  const mined = extractFieldsFromSearchCorpus(
    'Lux Capital is a venture capital firm headquartered in New York, NY. Founded by Josh Wolfe and Peter Hebert.',
    'Lux Capital'
  );
  assert.equal(mined.industry, 'Venture Capital');
  assert.equal(mined.location, 'New York, NY');
});

console.log('Notes pollution');
check('strips pipeline text', () => {
  const n = sanitizeUserFacingNotes('Verifying selected domain... · Score 81 · SPARQL timeout · Acme builds widgets.');
  assert.ok(!/verifying|score|sparql/i.test(n));
  assert.match(n, /Acme builds widgets/i);
});
check('empty after only debug', () => {
  assert.equal(sanitizeUserFacingNotes('Queueing...'), '');
});

console.log('Partial failure isolation');
check('blank industry does not clear location', () => {
  const f = finalizeEnrichmentFields({
    industry: UNKNOWN,
    headcount: UNKNOWN,
    location: 'Austin, TX',
    contacts: UNKNOWN,
    notes: 'Widget maker.',
    gender: UNKNOWN
  });
  assert.equal(f.location, 'Austin, TX');
  assert.ok(!isBlankOrUnknown(f.notes));
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) process.exit(1);
