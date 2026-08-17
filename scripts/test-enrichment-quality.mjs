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
  extractFieldsFromSearchCorpus,
  isExecTitleNotFounder,
  genderFromWikidataQid,
  summarizeFoundingTeamGender,
  extractInfoboxFounderNames,
  scoreWikipediaTitleForCompany,
  FOUNDERS_PIPELINE_VERSION,
  collectNameVariants,
  extractInfoboxMeta,
  scoreWikipediaPageAgainstResolved,
  classifyFounderListCompleteness,
  founderListCompletenessDetail,
  genderForFoundingTeamScreen,
  applyScreenedFoundingTeamGender,
  extractExplicitFoundedByNames,
  extractFounderTitleBios,
  mergeOfficialSiteFounders,
  classifyFoundersUnknownStatus,
  weightedWikiMismatchScore
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

console.log('12. Founder vs current exec + founding-team gender');
check('rejects CEO-only dictionary values', () => {
  assert.equal(isExecTitleNotFounder('Tim Cook (CEO)'), true);
  assert.equal(isExecTitleNotFounder('Martha E. Pollack (President)'), true);
  assert.equal(isExecTitleNotFounder('David Gilder (Partner)'), true);
});
check('keeps explicit founder attributions', () => {
  assert.equal(isExecTitleNotFounder('Deborah Jackson (Founder & CEO)'), false);
  assert.equal(isExecTitleNotFounder('Alena Kuprevich (Founding Partner)'), false);
  assert.equal(isExecTitleNotFounder('Alana Mag'), false);
  assert.equal(isExecTitleNotFounder('Davida Herzl (Founder & CEO)'), false);
});
check('maps Wikidata P21 female/male', () => {
  assert.equal(genderFromWikidataQid('http://www.wikidata.org/entity/Q6581072'), 'Female');
  assert.equal(genderFromWikidataQid('Q6581097'), 'Male');
  assert.equal(genderFromWikidataQid('Q1052281'), 'Female');
  assert.equal(genderFromWikidataQid(''), UNKNOWN);
});
check('at least one woman stays Female even if co-founders are unknown', () => {
  assert.equal(summarizeFoundingTeamGender(['Female', UNKNOWN]), 'Female');
  assert.equal(summarizeFoundingTeamGender(['Female', 'Male']), 'Female / Male');
});
check('does not mark Male when the founder list may be incomplete', () => {
  assert.equal(summarizeFoundingTeamGender(['Male', UNKNOWN]), UNKNOWN);
  assert.equal(summarizeFoundingTeamGender(['Male', 'Male']), 'Male');
  assert.equal(summarizeFoundingTeamGender([]), UNKNOWN);
});

console.log('13. Wikipedia infobox founders (lead paragraph is not enough)');
check('reads Unbulleted list wikilinks', () => {
  const names = extractInfoboxFounderNames(
    '{{Infobox company\n| name = Apple\n| founders = {{Unbulleted list | [[Steve Jobs]] | [[Steve Wozniak]] | [[Ronald Wayne]]}}\n| hq = Cupertino\n}}'
  );
  assert.deepEqual(names, ['Steve Jobs', 'Steve Wozniak', 'Ronald Wayne']);
});
check('reads ubl template', () => {
  const names = extractInfoboxFounderNames('| founder = {{Ubl|[[Bill Gates]]|[[Paul Allen]]}}\n| industry = Software\n');
  assert.deepEqual(names, ['Bill Gates', 'Paul Allen']);
});
check('ignores lead text without infobox field', () => {
  assert.deepEqual(extractInfoboxFounderNames('Apple Inc. is an American company founded in 1976.'), []);
});
check('scores company titles and rejects films', () => {
  assert.ok(scoreWikipediaTitleForCompany('Apple Inc.', 'Apple') >= 25);
  assert.ok(scoreWikipediaTitleForCompany('Nvidia', 'NVIDIA') >= 25);
  assert.ok(scoreWikipediaTitleForCompany('Ramp (company)', 'Ramp') >= 25);
  assert.ok(scoreWikipediaTitleForCompany('Apple (film)', 'Apple') < 0);
});

