#!/usr/bin/env node
/**
 * Entity-type guard unit + regression tests.
 *
 * The classifier is general (P31 class lists only). Export-derived fixtures
 * prove the same path would have rejected those Wikipedia entities — they do
 * not special-case company names.
 *
 *   node scripts/test-entity-type-guard.mjs
 */
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  classifyEntityTypeFromP31,
  classifyEntityTypeWithSubclassWalk,
  inspectMediaCompanyContext,
  isMediaCompanyContext,
  formatEntityTypeDebug,
  namePageTokenOverlap,
  fetchWithBackoff,
  clearEntityTypeSubclassCache,
  MEDIA_CONTEXT_FIELD,
  MEDIA_CONTEXT_KEYWORDS,
  ENTITY_TYPE_GUARD_VERSION
} from './lib/entity-type-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = join(ROOT, 'fixtures/entity-type-guard-regression.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const classifierSrc = fs.readFileSync(join(ROOT, 'scripts/lib/entity-type-guard.mjs'), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`PASS  ${msg}`);
  }
}

console.log(`Entity-type guard (${ENTITY_TYPE_GUARD_VERSION})\n`);

assert(classifyEntityTypeFromP31([]).decision === 'allow_unknown', 'empty P31 → allow_unknown (thin Wikidata)');
assert(classifyEntityTypeFromP31(['Q4830453']).decision === 'accept', 'business → accept');
assert(classifyEntityTypeFromP31(['Q15042660']).decision === 'accept', 'LLC legal form → accept');
assert(classifyEntityTypeFromP31(['Q327333']).decision === 'accept', 'government agency → accept');
assert(classifyEntityTypeFromP31(['Q163740']).decision === 'accept', 'nonprofit → accept');
assert(classifyEntityTypeFromP31(['Q157031']).decision === 'accept', 'foundation → accept');
assert(classifyEntityTypeFromP31(['Q3918']).decision === 'accept', 'university → accept');
assert(classifyEntityTypeFromP31(['Q613142']).decision === 'accept', 'law firm → accept');
assert(classifyEntityTypeFromP31(['Q15980864']).decision === 'accept', 'venture capital firm → accept');
assert(classifyEntityTypeFromP31(['Q999999999']).decision === 'allow_unknown', 'unlisted P31 → allow_unknown (not a reject)');

assert(classifyEntityTypeFromP31(['Q5']).decision === 'reject', 'human → reject');
assert(classifyEntityTypeFromP31(['Q515']).decision === 'reject', 'city → reject');
assert(classifyEntityTypeFromP31(['Q4022']).decision === 'reject', 'river → reject');
assert(classifyEntityTypeFromP31(['Q11424']).decision === 'reject', 'film → reject');
assert(classifyEntityTypeFromP31(['Q571']).decision === 'reject', 'book → reject');
assert(classifyEntityTypeFromP31(['Q1656682']).decision === 'reject', 'event → reject');
assert(classifyEntityTypeFromP31(['Q11276']).decision === 'reject', 'globular cluster → reject');
assert(classifyEntityTypeFromP31(['Q4167410']).decision === 'reject', 'disambiguation page → reject');

const mediaNoCtx = classifyEntityTypeFromP31(['Q11032'], { mediaContext: false });
assert(mediaNoCtx.decision === 'reject' && mediaNoCtx.reason === 'p31_media', 'newspaper without media context → reject');
const mediaCtx = classifyEntityTypeFromP31(['Q11032'], { mediaContext: true });
assert(mediaCtx.decision === 'accept' && mediaCtx.reason === 'p31_media_with_context', 'newspaper with media context → accept');
assert(
  classifyEntityTypeFromP31(['Q4830453', 'Q11032']).decision === 'accept',
  'business + newspaper → accept (org class wins)'
);
assert(
  classifyEntityTypeFromP31(['Q4830453', 'Q5']).decision === 'accept',
  'business + human → accept (org class wins; same-type company collision is out of scope)'
);

console.log('\n--- Media carve-out (Contact/Source title only) ---');
assert(MEDIA_CONTEXT_FIELD === 'personTitle', 'media field is Contact/Source title (personTitle)');
assert(
  MEDIA_CONTEXT_KEYWORDS.join(',') === 'media,news,broadcast,publisher,publishing,press,editorial',
  'fixed media keyword list'
);
const newsTitle = inspectMediaCompanyContext('Editor at a newspaper group');
assert(newsTitle.matched && newsTitle.matchedKeyword === 'news', 'newspaper title matches keyword "news"');
assert(newsTitle.field === 'personTitle', 'inspect logs the field name');
const ceoTitle = inspectMediaCompanyContext('CEO');
assert(!ceoTitle.matched && ceoTitle.matchedKeyword === 'no match', 'CEO title → no match');
const broadcastTitle = inspectMediaCompanyContext('Head of Broadcast');
assert(broadcastTitle.matched && broadcastTitle.matchedKeyword === 'broadcast', 'Broadcast title matches');
assert(isMediaCompanyContext('Head of Editorial'), 'editorial keyword matches');
assert(!isMediaCompanyContext('Managing Partner'), 'PE title is not media context');
assert(
  !inspectMediaCompanyContext('').matched && inspectMediaCompanyContext('').matchedKeyword === 'no match',
  'empty title → no match (auditable)'
);

