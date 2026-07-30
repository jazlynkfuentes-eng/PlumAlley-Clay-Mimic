/**
 * Live-parity audit for the user's exact pasted 63-row contact list.
 * Mode: finance ON, no dictionary short-circuit (same as --mode=live-parity).
 */
import fs from 'fs';
import {
  resolveHard,
  shouldAutoFound,
  classifyFinanceAffinity,
  mapPool,
  CONFIDENCE_THRESHOLD,
  AUTO_FOUND_THRESHOLD
} from './lib/hard-sample-resolver.mjs';

// Exact right-hand company fields from the user's paste (63 rows, order preserved)
const ROWS = [
  'Cara Advisory',
  'Office of New York City Comptroller',
  'West Virginia University Foundation',
  'NAV Fund Services',
  'PIMCO',
  'Private Fund (Moderator)',
  'Stable',
  'Albourne',
  'CANY Capital LLC',
  'Stable Asset Management',
  'SFG Asset Advisors (Moderator)',
  'Marex Capital Markets',
  'Summit Rock Advisors (Moderator)',
  'State of Wisconsin Investment Board (SWIB)',
  'Milken Institute',
  '100WF',
  'IH International Advisors',
  'Charles Stewart Mott Foundation',
  'Willkie Farr & Gallagher LLP',
  "Children's Health System of Texas",
  'Salt Creek Capital',
  'Marex Capital Markets',
  'Helios & Partners Limited',
  'Archer Asia – Rockhampton Management Limited',
  'Courage Small Business Partners',
  "Los Angeles City Employees' Retirement System",
  'Heard Capital',
  'Cara Advisory',
  'Strategic Investment Group',
  'Mellon Foundation',
  'Disciplina Capital Management / Disciplina Group LLC',
  'UBS Hedge Fund Solutions',
  'The Kresge Foundation',
  'Blackstone',
  'Northside Capital Management LLC',
  'Illinois Municipal Retirement Fund',
  'Morgan Stanley Wealth Management',
  'Morgan Stanley Wealth Management (Moderator)',
  'UBS',
  'Fordham University',
  'TSWII Capital Advisors',
  'Avala Global',
  'The Robert Wood Johnson Foundation',
  'Lumen Global Investments LLC',
  'dakota Marketplace',
  'MetLife Investment Management',
  'University of Rochester',
  'TIDE',
  'Impactus Partners; 100WF Board Member (Moderator)',
  'Angeles Wealth Management LLC',
  'Mayar Capital (Moderator)',
  'Willkie Farr & Gallagher LLP',
  'Milken Institute',
  'Northern Trust',
  'California Public Employees\' Retirement System (CalPERS)',
  'Teachers Retirement System of Texas (TRS)',
  'Milken Institute',
  'Lakeview Capital Management',
  'Trinity Church Wall Street',
  'Power100',
  'CPP Investments',
  'Gilder Office for Growth',
  'Inatai Foundation (FKA Group Health Foundation)'
];

function isSkippedLikeLiveUi(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^private fund$/i.test(n)) return true;
  if (/^(n\/?a|none|null|tbd|placeholder)$/i.test(n)) return true;
  // Live resolveDomain skips ANY label containing (Moderator)
  if (/\(\s*moderator\s*\)/i.test(n)) return true;
  return false;
}

function classifyStatus(resolved) {
  if (!resolved?.domain) return { status: 'unverified', reason: 'no-domain' };
  const score = Number(resolved.score) || 0;
  const method = resolved.resolveMethod || (resolved.sources || [])[0] || 'multi-source';
  if (shouldAutoFound(resolved)) {
    return { status: 'found', reason: `${method}@${score}` };
  }
  if (score >= CONFIDENCE_THRESHOLD || resolved.confidence === 'high' || (resolved.candidates || []).length) {
    return { status: 'potential', reason: `${method}@${score}${resolved.ambiguous ? ', ambiguous' : ''}` };
  }
  return { status: 'unverified', reason: `below-threshold:${score}` };
}

