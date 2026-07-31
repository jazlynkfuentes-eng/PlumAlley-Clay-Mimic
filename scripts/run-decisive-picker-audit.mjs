/**
 * Decisive-candidate audit.
 *
 * Runs the rows that previously required manual Confirm and reports which ones are now
 * auto-resolved (one obviously-correct candidate) vs which correctly stay in the picker
 * (two or more genuinely plausible candidates).
 *
 * Usage: node scripts/run-decisive-picker-audit.mjs
 */
import fs from 'fs';
import {
  resolveHard,
  shouldAutoFound,
  candidateNameCloseness,
  evaluateDecisiveCandidate,
  isJunkCandidate,
  classifyFinanceAffinity,
  mapPool,
  CONFIDENCE_THRESHOLD,
  AUTO_FOUND_THRESHOLD
} from './lib/hard-sample-resolver.mjs';

// Every row that landed in the picker (or was flagged ambiguous) on the last live UI run,
// plus a few known same-name traps to confirm genuine ambiguity is preserved.
const ROWS = [
  'Willkie Farr & Gallagher LLP',
  "Children's Health System of Texas",
  'The Kresge Foundation',
  'MetLife Investment Management',
  'Illinois Municipal Retirement Fund',
  'Northside Capital Management LLC',
  'Angeles Wealth Management LLC',
  'Lakeview Capital Management',
  'Summit Rock Advisors',
  'Gilder Office for Growth',
  'dakota Marketplace',
  'UBS Hedge Fund Solutions',
  'IH International Advisors',
  'TSWII Capital Advisors',
  'Helios & Partners Limited',
  'Archer Asia – Rockhampton Management Limited',
  'Avala Global',
  'CANY Capital LLC',
  '100WF',
  'TIDE',
  "California Public Employees' Retirement System (CalPERS)",
  'Teachers Retirement System of Texas (TRS)',
  'State of Wisconsin Investment Board (SWIB)',
  "Los Angeles City Employees' Retirement System",
  'Securities and Exchange Commission',
  'Trinity Church Wall Street',
  'West Virginia University Foundation',
  'Charles Stewart Mott Foundation'
];

const results = await mapPool(ROWS, 4, async (name) => {
  let resolved = null;
  try {
    resolved = await resolveHard(name, { financeFilterActive: true });
  } catch (e) {
    return { name, error: String(e.message || e) };
  }
  if (!resolved?.domain) {
    return { name, status: 'unverified', reason: 'no candidates', pool: [] };
  }

  const auto = shouldAutoFound(resolved);
  const decisive = resolved.decisiveMatch || null;
  const score = Number(resolved.score) || 0;

  // Annotate the pool the way a human would read it
  const pool = (resolved.rankedPool?.length ? resolved.rankedPool : resolved.candidates || [])
    .slice(0, 5)
    .map((c) => {
      const nm = candidateNameCloseness(name, c);
      return {
        domain: c.domain,
        label: c.name && c.name !== c.domain ? c.name : '',
        score: c.totalScore ?? c.confidenceScore ?? null,
        closeness: nm.score,
        kind: nm.kind,
        context: classifyFinanceAffinity(c, name),
        dns: c.dnsOk === false ? 'dead' : 'live',
        junk: isJunkCandidate(c, nm.score)
      };
    });

  return {
    name,
    domain: resolved.domain,
    score,
    band: score >= AUTO_FOUND_THRESHOLD ? '80+' : (score >= CONFIDENCE_THRESHOLD ? '70-79' : `<${CONFIDENCE_THRESHOLD}`),
    status: auto ? 'auto-resolved' : 'picker',
    via: decisive ? decisive.rule : (auto ? 'score/threshold' : 'needs confirm'),
    detail: decisive ? decisive.detail : (resolved.ambiguous ? 'ambiguous: rivals too close' : ''),
    ambiguous: !!resolved.ambiguous,
    pool
  };
});

const autoByDecisive = results.filter(r => r.status === 'auto-resolved' && r.via !== 'score/threshold');
const autoByScore = results.filter(r => r.status === 'auto-resolved' && r.via === 'score/threshold');
const stayPicker = results.filter(r => r.status === 'picker' || r.status === 'unverified');

const fmtPool = (pool) => pool
  .map(c => `${c.domain}${c.label ? ` (${c.label})` : ''} [name ${c.closeness}/${c.kind}, ${c.context}, ${c.dns}${c.junk ? ', junk' : ''}, score ${c.score}]`)
  .join('\n         ');

console.log('='.repeat(78));
console.log(`AUTO-RESOLVED BY DECISIVENESS (${autoByDecisive.length}) — no Confirm needed`);
console.log('='.repeat(78));
autoByDecisive.forEach((r, i) => {
  console.log(`\n${i + 1}. ${r.name}`);
  console.log(`   -> ${r.domain}  (score ${r.score}, band ${r.band})`);
  console.log(`   rule: ${r.via} — ${r.detail}`);
  console.log(`   pool: ${fmtPool(r.pool)}`);
});

