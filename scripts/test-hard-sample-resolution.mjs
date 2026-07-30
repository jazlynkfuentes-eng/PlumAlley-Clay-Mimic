#!/usr/bin/env node
/**
 * Regression test: resolve every company in fixtures/hard-sample-resolution.json
 * and report pass/fail + overall top-1 accuracy.
 *
 * Usage:
 *   node scripts/test-hard-sample-resolution.mjs
 *   npm run test:hard-sample
 *
 * Exit code 1 if top-1 accuracy falls below fixture.baseline.top1MinPercent.
 */
import {
  loadHardSampleFixture,
  resolveHard,
  domainMatches,
  mapPool
} from './lib/hard-sample-resolver.mjs';

const fixture = loadHardSampleFixture();
const companies = fixture.companies;
const minPercent = Number(fixture.baseline?.top1MinPercent ?? 85);

console.log(`Hard-sample resolution regression (${companies.length} companies)`);
console.log(`Fixture: fixtures/hard-sample-resolution.json`);
console.log(`Baseline floor: ${minPercent}% top-1 accuracy\n`);

const results = await mapPool(companies, 3, async (row) => {
  const resolved = await resolveHard(row.name);
  const expected = row.expectedDomain || row.domain;
  const aliases = row.aliases || [];
  const got = resolved.domain || '';
  const pass = !!(got && domainMatches(got, expected, aliases));
  return {
    name: row.name,
    category: row.category || '',
    expected,
    got: got || '(none)',
    score: resolved.score ?? 0,
    confidence: resolved.confidence || 'none',
    ambiguous: !!resolved.ambiguous,
    sources: (resolved.sources || []).join('+') || '-',
    candidates: (resolved.candidates || []).length,
    pass
  };
});

const passes = results.filter(r => r.pass);
const fails = results.filter(r => !r.pass);
const accuracy = results.length ? (passes.length / results.length) * 100 : 0;

console.log('--- Per company ---');
for (const r of results) {
  const mark = r.pass ? 'PASS' : 'FAIL';
  const amb = r.ambiguous ? ' ambiguous' : '';
  console.log(
    `[${mark}] ${r.name}\n` +
    `        expected=${r.expected} got=${r.got} score=${r.score} conf=${r.confidence}${amb} src=${r.sources}`
  );
}

console.log('\n=== SUMMARY ===');
console.log(`Passed: ${passes.length}/${results.length}`);
console.log(`Failed: ${fails.length}/${results.length}`);
console.log(`Top-1 accuracy: ${accuracy.toFixed(1)}%`);

if (fails.length) {
  console.log('\nFailures:');
  for (const r of fails) {
    console.log(`  - ${r.name}: expected ${r.expected}, got ${r.got}`);
  }
}

const byCat = {};
for (const r of results) {
  const cat = r.category || 'other';
  if (!byCat[cat]) byCat[cat] = { n: 0, pass: 0 };
  byCat[cat].n++;
  if (r.pass) byCat[cat].pass++;
}
console.log('\nBy category:');
for (const [cat, v] of Object.entries(byCat)) {
  console.log(`  ${cat}: ${v.pass}/${v.n} (${((v.pass / v.n) * 100).toFixed(0)}%)`);
}

if (accuracy + 1e-9 < minPercent) {
  console.error(`\nREGRESSION: top-1 accuracy ${accuracy.toFixed(1)}% is below baseline ${minPercent}%`);
  process.exit(1);
}

console.log(`\nOK — at or above baseline (${minPercent}%).`);
process.exit(0);
