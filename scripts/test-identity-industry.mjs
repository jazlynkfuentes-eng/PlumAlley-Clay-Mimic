/**
 * Adversarial industry classification tests + identity unit tests.
 * Fixtures only — not hardcoded into production dictionaries.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyIndustry, industryEquivalent } from './lib/industry-classify.mjs';
import {
  scoreIdentityCandidate,
  selectIdentity,
  hostOf
} from './lib/identity-resolve.mjs';
import {
  parseCompanyInput,
  diagnoseAmbiguity,
  applyStage2Boosts,
  resolveAmbiguousIdentity,
  stage2SearchQueries,
  fullNamePresent
} from './lib/identity-stage2.mjs';
import {
  expandPastedCompanyInput,
  dedupeCompanyNames,
  sanitizeUserFacingNotes,
  finalizeEnrichmentFields,
  UNKNOWN
} from './lib/enrichment-quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/eval/cross-industry-companies.json'), 'utf8')
).adversarialIndustryFixtures;

let passed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('Use checkAsync for async tests');
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('Adversarial industry fixtures');
for (const fix of fixtures) {
  check(`${fix.name} → ${fix.expect} (not ${fix.reject || 'wrong'})`, () => {
    const result = classifyIndustry([fix.corpus]);
    assert.ok(
      industryEquivalent(result.value, fix.expect) || result.value === fix.expect,
      `got ${result.value} conf=${result.confidence} evidence=${JSON.stringify(result.evidence)}`
    );
    if (fix.reject) {
      assert.notEqual(result.value, fix.reject);
    }
    assert.notEqual(result.confidence, undefined);
  });
}

console.log('Datadog GPU/infra noise must not become Semiconductors');
check('monitoring page with GPU mention stays software', () => {
  const r = classifyIndustry([
    'Datadog is the monitoring and security platform for cloud applications.',
    'Track GPU utilization in your Kubernetes clusters and cloud infrastructure.'
  ]);
  assert.notEqual(r.value, 'Semiconductors');
  assert.ok(industryEquivalent(r.value, 'Enterprise Software') || r.value === UNKNOWN, `got ${r.value}`);
});

console.log('Identity scoring');
check('netflix.com / brex.com are not junk (x.com boundary)', () => {
  const n = scoreIdentityCandidate('Netflix', { domain: 'netflix.com', name: 'Netflix', source: 'clearbit' });
  const b = scoreIdentityCandidate('Brex', { domain: 'brex.com', name: 'Brex', source: 'clearbit' });
  const x = scoreIdentityCandidate('X', { domain: 'x.com', name: 'X', source: 'ddg_abstract' });
  assert.ok(!n.signals.junkDomain, `netflix junk=${n.signals.junkDomain}`);
  assert.ok(!b.signals.junkDomain, `brex junk=${b.signals.junkDomain}`);
  assert.ok(x.signals.junkDomain || x.score < 50, 'x.com should be junk or weak');
  assert.ok(n.score > 50 && b.score > 50);
});
check('exact domain+clearbit name wins', () => {
  const good = scoreIdentityCandidate('Stripe', {
    domain: 'stripe.com',
    name: 'Stripe',
    source: 'clearbit'
  }, { metaDescription: 'Stripe is a financial technology payments platform.', pageTitle: 'Stripe' });
  const bad = scoreIdentityCandidate('Stripe', {
    domain: 'stripes.com',
    name: 'Stripes',
    source: 'ddg_abstract'
  });
  assert.ok(good.score > bad.score);
  const sel = selectIdentity([
    { ...good, domain: 'stripe.com', source: 'clearbit' },
    { ...bad, domain: 'stripes.com', source: 'ddg_abstract' }
  ], { companyName: 'Stripe', resolveMin: 55, ambiguityGap: 12 });
  assert.equal(sel.identityStatus, 'resolved');
  assert.equal(sel.domain, 'stripe.com');
});
check('close scores without authoritative edge → ambiguous', () => {
  const a = {
    domain: 'acme.com',
    score: 82,
    source: 'clearbit',
    signals: { homepageHeadMention: 12, metaMentionsCompany: 8 },
    hostCore: 'acme',
    nameKey: 'acme',
    authoritativeCount: 0
  };
  const b = {
    domain: 'acme.io',
    score: 79,
    source: 'clearbit',
    signals: { homepageHeadMention: 12, metaMentionsCompany: 8 },
    hostCore: 'acme',
    nameKey: 'acme',
    authoritativeCount: 0
  };
  const sel = selectIdentity([a, b], { companyName: 'Acme', resolveMin: 70, ambiguityGap: 18 });
  assert.equal(sel.identityStatus, 'ambiguous');
  assert.equal(sel.domain, null);
});
check('large margin with exact domain → resolved', () => {
  const a = {
    domain: 'nvidia.com',
    score: 94,
    source: 'wikidata_official',
    signals: { domainExactKey: 40, wikidataP856: 45, homepageHeadMention: 12 },
    hostCore: 'nvidia',
    nameKey: 'nvidia',
    authoritativeCount: 2
  };
  const b = {
    domain: 'nvidianews.com',
    score: 51,
    source: 'ddg_abstract',
    signals: { brandSuffixNoise: -55 },
    hostCore: 'nvidianews',
    nameKey: 'nvidia',
    authoritativeCount: 0
  };
  const sel = selectIdentity([a, b], { companyName: 'NVIDIA', resolveMin: 70, ambiguityGap: 18 });
  assert.equal(sel.identityStatus, 'resolved');
  assert.equal(sel.domain, 'nvidia.com');
});
check('low scores → unresolved/ambiguous', () => {
  const sel = selectIdentity([{ domain: 'zzzexample.com', score: 20, source: 'ddg_abstract' }], {
    companyName: 'Zzz Example'
  });
  assert.ok(sel.identityStatus === 'unresolved' || sel.identityStatus === 'ambiguous');
  assert.equal(sel.domain, null);
});

console.log('Canonical domain adversarial fixtures');
function assertCanonical(company, goodDomain, badDomain, goodEv = {}, badEv = {}) {
  const good = scoreIdentityCandidate(company, { domain: goodDomain, name: company, source: 'clearbit' }, {
    pageTitle: company,
    metaDescription: `${company} is a company.`,
    pageText: `${company} is a company headquartered in the United States. © 2024 ${company}`,
    ...goodEv
  });
  const bad = scoreIdentityCandidate(company, { domain: badDomain, name: company, source: 'ddg_abstract' }, {
    pageTitle: badEv.pageTitle || badDomain,
    metaDescription: badEv.metaDescription || '',
    pageText: badEv.pageText || '',
    ...badEv
  });
  assert.ok(good.score > bad.score + 10, `${company}: ${goodDomain}=${good.score} vs ${badDomain}=${bad.score}`);
  const sel = selectIdentity(
    [
      { ...good, domain: goodDomain, source: 'clearbit' },
      { ...bad, domain: badDomain, source: 'ddg_abstract' }
    ],
    { companyName: company, resolveMin: 60, ambiguityGap: 15 }
  );
  if (sel.identityStatus === 'resolved') {
    assert.equal(sel.domain, goodDomain);
  } else {
    assert.notEqual(sel.domain, badDomain);
  }
}

check('Netflix → netflix.com not ir.netflix.net', () => {
  assertCanonical('Netflix', 'netflix.com', 'ir.netflix.net', {}, {
    pageTitle: 'Netflix Investor Relations',
    metaDescription: 'Investor relations and shareholder information.',
    pageText: 'Investor relations stock information.'
  });
});
check('Netflix → netflix.com not netflix.shop', () => {
  assertCanonical('Netflix', 'netflix.com', 'netflix.shop', {}, {
    pageTitle: 'Netflix Shop',
    metaDescription: 'Official Netflix merchandise store. Shop now.',
    pageText: 'Add to cart. Official merchandise.'
  });
});
check('Microsoft → microsoft.com not microsoftcasualgames.com', () => {
  assertCanonical('Microsoft', 'microsoft.com', 'microsoftcasualgames.com', {
    wikidataOfficial: true
  }, {
    pageTitle: 'Microsoft Casual Games',
    metaDescription: 'Play free casual games from Microsoft.',
    pageText: 'Xbox casual games studio microsite.'
  });
});
check('Brex → brex.com not brextom.com', () => {
  assertCanonical('Brex', 'brex.com', 'brextom.com');
});
check('Vista Equity Partners → vistaequitypartners.com not vista.com', () => {
  const good = scoreIdentityCandidate(
    'Vista Equity Partners',
    { domain: 'vistaequitypartners.com', name: 'Vista Equity Partners', source: 'clearbit' },
    {
      pageTitle: 'Vista Equity Partners',
      metaDescription: 'Vista Equity Partners is a private equity firm.',
      pageText: 'Vista Equity Partners is a leading private equity firm focused on software.'
    }
  );
  const bad = scoreIdentityCandidate(
    'Vista Equity Partners',
    { domain: 'vista.com', name: 'Vista', source: 'ddg_abstract' },
    {
      pageTitle: 'VistaPrint | Business Cards',
      metaDescription: 'Online printing and business cards from VistaPrint.',
      pageText: 'Custom printing, business cards, vistaprint online store.'
    }
  );
  assert.ok(good.score > bad.score + 20, `good=${good.score} bad=${bad.score}`);
  const sel = selectIdentity(
    [
      { ...good, domain: 'vistaequitypartners.com', source: 'clearbit' },
      { ...bad, domain: 'vista.com', source: 'ddg_abstract' }
    ],
    { companyName: 'Vista Equity Partners', resolveMin: 60, ambiguityGap: 15 }
  );
  assert.notEqual(sel.domain, 'vista.com');
  if (sel.identityStatus === 'resolved') assert.equal(sel.domain, 'vistaequitypartners.com');
});
check('Human Capital prefers human.capital over regional .com.co', () => {
  const good = scoreIdentityCandidate(
    'Human Capital',
    { domain: 'human.capital', name: 'Human Capital', source: 'clearbit' },
    {
      pageTitle: 'Human Capital',
      metaDescription: 'Human Capital is a venture capital firm.',
      pageText: 'Human Capital is an investment firm.'
    }
  );
  const bad = scoreIdentityCandidate(
    'Human Capital',
    { domain: 'humancapital.com.co', name: 'Human Capital', source: 'ddg_abstract' },
    { pageTitle: 'Human Capital Colombia', pageText: 'Regional site' }
  );
  assert.ok(good.score > bad.score, `good=${good.score} bad=${bad.score}`);
});
check('Human Capital prefers human.capital over humancapital.com', () => {
  const good = scoreIdentityCandidate(
    'Human Capital',
    { domain: 'human.capital', name: 'Human Capital', source: 'clearbit' },
    {
      pageTitle: 'Human Capital',
      metaDescription: 'Human Capital is a venture capital firm investing in talent.',
      pageText: 'Human Capital is a venture capital firm.'
    }
  );
  const bad = scoreIdentityCandidate(
    'Human Capital',
    { domain: 'humancapital.com', name: 'Human Capital', source: 'brand_guess' },
    {
      pageTitle: 'Human Capital',
      metaDescription: 'Welcome to Human Capital.',
      pageText: 'Human Capital homepage.'
    }
  );
  assert.ok(good.score > bad.score, `good=${good.score} bad=${bad.score}`);
  const sel = selectIdentity(
    [
      { ...good, domain: 'human.capital', source: 'clearbit' },
      { ...bad, domain: 'humancapital.com', source: 'brand_guess' }
    ],
    { companyName: 'Human Capital', resolveMin: 60, ambiguityGap: 15 }
  );
  assert.notEqual(sel.domain, 'humancapital.com');
});
check('Scale AI prefers scale.com over scaleai.com', () => {
  const good = scoreIdentityCandidate(
    'Scale AI',
    { domain: 'scale.com', name: 'Scale AI', source: 'clearbit' },
    { pageTitle: 'Scale AI', metaDescription: 'Scale AI is the data platform for AI.', pageText: 'Scale AI builds data labeling infrastructure.' }
  );
  const bad = scoreIdentityCandidate(
    'Scale AI',
    { domain: 'scaleai.com', name: 'Scale AI', source: 'brand_guess' },
    { pageTitle: 'ScaleAI', pageText: 'Welcome' }
  );
  assert.ok(good.score > bad.score, `good=${good.score} bad=${bad.score}`);
});

console.log('Stage-2 ambiguity resolver');
check('parseCompanyInput supports pipe context', () => {
  const p = parseCompanyInput('Vista Equity Partners | Private Equity');
  assert.equal(p.name, 'Vista Equity Partners');
  assert.equal(p.industry, 'Private Equity');
});
check('fullNamePresent requires multi-token identity', () => {
  assert.ok(fullNamePresent('Vista Equity Partners', 'Vista Equity Partners is a private equity firm'));
  assert.ok(!fullNamePresent('Vista Equity Partners', 'VistaPrint design and marketing services'));
});
check('diagnoseAmbiguity logs margin and reason', () => {
  const d = diagnoseAmbiguity('Lux Capital', {
    reason: 'insufficient_margin',
    ambiguityRisk: 40,
    resolveMin: 80,
    best: { domain: 'luxcapital.com', score: 90, signals: { domainExactKey: 40 }, sources: ['clearbit'] },
    second: { domain: 'lux.capital', score: 85, signals: { tokenAsTldMatch: 18 }, sources: ['brand_guess'] },
    candidates: [
      { domain: 'luxcapital.com', score: 90, signals: { domainExactKey: 40 }, sources: ['clearbit'] },
      { domain: 'lux.capital', score: 85, signals: { tokenAsTldMatch: 18 }, sources: ['brand_guess'] }
    ]
  });
  assert.equal(d.reason, 'insufficient_margin');
  assert.equal(d.scoreMargin, 5);
  assert.ok(d.candidates.length === 2);
});
check('stage2 boosts full-name + invest type without lowering thresholds', () => {
  const base = scoreIdentityCandidate(
    'Vista Equity Partners',
    { domain: 'vistaequitypartners.com', name: 'Vista Equity Partners', source: 'clearbit' },
    { pageTitle: 'Home', pageText: 'Welcome' }
  );
  const boosted = applyStage2Boosts(
    'Vista Equity Partners',
    { ...base, domain: 'vistaequitypartners.com', sources: ['clearbit', 'wikidata'] },
    {
      aboutText: 'Vista Equity Partners is a leading private equity firm focused on enterprise software.',
      metaDescription: 'Vista Equity Partners — private equity',
      searchSnippets: 'Vista Equity Partners is a private equity firm',
      supportingSources: ['deep_about', 'search', 'wikidata']
    },
    { industry: 'Private Equity' }
  );
  assert.ok(boosted.score > base.score + 40, `boosted=${boosted.score} base=${base.score}`);
  assert.ok(boosted.stage2Boosts.fullNameConfirmed);
  assert.ok(boosted.stage2Boosts.contextIndustryAlign || boosted.stage2Boosts.stage2EntityTypeMatch);
});
check('stage2 search queries are contextual not industry-forced', () => {
  const q = stage2SearchQueries('Chapter One', {});
  assert.ok(q.some((x) => /venture capital/i.test(x)));
  assert.ok(q.some((x) => /official website/i.test(x)));
});

console.log('Regression guards');
check('messy paste still works', () => {
  const lines = expandPastedCompanyInput('1. Nvidia\n• Apple Inc\nRamp, Shopify');
  assert.ok(lines.length >= 4);
});
check('dedupe legal suffixes', () => {
  assert.deepEqual(dedupeCompanyNames(['NVIDIA', 'NVIDIA Corporation']), ['NVIDIA']);
});
check('repeated industries preserved', () => {
  const a = finalizeEnrichmentFields({ industry: 'Enterprise Software', headcount: UNKNOWN, location: 'SF', contacts: UNKNOWN, notes: 'a', gender: UNKNOWN });
  const b = finalizeEnrichmentFields({ industry: 'Enterprise Software', headcount: UNKNOWN, location: 'NY', contacts: UNKNOWN, notes: 'b', gender: UNKNOWN });
  assert.equal(a.industry, 'Enterprise Software');
  assert.equal(b.industry, 'Enterprise Software');
});
check('notes stay clean', () => {
  assert.equal(sanitizeUserFacingNotes('Verifying selected domain... · Score 81'), '');
});

await checkAsync('stage2 does not run on resolved stage1', async () => {
  const out = await resolveAmbiguousIdentity('Stripe', {
    identityStatus: 'resolved',
    domain: 'stripe.com',
    reason: 'selected'
  });
  assert.equal(out.stage2.ran, false);
  assert.equal(out.domain, 'stripe.com');
});

await checkAsync('stage2 recovers ambiguous PE with deep evidence + context', async () => {
  const stage1 = {
    identityStatus: 'ambiguous',
    reason: 'insufficient_margin',
    resolveMin: 80,
    ambiguityRisk: 30,
    best: { domain: 'vista.com', score: 88 },
    second: { domain: 'vistaequitypartners.com', score: 86 },
    candidates: [
      {
        domain: 'vista.com',
        score: 88,
        source: 'clearbit',
        hostCore: 'vista',
        nameKey: 'vistaequitypartners',
        signals: { titleMentionsCompany: 10 },
        sources: ['clearbit']
      },
      {
        domain: 'vistaequitypartners.com',
        score: 86,
        source: 'brand_guess',
        hostCore: 'vistaequitypartners',
        nameKey: 'vistaequitypartners',
        signals: { domainExactKey: 40 },
        sources: ['brand_guess']
      }
    ]
  };
  stage1.allCandidates = stage1.candidates;
  const out = await resolveAmbiguousIdentity(
    'Vista Equity Partners',
    stage1,
    {
      fetchHtml: async (url) => {
        if (/vistaequitypartners/i.test(url)) {
          return `<html><head><title>Vista Equity Partners</title>
            <meta name="description" content="Vista Equity Partners is a private equity firm."/>
            <script type="application/ld+json">{"@type":"Organization","name":"Vista Equity Partners"}</script>
            </head><body>Vista Equity Partners is a leading private equity firm. © 2024 Vista Equity Partners</body></html>`;
        }
        return `<html><title>VistaPrint</title><body>Online printing and business cards from VistaPrint. Shop now.</body></html>`;
      },
      searchSnippets: async () => [
        {
          domain: 'vistaequitypartners.com',
          snippet: 'Vista Equity Partners is a private equity firm investing in enterprise software',
          title: 'Vista Equity Partners'
        }
      ],
      fetchWikidata: async () => ({
        domain: 'vistaequitypartners.com',
        name: 'Vista Equity Partners',
        description: 'American private equity firm'
      })
    },
    { industry: 'Private Equity' }
  );
  assert.equal(out.identityStatus, 'resolved', `status=${out.identityStatus} reason=${out.reason}`);
  assert.equal(out.domain, 'vistaequitypartners.com');
  assert.equal(out.stage2.recovered, true);
});

console.log(`\n${passed} assertions passed`);
if (process.exitCode) process.exit(1);