console.log('='.repeat(64));
console.log('MODE: live-parity  ← finance ON, no dictionary short-circuit');
console.log('Moderator handling: skip (matches live resolveDomain)');
console.log(`Exact pasted list: ${ROWS.length} rows`);
console.log(`auto-Found ≥${AUTO_FOUND_THRESHOLD} | picker ≥${CONFIDENCE_THRESHOLD}`);
console.log('='.repeat(64));
console.log('');

const results = await mapPool(ROWS, 2, async (name, idx) => {
  const row = idx + 1;
  if (isSkippedLikeLiveUi(name)) {
    return {
      row, name, status: 'unverified', reason: 'skipped-moderator-or-non-entity',
      score: 0, domain: null, method: 'skipped'
    };
  }

  const resolved = await resolveHard(name, {
    financeFilterActive: true,
    skipDictionary: true
  });

  const score = Number(resolved.score) || 0;
  const method = resolved.resolveMethod || (resolved.sources || [])[0] || 'none';
  const financePts = resolved.signals?.finance ?? null;
  const affinity = resolved.domain
    ? classifyFinanceAffinity({ name, domain: resolved.domain, snippet: '' }, name)
    : 'n/a';

  if (!resolved.domain) {
    return {
      row, name, status: 'unverified', reason: 'no-domain',
      score, method, domain: null, financePts, affinity
    };
  }

  if (resolved.dnsOk === false) {
    return {
      row, name, status: 'unverified', reason: `dns-fail:${resolved.domain}`,
      score, method, domain: resolved.domain, financePts, affinity
    };
  }

  const { status, reason } = classifyStatus(resolved);
  return {
    row,
    name,
    status,
    reason,
    score,
    method,
    domain: resolved.domain,
    financePts,
    affinity,
    soleFinance: !!resolved.soleFinanceMatch,
    ambiguous: !!resolved.ambiguous,
    autoFound: shouldAutoFound(resolved)
  };
});

const found = results.filter((r) => r.status === 'found');
const potential = results.filter((r) => r.status === 'potential');
const unverified = results.filter((r) => r.status === 'unverified');

console.log('=== BREAKDOWN [live-parity | exact pasted 63] ===');
console.log(`Total rows:       ${results.length}`);
console.log(`Found:            ${found.length}`);
console.log(`Potential:        ${potential.length}`);
console.log(`Unverified:       ${unverified.length}`);
console.log('');

console.log('--- Found ---');
for (const r of found) {
  console.log(
    `  #${String(r.row).padStart(2)} ${r.name}  → ${r.domain}  ${r.method}@${r.score}` +
    ` financePts=${r.financePts ?? '-'} affinity=${r.affinity}`
  );
}
console.log('');
console.log('--- Potential ---');
for (const r of potential) {
  console.log(
    `  #${String(r.row).padStart(2)} ${r.name}  → ${r.domain}  score=${r.score}` +
    ` financePts=${r.financePts ?? '-'} (${r.reason})`
  );
}
console.log('');
console.log('--- Unverified ---');
for (const r of unverified) {
  console.log(`  #${String(r.row).padStart(2)} ${r.name}  (${r.reason}${r.domain ? ' ' + r.domain : ''})`);
}

fs.writeFileSync(
  new URL('./last-exact-63-live-parity.json', import.meta.url),
  JSON.stringify({
    mode: 'live-parity',
    label: 'live-parity on exact user-pasted 63 rows (finance ON, no dictionary short-circuit)',
    summary: {
      total: results.length,
      found: found.length,
      potential: potential.length,
      unverified: unverified.length,
      autoFoundThreshold: AUTO_FOUND_THRESHOLD,
      pickerThreshold: CONFIDENCE_THRESHOLD
    },
    results
  }, null, 2)
);
console.log('\nWrote scripts/last-exact-63-live-parity.json');
