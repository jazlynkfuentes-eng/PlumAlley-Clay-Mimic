/**
 * Verify resolve gathers picker candidates for key test companies.
 * Mirrors the Clearbit gather + first-token query expansion in index.html.
 */
function normalizeCandidates(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of list || []) {
      let domain = '', name = '', snippet = '';
      if (typeof item === 'string') {
        if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(item)) {
          domain = item.toLowerCase();
          name = domain;
        } else continue;
      } else if (item && typeof item === 'object') {
        domain = String(item.domain || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
        name = item.name || domain;
        snippet = item.snippet || '';
      }
      if (!domain || !domain.includes('.') || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, name, snippet });
    }
  }
  return out;
}

function getCleanedQuery(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[,.]?\s*\b(inc|llc|co|corp|corporation|ltd|limited|gmbh|sa|as|ab|oy|bv|nv|pvt|plc|holdings|group|associates|global|international|advisors|management|consulting|services|solutions|systems|technologies|networks|labs|digital|media|design|creative|agency|studio|studios|collective|cooperative|coop|ventures|ventures\s+capital|capital|partners)\b/gi, '')
    .replace(/^the\s+/i, '')
    .replace(/\bcompany\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function gatherFor(companyName) {
  const cleaned = getCleanedQuery(companyName);
  const firstToken = cleaned.split(/\s+/)[0];
  const STOP_TOKENS = new Set(['office', 'west', 'new', 'the', 'city', 'of', 'and', 'for', 'group', 'fund', 'private', 'public', 'global', 'international', 'united', 'american', 'national']);
  const strippedLegal = companyName.replace(/\b(llc|inc|ltd|limited|corp|corporation|co)\b/gi, '').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
  const strippedOrgSuffix = companyName.replace(/\b(foundation|endowment|trust)\b/gi, '').replace(/^office of\s+/i, '').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
  const queries = [
    strippedLegal,
    strippedOrgSuffix,
    cleaned,
    companyName.replace(/&/g, ' ').replace(/\s+/g, ' ').trim(),
    companyName,
    (firstToken && firstToken.length >= 4 && !STOP_TOKENS.has(firstToken.toLowerCase())) ? firstToken : null
  ].filter((q, i, a) => q && String(q).trim().length >= 2 && a.indexOf(q) === i);

  let gathered = [];
  for (const q of queries) {
    try {
      const r = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`);
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        gathered = normalizeCandidates(
          gathered,
          data.map((item) => ({ domain: item.domain, name: item.name, snippet: `${item.name} · ${item.domain}` }))
        );
      }
    } catch (_) {}
  }

  // Light wiki fallback for orgs
  if (gathered.length < 2 && /\b(office|university|foundation|comptroller|partners)\b/i.test(companyName)) {
    try {
      const openRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(companyName)}&limit=5&namespace=0&format=json&origin=*`
      );
      const openJson = await openRes.json();
      const title = (openJson[1] || [])[0];
      if (title) {
        const wdRes = await fetch(
          `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(title)}&props=claims|descriptions&languages=en&format=json&origin=*`
        );
        const wd = await wdRes.json();
        const entity = Object.values(wd.entities || {}).find((e) => e?.claims?.P856);
        const url = entity?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
        if (url) {
          const domain = String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
          gathered = normalizeCandidates(gathered, [{ domain, name: title, snippet: entity?.descriptions?.en?.value || title }]);
        }
      }
    } catch (_) {}
  }

  return { queries, gathered };
}

const names = [
  'CANY Capital LLC',
  'Office of New York City Comptroller',
  'West Virginia University Foundation',
  'Helios & Partners Limited'
];

for (const name of names) {
  const { queries, gathered } = await gatherFor(name);
  console.log('\n' + name);
  console.log(' queries:', queries.join(' | '));
  console.log(' candidates:', gathered.length);
  gathered.slice(0, 5).forEach((c, i) => console.log(`  ${i + 1}. ${c.name} — ${c.domain}`));
  if (!gathered.length) console.log('  FAIL: zero candidates');
}

const cany = (await gatherFor('CANY Capital LLC')).gathered;
const ok = cany.some((c) => /canyon\.com/i.test(c.domain));
console.log('\nCANY includes canyon.com?', ok);
process.exit(ok && cany.length > 0 ? 0 : 1);
