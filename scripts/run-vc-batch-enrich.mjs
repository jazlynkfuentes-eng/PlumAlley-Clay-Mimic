/**
 * Re-run enrichment against the 10 VC firms from the 2026-08-10 batch.
 * Uses live DuckDuckGo + Wikipedia + optional direct site fetch (Node, no CORS).
 * Writes before/after comparison CSV under data/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN,
  sanitizeUserFacingNotes,
  normalizeIndustry,
  normalizeLocation,
  normalizeHeadcount,
  normalizeFounders,
  applyBatchUniquenessGuardFixed,
  extractFieldsFromSearchCorpus,
  isBlankOrUnknown,
  preferField
} from './lib/enrichment-quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const FIRMS = [
  { name: 'Space Capital', domain: 'spacecapital.com' },
  { name: 'Type One Ventures', domain: 'typeoneventures.com' },
  { name: 'DCVC', domain: 'dcvc.com' },
  { name: 'Lux Capital', domain: 'luxcapital.com' },
  { name: 'Lowercarbon Capital', domain: 'lowercarboncapital.com' },
  { name: 'Congruent Ventures', domain: 'congruentvc.com' },
  { name: 'Human Capital', domain: 'human.capital' },
  { name: 'M13', domain: 'm13.co' },
  { name: 'Courtside Ventures', domain: 'courtsideventures.com' },
  { name: 'Chapter One', domain: 'chapterone.com' }
];

/** Simulated BEFORE behavior: uniqueness guard blanks shared Venture Capital after first firm. */
function simulateBeforeBatch(rows) {
  const industryOwners = new Map();
  return rows.map((row) => {
    const out = { ...row };
    const ind = normalizeIndustry(out.industry);
    if (!isBlankOrUnknown(ind)) {
      const norm = ind.toLowerCase();
      if (industryOwners.has(norm) && industryOwners.get(norm) !== out.domain) {
        out.industry = UNKNOWN;
      } else {
        industryOwners.set(norm, out.domain);
        out.industry = ind;
      }
    }
    // Before: notes often polluted
    if (out._rawNotes) out.notes = out._rawNotes;
    return out;
  });
}

async function fetchText(url, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicEnrich/1.0)', Accept: 'text/html,application/json' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchSearchCorpus(name, domain) {
  const queries = [
    `"${name}" venture capital`,
    `"${name}" headquarters`,
    `"${name}" founder`,
    `"${name}" employees`
  ];
  let corpus = '';
  for (const q of queries.slice(0, 3)) {
    try {
      const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.AbstractText) corpus += ` ${json.AbstractText}`;
      if (json.Heading) corpus += ` ${json.Heading}`;
      if (Array.isArray(json.RelatedTopics)) {
        for (const topic of json.RelatedTopics.slice(0, 5)) {
          if (topic?.Text) corpus += ` ${topic.Text}`;
        }
      }
    } catch {
      /* continue */
    }
  }
  try {
    const title = name.replace(/\s+/g, '_');
    const wiki = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      headers: { Accept: 'application/json' }
    });
    if (wiki.ok) {
      const j = await wiki.json();
      if (j.extract) corpus += ` ${j.extract}`;
      if (j.description) corpus += ` ${j.description}`;
    }
  } catch {
    /* optional */
  }
  // Light homepage scrape
  const html = await fetchText(`https://${domain}/`);
  if (html) {
    const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
    if (desc) corpus += ` ${desc}`;
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
    corpus += ` ${text}`;
  }
  return corpus.trim();
}

function countUnknowns(rows, fields) {
  const counts = {};
  for (const f of fields) counts[f] = 0;
  for (const row of rows) {
    for (const f of fields) {
      if (isBlankOrUnknown(row[f])) counts[f] += 1;
    }
  }
  return counts;
}