console.log('\n' + '='.repeat(78));
console.log(`ALREADY AUTO VIA SCORE (${autoByScore.length}) — unchanged behaviour`);
console.log('='.repeat(78));
autoByScore.forEach(r => console.log(`   ${r.name} -> ${r.domain} (score ${r.score})`));

console.log('\n' + '='.repeat(78));
console.log(`STAYS IN PICKER (${stayPicker.length}) — genuine ambiguity, human decides`);
console.log('='.repeat(78));
stayPicker.forEach((r, i) => {
  console.log(`\n${i + 1}. ${r.name}`);
  console.log(`   top: ${r.domain || '(none)'}  (score ${r.score ?? 0}, band ${r.band || 'n/a'})`);
  console.log(`   why: ${r.detail || r.reason || 'no decisive signal'}`);
  console.log(`   pool: ${fmtPool(r.pool || [])}`);
});

// Rule 2 and rule 3 depend on pool shapes that vary run to run, so probe them directly
// against candidate lists in the shape the live resolver produces.
const PROBES = [
  {
    // Winner's name is only a partial match, so the industry context has to decide
    label: 'context: finance firm vs bakery + hospital',
    company: 'Meridian Capital Advisors',
    expect: 'auto',
    expectRule: 'context-match',
    pool: [
      { domain: 'mcadvisors.com', name: 'Meridian Capital', snippet: 'investment management', totalScore: 71, dnsOk: true },
      { domain: 'meridianbakery.com', name: 'Meridian Bakery', snippet: 'bakery and cafe', totalScore: 66, dnsOk: true },
      { domain: 'meridianhealth.org', name: 'Meridian Health', snippet: 'hospital', totalScore: 64, dnsOk: true }
    ]
  },
  {
    // Winner's name is only a partial match, so being the one real site has to decide
    label: 'junk: one real site vs parked + directory + dead',
    company: 'Braxton Ridge Partners',
    expect: 'auto',
    expectRule: 'sole-legit',
    pool: [
      { domain: 'brpadvisors.com', name: 'Braxton Ridge Partners Advisors', totalScore: 58, dnsOk: true },
      { domain: 'hugedomains.com', name: 'braxtonridge is for sale', totalScore: 55, dnsOk: true },
      { domain: 'linkedin.com', name: 'Braxton Ridge Partners | LinkedIn', totalScore: 52, dnsOk: true },
      { domain: 'braxtonridgellc.net', name: 'Braxton Ridge LLC', totalScore: 50, dnsOk: false }
    ]
  },
  {
    label: 'ambiguity kept: two real firms sharing the exact same name',
    company: 'Sterling Partners',
    expect: 'picker',
    pool: [
      { domain: 'sterlingpartners.com', name: 'Sterling Partners', snippet: 'private equity firm', totalScore: 74, dnsOk: true },
      { domain: 'sterling-partners.com', name: 'Sterling Partners LLP', snippet: 'financial advisory', totalScore: 71, dnsOk: true }
    ]
  },
  {
    label: 'ambiguity kept: same brand, two live finance sites',
    company: 'Ardent Advisors',
    expect: 'picker',
    pool: [
      { domain: 'ardent.com', name: 'Ardent Advisors', snippet: 'wealth management', totalScore: 72, dnsOk: true },
      { domain: 'ardentadvisors.com', name: 'Ardent Advisors LLC', snippet: 'financial advisory', totalScore: 70, dnsOk: true }
    ]
  },
  {
    label: 'blocked: winner page does not mention the company',
    company: 'Corbin Wells Capital',
    expect: 'picker',
    pool: [
      { domain: 'corbinwells.com', name: 'Corbin Wells', totalScore: 70, dnsOk: true, contentMention: false },
      { domain: 'corbinwellsgroup.com', name: 'Corbin Wells Group', totalScore: 60, dnsOk: true }
    ]
  }
];

console.log('\n' + '='.repeat(78));
console.log('RULE COVERAGE PROBES (context match / junk filter / ambiguity guard)');
console.log('='.repeat(78));
let probeFails = 0;
for (const p of PROBES) {
  const d = evaluateDecisiveCandidate(p.company, p.pool, { financeFilterActive: true });
  const got = d ? 'auto' : 'picker';
  const ok = got === p.expect && (!p.expectRule || d?.rule === p.expectRule);
  if (!ok) probeFails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${p.label}`);
  console.log(`      ${p.company} -> ${d ? `${d.domain} (${d.rule}: ${d.detail})` : 'stays in picker'}`);
}

console.log('\n' + '='.repeat(78));
console.log(`SUMMARY: ${autoByDecisive.length} newly auto-resolved · ${autoByScore.length} already auto · ${stayPicker.length} still picker (of ${results.length})`);
console.log(`PROBES: ${PROBES.length - probeFails}/${PROBES.length} passed`);
console.log('='.repeat(78));

fs.writeFileSync(
  new URL('./last-decisive-picker-audit.json', import.meta.url),
  JSON.stringify({ summary: { autoByDecisive: autoByDecisive.length, autoByScore: autoByScore.length, picker: stayPicker.length, total: results.length }, results }, null, 2)
);