console.log('\n--- resolutionDebug summaries distinguish accept / allow_unknown / reject / retry_needed ---');
const acceptDbg = formatEntityTypeDebug(classifyEntityTypeFromP31(['Q4830453']));
const emptyDbg = formatEntityTypeDebug(classifyEntityTypeFromP31([]));
const unlistedDbg = formatEntityTypeDebug(classifyEntityTypeFromP31(['Q999999999']));
const fetchDbg = formatEntityTypeDebug(
  { decision: 'retry_needed', reason: 'rate_limited', p31: [], matched: null }
);
assert(fetchDbg.outcome === 'retry_needed' && fetchDbg.summary === 'retry_needed — rate limited', fetchDbg.summary);
assert(!fetchDbg.summary.startsWith('allow_unknown'), 'rate-limit is not logged as allow_unknown');
const transientDbg = formatEntityTypeDebug(
  { decision: 'retry_needed', reason: 'transient', p31: [], matched: null }
);
assert(transientDbg.summary === 'retry_needed — transient', transientDbg.summary);
const rejectDbg = formatEntityTypeDebug(classifyEntityTypeFromP31(['Q5']));
assert(acceptDbg.outcome === 'accept' && acceptDbg.summary.startsWith('accept — org class matched:'), acceptDbg.summary);
assert(emptyDbg.outcome === 'allow_unknown' && emptyDbg.summary === 'allow_unknown — empty P31', emptyDbg.summary);
assert(unlistedDbg.outcome === 'allow_unknown' && unlistedDbg.summary.startsWith('allow_unknown — unlisted legal form:'), unlistedDbg.summary);
assert(rejectDbg.outcome === 'reject' && rejectDbg.summary === 'reject — Q5 is a reject class', rejectDbg.summary);
assert(
  acceptDbg.summary !== emptyDbg.summary
    && acceptDbg.summary !== unlistedDbg.summary
    && emptyDbg.summary !== unlistedDbg.summary
    && fetchDbg.summary !== emptyDbg.summary
    && fetchDbg.outcome !== 'allow_unknown',
  'allow_unknown variants are not logged identically to accept, reject, or retry_needed'
);

const zero = namePageTokenOverlap('Acme Robotics', {
  title: 'Welcome | Completely Unrelated Hosting',
  meta: 'cheap domains',
  h1: 'Buy now'
});
assert(zero.zero === true && zero.checked === true, 'domain-guess with zero title/meta/H1 overlap → zero');
const hit = namePageTokenOverlap('Acme Robotics', {
  title: 'Acme Robotics — Home',
  meta: 'We build robots',
  h1: 'Acme'
});
assert(hit.zero === false && hit.overlap >= 1, 'matching page title → overlap');

console.log('\n--- Subclass walk (unlisted P31 only; exact hits skip the walk) ---');
clearEntityTypeSubclassCache();
const radioWalk = await classifyEntityTypeWithSubclassWalk(['Q14350'], {
  mediaContext: false,
  subclassLevels: { Q14350: [['Q15265344', 'Q11033']] }
});
assert(radioWalk.decision === 'reject' && radioWalk.reason === 'p31_media' && radioWalk.via === 'subclass',
  `Q14350 radio station walks to mass media → reject (${radioWalk.decision}/${radioWalk.reason})`);
assert(classifyEntityTypeFromP31(['Q14350']).decision === 'allow_unknown',
  'exact-match fast path for Q14350 is still allow_unknown (list unchanged)');
const radioCtx = await classifyEntityTypeWithSubclassWalk(['Q14350'], {
  mediaContext: true,
  subclassLevels: { Q14350: [['Q15265344', 'Q11033']] }
});
assert(radioCtx.decision === 'accept' && radioCtx.reason === 'p31_media_with_context',
  'Q14350 with media contact-title → accept via subclass');
const exactSkip = await classifyEntityTypeWithSubclassWalk(['Q5']);
assert(exactSkip.decision === 'reject' && exactSkip.via === 'exact', 'human exact hit skips P279 walk');
const emptySkip = await classifyEntityTypeWithSubclassWalk([]);
assert(emptySkip.decision === 'allow_unknown' && emptySkip.via === 'empty_p31', 'empty P31 skips walk');
const songWalk = await classifyEntityTypeWithSubclassWalk(['Q105543609'], {
  subclassLevels: { Q105543609: [['Q2188189']] }
});
assert(songWalk.decision === 'reject' && songWalk.via === 'subclass',
  'unlisted musical-work metaclass walks to musical work → reject');