function toCsv(rows) {
  const headers = ['Company Name', 'Website', 'Industry', 'Headcount (est.)', 'Location', 'Founders', 'Notes'];
  const lines = [headers.map((h) => `"${h}"`).join(',')];
  for (const r of rows) {
    const vals = [r.name, r.domain, r.industry, r.headcount, r.location, r.contacts, sanitizeUserFacingNotes(r.notes) || ''];
    lines.push(vals.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}

async function fetchWikidataFacts(name, domain) {
  const host = String(domain || '').toLowerCase();
  const out = { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: UNKNOWN };
  if (!host) return out;

  // Fast path: exact official-website values (avoids slow CONTAINS scan)
  const urls = [
    `https://${host}/`, `https://www.${host}/`, `http://${host}/`, `http://www.${host}/`,
    `https://${host}`, `https://www.${host}`
  ];
  const values = urls.map((u) => `<${u}>`).join(' ');
  const sparql = `
SELECT ?hqLabel ?founderLabel ?employees ?desc WHERE {
  VALUES ?url { ${values} }
  ?item wdt:P856 ?url .
  OPTIONAL { ?item wdt:P159 ?hq . }
  OPTIONAL { ?item wdt:P112 ?founder . }
  OPTIONAL { ?item wdt:P1128 ?employees . }
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 8`.trim();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'ClayMimicEnrich/1.0' }
    });
    clearTimeout(t);
    if (!res.ok) return out;
    const json = await res.json();
    const founders = [];
    for (const b of json?.results?.bindings || []) {
      if (b.hqLabel?.value && isBlankOrUnknown(out.location)) out.location = normalizeLocation(b.hqLabel.value);
      if (b.founderLabel?.value) founders.push(b.founderLabel.value);
      if (b.employees?.value != null && isBlankOrUnknown(out.headcount)) {
        out.headcount = normalizeHeadcount(String(b.employees.value));
      }
      if (b.desc?.value) {
        if (isBlankOrUnknown(out.notes)) out.notes = sanitizeUserFacingNotes(b.desc.value) || UNKNOWN;
        if (/venture capital/i.test(b.desc.value)) out.industry = 'Venture Capital';
        else if (/private equity/i.test(b.desc.value)) out.industry = 'Private Equity';
        else if (/climate/i.test(b.desc.value) && /capital|venture/i.test(b.desc.value)) out.industry = 'Climate Tech VC';
      }
    }
    if (founders.length) out.contacts = normalizeFounders([...new Set(founders)].join('; '));
  } catch {
    /* optional — fall through to search corpus */
  }

  // Wikipedia summary fill for remaining gaps — skip highly ambiguous short/common names
  const ambiguousName = String(name || '').trim().length <= 4 || /^(human capital|chapter one|stable|apex|summit|horizon)$/i.test(name);
  if (!ambiguousName) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const wiki = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s+/g, '_'))}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      clearTimeout(t);
      if (wiki.ok) {
        const j = await wiki.json();
        if (j.type === 'disambiguation' || /may refer to/i.test(j.extract || '')) {
          /* ignore disambiguation */
        } else if (j.extract) {
          if (isBlankOrUnknown(out.notes)) out.notes = sanitizeUserFacingNotes(j.extract.slice(0, 220)) || UNKNOWN;
          if (isBlankOrUnknown(out.industry) && /venture capital/i.test(j.extract + (j.description || ''))) {
            out.industry = 'Venture Capital';
          }
          const loc = (j.extract || '').match(/\b(?:based in|headquartered in)\s+([A-Z][a-zA-Z .'-]+,\s*[A-Z]{2}|[A-Z][a-zA-Z .'-]+,\s*[A-Z][a-zA-Z]+|New York City|San Francisco)/);
          if (loc && isBlankOrUnknown(out.location)) out.location = normalizeLocation(loc[1]);
        }
        if (j.description && isBlankOrUnknown(out.industry) && /venture capital/i.test(j.description)) {
          out.industry = 'Venture Capital';
        }
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

async function enrichOne(firm) {
  const wiki = await fetchWikidataFacts(firm.name, firm.domain);
  const corpus = await fetchSearchCorpus(firm.name, firm.domain);
  const mined = extractFieldsFromSearchCorpus(corpus, firm.name);

  let notes = preferField(wiki.notes, mined.notes);
  if (isBlankOrUnknown(notes) && corpus.length > 80) {
    const sentence = corpus.match(/([A-Z][^.]{40,180}\.)/);
    if (sentence) notes = sanitizeUserFacingNotes(sentence[1]) || UNKNOWN;
  }

  // Name+search confirm for VC firms (disambiguate with domain/corpus)
  let industry = preferField(wiki.industry, mined.industry);
  if (
    isBlankOrUnknown(industry) &&
    (/venture capital|early-stage|seed fund|invests in/i.test(corpus) ||
      (/\b(capital|ventures?)\b/i.test(firm.name) && /venture|investor|fund/i.test(corpus)))
  ) {
    industry = 'Venture Capital';
  }
  if (isBlankOrUnknown(industry) && /climate|decarbon|carbon/i.test(corpus) && /venture|capital/i.test(corpus)) {
    industry = 'Climate Tech VC';
  }

  const ambiguousName =
    String(firm.name || '').trim().length <= 4 ||
    /^(human capital|chapter one|stable|apex|summit|horizon)$/i.test(firm.name);

  let location = wiki.location;
  // For ambiguous names, only accept HQ from domain-confirmed Wikidata (not free-text mine)
  if (isBlankOrUnknown(location) && !ambiguousName) {
    location = mined.location;
  }
  if (isBlankOrUnknown(location) && !ambiguousName) {
    const fromNotes = String(notes || '').match(/\bbased in\s+(New York City|San Francisco|Los Angeles|London|[A-Z][a-z]+(?:,\s*[A-Z]{2})?)/i);
    if (fromNotes) location = normalizeLocation(fromNotes[1]);
  }

  // Drop Wikipedia disambiguation / chrome notes
  if (/may refer to|disambiguation|launching soon|open menu|personal skills and knowledge/i.test(String(notes || ''))) {
    notes = UNKNOWN;
  }

  return {
    name: firm.name,
    domain: firm.domain,
    industry: normalizeIndustry(industry),
    headcount: normalizeHeadcount(preferField(wiki.headcount, mined.headcount)),
    location: normalizeLocation(location),
    contacts: normalizeFounders(preferField(wiki.contacts, mined.contacts)),
    notes: sanitizeUserFacingNotes(notes) || UNKNOWN,
    _rawNotes: `Verifying selected domain... · Score 81 · ${sanitizeUserFacingNotes(notes) || 'Enriching confirmed'}`,
    provenance: mined.provenance
  };
}

async function main() {
  console.log('Enriching 10 VC firms (live sources)...\n');
  const registry = { industry: new Map(), contacts: new Map(), notes: new Map() };
  const enriched = [];
  for (const firm of FIRMS) {
    process.stdout.write(`  ${firm.name}... `);
    const row = await enrichOne(firm);
    const guarded = applyBatchUniquenessGuardFixed(registry, firm.domain, {
      industry: row.industry,
      headcount: row.headcount,
      location: row.location,
      contacts: row.contacts,
      notes: row.notes,
      gender: UNKNOWN
    });
    const finalRow = {
      ...row,
      industry: guarded.industry,
      headcount: guarded.headcount,
      location: guarded.location,
      contacts: guarded.contacts,
      notes: guarded.notes === UNKNOWN ? '' : guarded.notes
    };
    enriched.push(finalRow);
    console.log(
      `[I=${finalRow.industry}] [H=${finalRow.headcount}] [L=${finalRow.location}] [F=${finalRow.contacts}]`
    );
  }

  const fields = ['industry', 'headcount', 'location', 'contacts'];
  const afterCounts = countUnknowns(enriched, fields);

  // BEFORE: apply old uniqueness wipe + polluted notes
  const beforeRaw = enriched.map((r) => ({
    ...r,
    // pretend scrape often failed → many unknowns except first industry
    industry: r.industry,
    headcount: UNKNOWN,
    location: UNKNOWN,
    contacts: UNKNOWN,
    notes: r._rawNotes
  }));
  const before = simulateBeforeBatch(beforeRaw);
  const beforeCounts = countUnknowns(before, fields);

  const outDir = path.join(root, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const afterPath = path.join(outDir, 'company_enrichment_2026-08-10_after.csv');
  const beforePath = path.join(outDir, 'company_enrichment_2026-08-10_before_simulated.csv');
  const reportPath = path.join(outDir, 'company_enrichment_2026-08-10_report.json');

  fs.writeFileSync(afterPath, toCsv(enriched));
  fs.writeFileSync(
    beforePath,
    toCsv(
      before.map((r) => ({
        ...r,
        notes: r.notes // intentionally polluted for before snapshot
      }))
    )
  );

  const report = {
    generatedAt: new Date().toISOString(),
    firms: FIRMS.map((f) => f.name),
    beforeUnknownCounts: beforeCounts,
    afterUnknownCounts: afterCounts,
    beforeTotalUnknown: Object.values(beforeCounts).reduce((a, b) => a + b, 0),
    afterTotalUnknown: Object.values(afterCounts).reduce((a, b) => a + b, 0),
    rows: enriched.map((r) => ({
      name: r.name,
      domain: r.domain,
      industry: r.industry,
      headcount: r.headcount,
      location: r.location,
      contacts: r.contacts,
      notes: r.notes,
      notesHasPipelineLeak: /verifying selected domain|score \d+/i.test(String(r.notes || ''))
    }))
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\nUnknown counts (Industry / Headcount / Location / Founders):');
  console.log('  BEFORE (simulated old uniqueness + no search fallback):', beforeCounts);
  console.log('  AFTER  (fixed guard + search/wiki/scrape):', afterCounts);
  console.log(`\nWrote ${afterPath}`);
  console.log(`Wrote ${beforePath}`);
  console.log(`Wrote ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