console.log('14. Wikipedia disambiguation guard');
check('cache version is founders-v10', () => {
  assert.equal(FOUNDERS_PIPELINE_VERSION, 'founders-v10');
});
check('collects parenthetical aka variants', () => {
  assert.deepEqual(
    collectNameVariants('State Street (STT)', ['State Street Corporation']),
    ['STT', 'State Street', 'State Street Corporation']
  );
});
check('accepts Apple Inc. against consumer electronics in Cupertino', () => {
  const wikitext = `{{Infobox company
| name = Apple Inc.
| industry = [[Consumer electronics]], [[Software]]
| founded = April 1, 1976
| headquarters = [[Cupertino, California]]
| founders = {{Unbulleted list | [[Steve Jobs]] | [[Steve Wozniak]]}}
}}`;
  const r = scoreWikipediaPageAgainstResolved(
    { title: 'Apple Inc.', wikitext },
    { companyName: 'Apple', industry: 'Consumer', location: 'Cupertino, CA' }
  );
  assert.equal(r.ok, true);
  assert.ok(r.nameMatchKind === 'exact' || r.nameMatchKind === 'near-exact');
});
check('skips a film page even if the brand matches', () => {
  const r = scoreWikipediaPageAgainstResolved(
    { title: 'Apple (film)', wikitext: '| industry = Film\n| founded = 1980\n' },
    { companyName: 'Apple', industry: 'Consumer', location: 'Cupertino, CA' }
  );
  assert.equal(r.ok, false);
});
check('skips when industry and HQ both disagree', () => {
  const r = scoreWikipediaPageAgainstResolved(
    { title: 'Ramp (company)', wikitext: '| industry = Skateboards\n| headquarters = Venice, CA\n| founded = 1986\n' },
    { companyName: 'Ramp', industry: 'Fintech', location: 'New York, NY', foundedYear: 2019 }
  );
  assert.equal(r.ok, false);
  assert.ok(r.weightedMismatchScore >= 3);
  assert.ok(r.reasons.some((x) => /low confidence match/i.test(x)));
});
check('HQ + founded-year only stays below the weighted skip threshold', () => {
  const r = scoreWikipediaPageAgainstResolved(
    { title: 'Ramp (company)', wikitext: '| industry = Fintech\n| headquarters = Venice, CA\n| founded = 1986\n' },
    { companyName: 'Ramp', industry: 'Fintech', location: 'New York, NY', foundedYear: 2019 }
  );
  assert.equal(r.ok, true);
  assert.ok(r.weightedMismatchScore < 3);
});
check('industry + founded-year reaches the weighted skip threshold', () => {
  const r = scoreWikipediaPageAgainstResolved(
    { title: 'Ramp (company)', wikitext: '| industry = Skateboards\n| founded = 1986\n' },
    { companyName: 'Ramp', industry: 'Fintech', foundedYear: 2019 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.weightedMismatchScore, 3);
});
check('weightedWikiMismatchScore uses industry 2 / HQ 1.5 / founded 1', () => {
  const w = weightedWikiMismatchScore(['industry', 'location', 'founded']);
  assert.equal(w.weightedScore, 4.5);
  assert.equal(w.overThreshold, true);
});
check('reads infobox industry and founded year', () => {
  const meta = extractInfoboxMeta('| industry = [[Software]]\n| founded = 1975\n| headquarters = [[Redmond, Washington]]\n');
  assert.match(meta.industry, /Software/i);
  assert.equal(meta.foundedYear, 1975);
});

console.log('15. Founding-team completeness + gender screen');
check('identical infobox and P112 is complete', () => {
  assert.equal(
    classifyFounderListCompleteness(['Bill Gates', 'Paul Allen'], ['Bill Gates', 'Paul Allen']),
    'complete'
  );
});
check('P112 subset is partial', () => {
  assert.equal(
    classifyFounderListCompleteness(
      ['Steve Jobs', 'Steve Wozniak', 'Ronald Wayne'],
      ['Steve Wozniak', 'Ronald Wayne']
    ),
    'partial'
  );
});
check('one Wikipedia source only is partial', () => {
  assert.equal(classifyFounderListCompleteness(['Jensen Huang'], []), 'partial');
});
check('records specific partial reasons', () => {
  assert.equal(founderListCompletenessDetail([], ['Paul Allen']).completenessReason, 'infobox_empty');
  assert.equal(founderListCompletenessDetail(['Bill Gates'], []).completenessReason, 'p112_empty');
  const counts = founderListCompletenessDetail(
    ['Steve Jobs', 'Steve Wozniak', 'Ronald Wayne'],
    ['Steve Wozniak']
  );
  assert.equal(counts.completenessReason, 'count_mismatch');
  assert.equal(counts.completenessReasonDetail, 'infobox: 3, P112: 1');
  const none = founderListCompletenessDetail(['Ada Lovelace'], ['Grace Hopper']);
  assert.equal(none.completenessReason, 'no_overlap');
});
check('partial all-male never auto-skips', () => {
  assert.equal(genderForFoundingTeamScreen(['Male', 'Male'], 'partial'), UNKNOWN);
});
check('complete all-male can auto-skip', () => {
  assert.equal(genderForFoundingTeamScreen(['Male', 'Male'], 'complete'), 'Male');
});
check('partial list with a woman still keeps Female', () => {
  assert.equal(genderForFoundingTeamScreen(['Female', 'Male'], 'partial'), 'Female / Male');
  assert.equal(genderForFoundingTeamScreen(['Female'], 'partial'), 'Female');
});
check('non-Wikipedia completeness none does not override Male', () => {
  assert.equal(genderForFoundingTeamScreen(['Male', 'Male'], 'none'), 'Male');
});
check('learned gender short-circuit runs before the guard and does not change the guard function', () => {
  const blocked = applyScreenedFoundingTeamGender(['Male', 'Male'], 'partial');
  assert.equal(blocked.gender, UNKNOWN);
  assert.equal(blocked.guardFired, true);
  assert.equal(blocked.guardShortCircuited, false);
  const taught = applyScreenedFoundingTeamGender(['Male', 'Male'], 'partial', { learnedGender: 'Male' });
  assert.equal(taught.gender, 'Male');
  assert.equal(taught.guardFired, false);
  assert.equal(taught.guardShortCircuited, true);
  assert.equal(taught.screenedGender, UNKNOWN);
  const woman = applyScreenedFoundingTeamGender(['Female'], 'partial', { learnedGender: 'Male' });
  assert.equal(woman.gender, 'Female');
  assert.equal(woman.guardShortCircuited, false);
});

console.log('16. Official-site bio fallback');
check('JSON-LD / founded-by win over bios', () => {
  assert.match(
    mergeOfficialSiteFounders({
      jsonLd: 'Ada Lovelace',
      explicit: UNKNOWN,
      bios: 'Jane Smith'
    }),
    /Ada Lovelace/
  );
});
check('bios run only when JSON-LD and founded-by are empty', () => {
  assert.match(
    mergeOfficialSiteFounders({
      jsonLd: UNKNOWN,
      explicit: UNKNOWN,
      bios: 'Jane Smith'
    }),
    /Jane Smith/
  );
});
check('extracts Co-Founder & CEO bios and ignores CEO-only', () => {
  const bios = extractFounderTitleBios(
    'Jane Smith, Co-Founder & CEO\nTim Cook, CEO\nMartha Pollack, President\nAlex Rivera — Founding Partner'
  );
  assert.match(bios, /Jane Smith/);
  assert.match(bios, /Alex Rivera/);
  assert.doesNotMatch(bios, /Tim Cook/);
  assert.doesNotMatch(bios, /Martha Pollack/);
});
check('explicit founded-by still works', () => {
  assert.match(extractExplicitFoundedByNames('Acme was founded by Josh Wolfe and Peter Hebert in 2004.'), /Josh Wolfe/);
});

console.log('17. Unknown sub-status');
check('no data vs pipeline error', () => {
  assert.equal(classifyFoundersUnknownStatus(UNKNOWN, []), 'unknown_no_data');
  assert.equal(classifyFoundersUnknownStatus(UNKNOWN, ['wikipedia_timeout']), 'unknown_pipeline_error');
  assert.equal(classifyFoundersUnknownStatus('Jane Smith', ['wikipedia_timeout']), null);
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) process.exit(1);