const orgForm = await classifyEntityTypeWithSubclassWalk(['Q999888777'], {
  subclassLevels: { Q999888777: [['Q4830453']] }
});
assert(orgForm.decision === 'accept' && orgForm.reason === 'p31_org_subclass',
  'unlisted legal form that subclasses business → accept');

console.log('\n--- fetchWithBackoff retries 429 as rate_limited, not allow_unknown ---');
let fetchCalls = 0;
const rateLimited = await fetchWithBackoff('https://example.test/wiki', {
  label: 'test-429',
  attempts: 3,
  backoffMs: () => 0,
  fetchImpl: async () => {
    fetchCalls += 1;
    return { status: 429, ok: false };
  }
});
assert(fetchCalls === 3, `429 retried 3 times (got ${fetchCalls})`);
assert(rateLimited.error === 'rate_limited' && rateLimited.json == null, 'exhausted 429 → rate_limited');

console.log('\n--- Export regression fixtures (same classifier, no name special-cases) ---');
assert(Array.isArray(fixture.cases) && fixture.cases.length >= 3, 'fixture has export-derived cases');
assert(fixture.personP31InExports && fixture.personP31InExports.foundNamedCompanyThatIsAPerson === false,
  'exports contain no person-named company row; person coverage uses Wikipedia human hits');

const requiredRejectClasses = [
  'human', 'settlement_geo', 'physical_phenomenon', 'creative_work',
  'historical_legal_event', 'media', 'disambiguation'
];
const fixtureRejectClasses = new Set(fixture.cases.map((r) => r.rejectClass).filter(Boolean));
for (const cls of requiredRejectClasses) {
  const covering = fixture.cases.filter((r) => r.rejectClass === cls && r.expectedDecision === 'reject');
  assert(covering.length >= 1, `fixture covers reject class "${cls}" via classifyEntityTypeFromP31`);
}
assert(
  fixture.cases.some((r) => r.expectedDecision === 'accept'),
  'fixture covers accept'
);
assert(
  fixture.cases.some((r) => r.expectedDecision === 'allow_unknown' && r.expectedReason === 'no_p31'),
  'fixture covers allow_unknown empty P31'
);
assert(
  fixture.cases.some((r) => r.expectedDecision === 'allow_unknown' && r.expectedReason === 'p31_unlisted'),
  'fixture covers allow_unknown unlisted legal form'
);

for (const row of fixture.cases) {
  const mediaContext = row.mediaContext != null
    ? !!row.mediaContext
    : isMediaCompanyContext(row.contactTitle);
  const got = classifyEntityTypeFromP31(row.instanceOf, { mediaContext });
  if (row.companyName && !/^Example /i.test(row.companyName)) {
    assert(
      !classifierSrc.toLowerCase().includes(row.companyName.toLowerCase()),
      `${row.companyName}: classifier source has no company-name special case`
    );
  }
  const label = `${row.companyName}${row.specClassCoverage ? ' [spec class]' : ''}`;
  assert(
    got.decision === row.expectedDecision,
    `${label}: P31 ${row.instanceOf.join(',') || '(empty)'} → ${got.decision} (want ${row.expectedDecision}); ${row.wrongEntity || ''}`
  );
  if (row.expectedReason) {
    assert(
      got.reason === row.expectedReason,
      `${label}: reason ${got.reason} (want ${row.expectedReason})`
    );
  }
  const dbg = formatEntityTypeDebug(got, {
    mediaKeyword: inspectMediaCompanyContext(row.contactTitle).matchedKeyword
  });
  assert(dbg.outcome === got.decision, `${label}: debug outcome ${dbg.outcome} matches decision`);
  if (got.decision === 'allow_unknown') {
    assert(dbg.summary.startsWith('allow_unknown —'), `${label}: allow_unknown summary is distinct: ${dbg.summary}`);
    assert(!dbg.summary.startsWith('accept —'), `${label}: allow_unknown is not logged as accept`);
  }
}

console.log('\n--- Same-name org collision (guard must not drop either) ---');
const collision = fixture.sameNameOrgCollision;
const kept = (collision.candidates || []).filter((c) => {
  const type = classifyEntityTypeFromP31(c.instanceOf);
  c.entityType = type;
  return type.decision !== 'reject';
});
assert(kept.length === 2, `both org-class same-name companies kept (${kept.map((c) => c.domain).join(', ')})`);
assert(kept[0].domain !== kept[1].domain, 'collision candidates have distinct domains (dedup is by domain, not name)');
const byDomain = new Map();
for (const c of kept) {
  if (!byDomain.has(c.domain)) byDomain.set(c.domain, c);
}
assert(byDomain.size === 2, 'domain-keyed normalize would still retain both org matches');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK — entity-type guard classifier + export fixtures');
process.exit(0);
