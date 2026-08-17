/**
 * Live Wikidata smoke check for founding-team names + gender.
 * Precision-first: Unknown is allowed. Wrong CEO-as-founder or Male when a
 * known woman founder exists is a failure (VC screening false negative).
 */
import {
  UNKNOWN,
  isBlankOrUnknown,
  normalizeFounders,
  genderFromWikidataQid,
  summarizeFoundingTeamGender
} from './lib/enrichment-quality.mjs';
import { personNameKey } from './lib/field-enrich.mjs';

const CASES = [
  {
    name: 'Apple',
    domain: 'apple.com',
    reject: ['Tim Cook']
  },
  {
    name: 'Microsoft',
    domain: 'microsoft.com',
    reject: ['Satya Nadella']
  },
  {
    name: 'Stripe',
    domain: 'stripe.com',
    reject: ['Tim Cook']
  },
  {
    name: 'Anthropic',
    domain: 'anthropic.com',
    womanFounder: 'Daniela Amodei',
    expectHasFemaleIfPopulated: true
  },
  {
    name: 'Canva',
    domain: 'canva.com',
    womanFounder: 'Melanie Perkins',
    expectHasFemaleIfPopulated: true
  },
  {
    name: '23andMe',
    domain: '23andme.com',
    womanFounder: 'Anne Wojcicki',
    expectHasFemaleIfPopulated: true
  }
];

function nameSet(raw) {
  return new Set(
    String(raw || '')
      .split(/\s*;\s*/)
      .map((n) => personNameKey(n))
      .filter(Boolean)
  );
}

function hasPerson(got, expected) {
  const g = nameSet(got);
  const key = personNameKey(expected);
  return [...g].some((n) => n === key || n.includes(key) || key.includes(n));
}

async function fetchWikidataFounders(domain) {
  const host = String(domain || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  const urls = [
    `https://${host}/`, `https://www.${host}/`, `http://${host}/`, `http://www.${host}/`,
    `https://${host}`, `https://www.${host}`
  ];
  const values = urls.map((u) => `<${u}>`).join(' ');
  const sparql = `
SELECT DISTINCT ?founderLabel ?genderId WHERE {
  VALUES ?url { ${values} }
  ?item wdt:P856 ?url .
  OPTIONAL {
    ?item wdt:P112 ?founder .
    OPTIONAL { ?founder wdt:P21 ?genderId . }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 24`.trim();

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': 'ClayMimicFounderEval/1.0 (precision-first screening)'
        }
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
      const json = await res.json();
      const byName = new Map();
      for (const b of json?.results?.bindings || []) {
        const fname = b.founderLabel?.value;
        if (!fname) continue;
        const g = genderFromWikidataQid(b.genderId?.value);
        const prev = byName.get(fname);
        if (!prev || (prev === UNKNOWN && g !== UNKNOWN)) byName.set(fname, g);
      }
      const founders = normalizeFounders([...byName.keys()].join('; '));
      const genders = [...byName.values()];
      return {
        founders: isBlankOrUnknown(founders) ? UNKNOWN : founders,
        gender: summarizeFoundingTeamGender(genders)
      };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

function scoreCase(entry, got) {
  const populated = !isBlankOrUnknown(got.founders);
  const reasons = [];

  for (const bad of entry.reject || []) {
    if (hasPerson(got.founders, bad)) reasons.push(`rejected name present: ${bad}`);
  }
  if (populated) {
    for (const need of entry.mustIncludeIfPopulated || []) {
      if (!hasPerson(got.founders, need)) reasons.push(`missing founder: ${need}`);
    }
    if (entry.expectHasFemaleIfPopulated) {
      const g = String(got.gender || '');
      if (/\bmale\b/i.test(g) && !/\bfemale\b/i.test(g)) {
        reasons.push(`gender marked Male while a woman founder is expected (${got.gender})`);
      }
    }
  }

  if (reasons.length) return { outcome: 'fail', reasons };
  if (!populated) return { outcome: 'unknown', reasons: ['Wikidata had no founders'] };
  return { outcome: 'pass', reasons: [] };
}

let failed = 0;
let unknown = 0;
console.log('Live Wikidata founding-team check\n');

for (const entry of CASES) {
  let got;
  try {
    got = await fetchWikidataFounders(entry.domain);
  } catch (e) {
    console.log(`${entry.name}: SKIP (${e.message})`);
    unknown += 1;
    continue;
  }
  const scored = scoreCase(entry, got);
  const mark = scored.outcome === 'pass' ? 'PASS' : scored.outcome === 'unknown' ? 'UNKNOWN' : 'FAIL';
  console.log(`${entry.name}: ${mark}`);
  console.log(`  founders: ${got.founders}`);
  console.log(`  gender:   ${got.gender}`);
  if (scored.reasons.length) console.log(`  ${scored.reasons.join('; ')}`);
  if (scored.outcome === 'fail') failed += 1;
  if (scored.outcome === 'unknown') unknown += 1;
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\n${CASES.length - failed - unknown} pass, ${unknown} unknown, ${failed} fail`);
if (failed) process.exit(1);
console.log('No incorrect CEO-as-founder or Male-instead-of-woman results.');
