/**
 * Harder-sample website resolution audit (verbose status breakdown).
 * Uses the permanent fixture at fixtures/hard-sample-resolution.json.
 *
 * For a simple pass/fail regression check, prefer:
 *   npm run test:hard-sample
 */
import {
  loadHardSampleFixture,
  resolveHard,
  domainMatches,
  mapPool
} from './lib/hard-sample-resolver.mjs';

const fixture = loadHardSampleFixture();
const HARD_SAMPLE = fixture.companies.map((c) => ({
  name: c.name,
  domain: c.expectedDomain,
  aliases: c.aliases || [],
  category: c.category || ''
}));

console.log(`Hard-sample resolution audit: ${HARD_SAMPLE.length} companies (from fixture)\n`);

const results = await mapPool(HARD_SAMPLE, 3, async (row) => {
  const resolved = await resolveHard(row.name);
  const hasCandidates = (resolved.candidates || []).length > 0;
  const match = resolved.domain && domainMatches(resolved.domain, row.domain, row.aliases);
  let status;
  if (!resolved.domain && !hasCandidates) status = 'unverified';
  else if (resolved.confidence === 'high' && match && resolved.dnsOk !== false) status = 'found';
  else if (hasCandidates) status = 'potential';
  else status = 'unverified';

  return {
    name: row.name,
    category: row.category,
    expected: row.domain,
    got: resolved.domain || '',
    score: resolved.score,
    confidence: resolved.confidence,
    sources: (resolved.sources || []).join('+') || '-',
    status,
    match: !!match,
    candidates: (resolved.candidates || []).length
  };
});

const found = results.filter(r => r.status === 'found');
const potential = results.filter(r => r.status === 'potential');
const unverified = results.filter(r => r.status === 'unverified');
const foundCorrect = found.filter(r => r.match);
const foundRate = results.length ? (foundCorrect.length / results.length) * 100 : 0;
const pickerCoverage = results.filter(r => r.candidates > 0 || r.status === 'found').length;
const correctTop = results.filter(r => r.match).length;

console.log('--- Per company ---');
for (const r of results) {
  const mark = r.status === 'found' && r.match ? '✓' : r.status === 'potential' ? '~' : '✗';
  console.log(
    `${mark} [${r.category}] ${r.name}\n` +
    `    expected=${r.expected} got=${r.got || '(none)'} score=${r.score} conf=${r.confidence} src=${r.sources} status=${r.status} cands=${r.candidates}`
  );
}

console.log('\n=== HARD SAMPLE SUMMARY ===');
console.log(`Total: ${results.length}`);
console.log(`Found & Verified (correct + confident + DNS): ${foundCorrect.length}/${results.length} (${foundRate.toFixed(1)}%)`);
console.log(`Top-1 correct (any confidence): ${correctTop}/${results.length} (${((correctTop / results.length) * 100).toFixed(1)}%)`);
console.log(`Potential (picker fallback): ${potential.length}`);
console.log(`Unverified (no candidates): ${unverified.length}`);
console.log(`Picker coverage (any candidates or found): ${pickerCoverage}/${results.length}`);

const byCat = {};
for (const r of results) {
  if (!byCat[r.category]) byCat[r.category] = { n: 0, found: 0, top1: 0 };
  byCat[r.category].n++;
  if (r.status === 'found' && r.match) byCat[r.category].found++;
  if (r.match) byCat[r.category].top1++;
}
console.log('\nBy category (Found & Verified / Top-1 correct):');
for (const [cat, v] of Object.entries(byCat)) {
  console.log(`  ${cat}: found ${v.found}/${v.n} (${((v.found / v.n) * 100).toFixed(0)}%) · top-1 ${v.top1}/${v.n} (${((v.top1 / v.n) * 100).toFixed(0)}%)`);
}
