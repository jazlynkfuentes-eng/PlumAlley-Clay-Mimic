/**
 * Enrichment quality tests — updated for generic (non-VC-specific) pipeline.
 */
import assert from 'node:assert/strict';
import {
  UNKNOWN,
  sanitizeUserFacingNotes,
  normalizeIndustry,
  normalizeLocation,
  normalizeHeadcount,
  normalizeFounders,
  shouldBlockDuplicateIndustry,
  finalizeEnrichmentFields,
  extractFieldsFromSearchCorpus
} from './lib/enrichment-quality.mjs';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('1. Well-known company');
check('normalizes VC industry', () => assert.equal(normalizeIndustry('venture capital firm'), 'Venture Capital'));
check('normalizes NYC location', () => assert.equal(normalizeLocation('NYC'), 'New York, NY'));
check('extracts founders + HQ', () => {
  const mined = extractFieldsFromSearchCorpus(
    'Lux Capital is a venture capital firm headquartered in New York, NY. Founded by Josh Wolfe and Peter Hebert. The firm has 51–200 employees.',
    'Lux Capital'
  );
  assert.equal(mined.industry, 'Venture Capital');
  assert.equal(mined.location, 'New York, NY');
  assert.match(mined.contacts, /Josh Wolfe/);
});

console.log('2. Climate / renewable');
check('climate investing → energy/renewable (not VC-only label)', () => {
  const mined = extractFieldsFromSearchCorpus(
    'Acme Energy is a renewable energy company that builds climate tech and renewable energy systems for the energy transition.',
    'Acme Energy'
  );
  assert.ok(
    mined.industry === 'Renewable Energy' || mined.industry === 'Energy',
    `got ${mined.industry}`
  );
  assert.notEqual(mined.industry, 'Venture Capital');
});

console.log('3. Ambiguous name');
check('does not invent founders', () => {
  assert.equal(extractFieldsFromSearchCorpus('M13 is a company.', 'M13').contacts, UNKNOWN);
});

console.log('4–5. Search / wiki style');
check('VC from corpus', () => {
  assert.equal(
    extractFieldsFromSearchCorpus('Type One Ventures is an early-stage VC firm.', 'Type One Ventures').industry,
    'Venture Capital'
  );
});
check('HQ phrasing', () => {
  assert.equal(
    extractFieldsFromSearchCorpus('DCVC is headquartered in San Francisco, CA.', 'DCVC').location,
    'San Francisco, CA'
  );
});

console.log('6. Headcount ranges');
check('maps ranges', () => {
  assert.equal(normalizeHeadcount('11-50'), '11–50');
  assert.equal(normalizeHeadcount('75'), '51–200');
});

console.log('7. Multiple founders');
check('strips titles', () => assert.equal(normalizeFounders('Jane Smith (Co-Founder); John Doe, CEO'), 'Jane Smith; John Doe'));

console.log('8. International');
check('UK normalize', () => assert.equal(normalizeLocation('London, United Kingdom'), 'London, UK'));

console.log('9. Repeated industries allowed');
check('no uniqueness blanking', () => {
  assert.equal(shouldBlockDuplicateIndustry('Venture Capital'), false);
  const a = finalizeEnrichmentFields({ industry: 'Enterprise Software', headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: 'a', gender: UNKNOWN });
  const b = finalizeEnrichmentFields({ industry: 'Enterprise Software', headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: 'b', gender: UNKNOWN });
  assert.equal(a.industry, 'Enterprise Software');
  assert.equal(b.industry, 'Enterprise Software');
});

console.log('10. Obscure → Unknown');
check('empty corpus', () => {
  const mined = extractFieldsFromSearchCorpus('', 'Zzzyx Unicorn LLC');
  assert.equal(mined.industry, UNKNOWN);
});

console.log('11. Notes leak');
check('strips verifying/scores', () => {
  const cleaned = sanitizeUserFacingNotes('Verifying selected domain... · Search score 81 · Early-stage VC focused on space.');
  assert.ok(!/verifying selected domain/i.test(cleaned));
  assert.match(cleaned, /Early-stage VC/i);
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) process.exit(1);
