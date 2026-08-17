/**
 * Unit tests for PDL validation / mapping / fallback merge (mocked — no live API).
 */
import assert from 'node:assert/strict';
import { validatePdlCompanyMatch, filterPdlFounderPeople, apexDomain } from './lib/pdl-validate.mjs';
import {
  mapPdlHeadcount,
  mapPdlHeadquarters,
  applyPdlCompanyToFields,
  enrichWithPdlFallback
} from './lib/pdl-fallback.mjs';
import { fieldRecord, UNKNOWN, isBlankOrUnknown } from './lib/enrichment-quality.mjs';
import { isPdlConfigured } from './lib/pdl-client.mjs';

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

console.log('PDL domain / match validation');
check('apexDomain strips www', () => {
  assert.equal(apexDomain('www.stripe.com'), 'stripe.com');
});
check('accepts matching domain + likelihood', () => {
  const m = validatePdlCompanyMatch({
    requestedDomain: 'stripe.com',
    requestedName: 'Stripe',
    pdlResponse: {
      enabled: true,
      status: 200,
      likelihood: 9,
      data: {
        name: 'Stripe',
        website: 'stripe.com',
        likelihood: 9,
        location: {
          locality: 'South San Francisco',
          region: 'california',
          country: 'united states',
          name: 'south san francisco, california, united states'
        },
        size: '1001-5000',
        employee_count: 7000
      }
    },
    minLikelihood: 6
  });
  assert.equal(m.pdlMatchStatus, 'accepted');
  assert.equal(m.accepted, true);
});
check('rejects domain mismatch', () => {
  const m = validatePdlCompanyMatch({
    requestedDomain: 'stripe.com',
    requestedName: 'Stripe',
    pdlResponse: {
      enabled: true,
      status: 200,
      data: { name: 'Other Co', website: 'other.com', likelihood: 9 }
    }
  });
  assert.equal(m.pdlMatchStatus, 'rejected');
  assert.match(m.reason, /domain_mismatch/);
});
check('rejects low likelihood', () => {
  const m = validatePdlCompanyMatch({
    requestedDomain: 'stripe.com',
    requestedName: 'Stripe',
    pdlResponse: {
      enabled: true,
      status: 200,
      data: { name: 'Stripe', website: 'stripe.com', likelihood: 3 }
    },
    minLikelihood: 6
  });
  assert.equal(m.pdlMatchStatus, 'rejected');
});

console.log('PDL field mapping');
check('maps size enum to buckets', () => {
  assert.equal(mapPdlHeadcount({ size: '51-200' }).bucket, '51–200');
  assert.equal(mapPdlHeadcount({ size: '1001-5000' }).bucket, '1,001–5,000');
  assert.equal(mapPdlHeadcount({ employee_count: 120 }).bucket, '51–200');
});
check('maps HQ locality+region', () => {
  const hq = mapPdlHeadquarters({
    location: {
      locality: 'san francisco',
      region: 'california',
      country: 'united states',
      name: 'san francisco, california, united states'
    }
  });
  assert.ok(hq?.value);
  assert.match(hq.value, /San Francisco/i);
  assert.match(hq.value, /CA/);
});

console.log('PDL founder filter');
check('keeps founder titles only', () => {
  const people = filterPdlFounderPeople(
    [
      {
        full_name: 'Jane Doe',
        job_title: 'Co-Founder',
        job_company_website: 'acme.com',
        job_company_name: 'Acme'
      },
      {
        full_name: 'John Smith',
        job_title: 'CEO',
        job_company_website: 'acme.com',
        job_company_name: 'Acme'
      },
      {
        full_name: 'Bob Partner',
        job_title: 'Managing Partner',
        job_company_website: 'acme.com',
        job_company_name: 'Acme'
      }
    ],
    { domain: 'acme.com', companyName: 'Acme' }
  );
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Jane Doe');
});

console.log('PDL fallback merge');
check('fills only Unknown fields', () => {
  const publicFields = {
    location: fieldRecord(UNKNOWN, 'none', 'low', { unknownReason: 'x' }),
    headcount: fieldRecord('10,001+', 'wikidata', 'high', { sourceType: 'wikidata' }),
    founders: fieldRecord(UNKNOWN, 'none', 'low', { unknownReason: 'x' })
  };
  const data = {
    name: 'NVIDIA',
    website: 'nvidia.com',
    likelihood: 10,
    size: '10001+',
    employee_count: 30000,
    location: {
      locality: 'santa clara',
      region: 'california',
      name: 'santa clara, california, united states'
    }
  };
  const match = validatePdlCompanyMatch({
    requestedDomain: 'nvidia.com',
    requestedName: 'NVIDIA',
    pdlResponse: { enabled: true, status: 200, data, likelihood: 10 }
  });
  const stats = { hqFilled: 0, headcountFilled: 0, conflictsWithPublic: 0 };
  const merged = applyPdlCompanyToFields(publicFields, {
    companyName: 'NVIDIA',
    domain: 'nvidia.com',
    pdlData: data,
    matchMeta: match,
    stats
  });
  assert.ok(!isBlankOrUnknown(merged.location.value));
  assert.equal(merged.headcount.value, '10,001+', 'must not overwrite high wikidata headcount');
  assert.equal(merged.pdl.applied.location, true);
  assert.equal(merged.pdl.applied.headcount, false);
});

await checkAsync('disabled without key leaves Unknown', async () => {
  assert.equal(isPdlConfigured({}), false);
  const out = await enrichWithPdlFallback(
    'Acme',
    'acme.com',
    {
      location: fieldRecord(UNKNOWN, 'none', 'low', {}),
      headcount: fieldRecord(UNKNOWN, 'none', 'low', {}),
      founders: fieldRecord(UNKNOWN, 'none', 'low', {})
    },
    { env: {} }
  );
  assert.ok(isBlankOrUnknown(out.location.value));
});

await checkAsync('injectCompany fills unknowns', async () => {
  const out = await enrichWithPdlFallback(
    'Stripe',
    'stripe.com',
    {
      location: fieldRecord(UNKNOWN, 'none', 'low', {}),
      headcount: fieldRecord(UNKNOWN, 'none', 'low', {}),
      founders: fieldRecord(UNKNOWN, 'none', 'low', {})
    },
    {
      env: {},
      enableFounderSearch: false,
      injectCompany: {
        name: 'Stripe',
        website: 'stripe.com',
        likelihood: 10,
        size: '1001-5000',
        location: {
          locality: 'south san francisco',
          region: 'california',
          name: 'south san francisco, california, united states'
        }
      }
    }
  );
  assert.ok(!isBlankOrUnknown(out.headcount.value), `hc=${out.headcount.value}`);
  assert.ok(!isBlankOrUnknown(out.location.value), `loc=${out.location.value}`);
  assert.equal(out.pdl.pdlMatchStatus, 'accepted');
});

console.log(`\n${passed} assertions passed`);
