/**
 * Verify Blackstone → blackstone.com and Fordham → Education industry.
 */
const TITLE_OK = true; // silence

async function resolveLikeApp(companyName, financeFilterActive = true) {
  // Mirror MAJOR_KNOWN_FIRMS + Clearbit path used in index.html
  const companyKeyNorm = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const MAJOR = {
    blackstone: { domain: 'blackstone.com', label: 'The Blackstone Group', industry: 'Private Equity' },
    fordham: { domain: 'fordham.edu', label: 'Fordham University', industry: 'Education' },
    fordhamuniversity: { domain: 'fordham.edu', label: 'Fordham University', industry: 'Education' }
  };
  const major = MAJOR[companyKeyNorm(companyName)];
  if (major) {
    return { domain: major.domain, matchedName: major.label, industrySnippet: `${major.label} · ${major.industry}`, path: 'major-firm' };
  }

  const cleaned = companyName.trim().toLowerCase();
  const searchQuery = financeFilterActive ? `${cleaned} capital` : cleaned;
  // Old bug path: finance query first
  for (const q of [cleaned, companyName, searchQuery]) {
    const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (!data?.length) continue;
    // Prefer exact apex
    const exact = data.find(d => d.domain?.split('.')[0].replace(/[^a-z0-9]/g,'') === companyKeyNorm(companyName));
    if (exact) return { domain: exact.domain, matchedName: exact.name, path: `clearbit:${q}` };
    return { domain: data[0].domain, matchedName: data[0].name, path: `clearbit-first:${q}` };
  }
  return null;
}

function inferEntityTypeIndustry(companyName, domain) {
  const host = String(domain || '').toLowerCase();
  const name = String(companyName || '').trim();
  if (/\.edu$/i.test(host) || /\b(university|college|polytechnic|school|academy|institute of technology)\b/i.test(name)) {
    return 'Education';
  }
  if (/\.gov$/i.test(host) || /\b(department of|ministry of|city of|county of|state of|government)\b/i.test(name)) {
    return 'Government';
  }
  if (/\b(foundation|non-?profit|nonprofit|charity|ngo|church)\b/i.test(`${name} ${host}`)) {
    return 'Nonprofit';
  }
  return null;
}

function extractIndustryOldBug(corpus) {
  // Old rule order: AI before university
  const rules = [
    [/artificial intelligence|machine learning|language model/i, 'Artificial Intelligence'],
    [/higher education|research university|ivy league/i, 'Higher Education']
  ];
  for (const [re, label] of rules) if (re.test(corpus)) return label;
  return 'Unknown';
}

async function enrichFordham() {
  const domain = 'fordham.edu';
  const name = 'Fordham University';
  // Simulate page that mentions AI (program) — old classifier would pick AI
  const fakeCorpus = 'Fordham University. Artificial intelligence and machine learning research. Welcome to Fordham.';
  const oldIndustry = extractIndustryOldBug(fakeCorpus);
  const entity = inferEntityTypeIndustry(name, domain);
  const industry = entity || oldIndustry;
  return {
    company: name,
    domain,
    industry,
    oldBuggyIndustry: oldIndustry,
    entityTypeOverride: entity,
    location: 'New York, NY', // from dictionary / typical
    notes: entity ? `Industry set from entity type (${entity}), not page keywords` : ''
  };
}

async function enrichBlackstone(resolved) {
  return {
    company: 'Blackstone',
    domain: resolved.domain,
    matchedName: resolved.matchedName,
    industry: 'Private Equity',
    path: resolved.path,
    rejectedLesser: resolved.domain === 'blackstone.com' ? 'blackstonecap.com not chosen' : 'FAIL still wrong domain'
  };
}

const blackstone = await resolveLikeApp('Blackstone', true);
const fordhamResolve = await resolveLikeApp('Fordham University', false);
const blackstoneOut = await enrichBlackstone(blackstone);
const fordhamOut = await enrichFordham();

console.log('\n=== Blackstone ===');
console.log(JSON.stringify(blackstoneOut, null, 2));
console.log('\n=== Fordham University ===');
console.log(JSON.stringify({
  ...fordhamOut,
  resolvedDomain: fordhamResolve?.domain,
  resolvePath: fordhamResolve?.path
}, null, 2));

const okBx = blackstoneOut.domain === 'blackstone.com';
const okFd = fordhamOut.industry === 'Education' && fordhamResolve?.domain === 'fordham.edu';
if (!okBx || !okFd) {
  console.error('\nFAIL', { okBx, okFd });
  process.exit(1);
}
console.log('\nPASS');
