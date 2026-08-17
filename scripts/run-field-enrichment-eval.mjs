/**
 * Field enrichment evaluation: HQ, Founders, Headcount.
 * Precision-first. Identity must be resolved (domain provided in fixtures).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN, isBlankOrUnknown } from './lib/enrichment-quality.mjs';
import {
  enrichResolvedFields,
  locationEquivalent,
  foundersEquivalent,
  classifyFounderMatch,
  headcountEquivalent
} from './lib/field-enrich.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fixturePath = path.join(root, 'data/eval/field-enrichment-companies.json');

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function fetchHtml(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'ClayMimicFieldEval/1.0', Accept: 'text/html' }, redirect: 'follow' },
      4500
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function searchSnippets(query) {
  const out = [];
  try {
    const res = await fetchWithTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      {},
      4500
    );
    if (!res.ok) return out;
    const json = await res.json();
    if (json.AbstractText) {
      out.push({ snippet: json.AbstractText, title: json.Heading || '', url: json.AbstractURL || null });
    }
    for (const rel of (json.RelatedTopics || []).slice(0, 6)) {
      out.push({ snippet: rel.Text || '', title: '', url: rel.FirstURL || null });
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function fetchWikidataEntity(name) {
  try {
    const searchRes = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=5&origin=*`,
      { headers: { Accept: 'application/json' } },
      4500
    );
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const hit = (searchJson.search || []).find(
      (h) => !/disambiguation|family name|given name/i.test(h.description || '')
    ) || searchJson.search?.[0];
    if (!hit?.id) return null;
    const entRes = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hit.id}&props=claims|labels&languages=en&format=json&origin=*`,
      { headers: { Accept: 'application/json' } },
      5000
    );
    if (!entRes.ok) return null;
    const entJson = await entRes.json();
    return { id: hit.id, entity: entJson.entities?.[hit.id], label: hit.label };
  } catch {
    return null;
  }
}

async function labelForId(id) {
  try {
    const res = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&props=labels&languages=en&format=json&origin=*`,
      {},
      4000
    );
    if (!res.ok) return null;
    const j = await res.json();
    return j.entities?.[id]?.labels?.en?.value || null;
  } catch {
    return null;
  }
}

async function fetchWikipediaSummary(name) {
  try {
    const res = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s+/g, '_'))}`,
      { headers: { Accept: 'application/json' } },
      4500
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (j.type === 'disambiguation') return null;
    return { extract: j.extract || '', url: j.content_urls?.desktop?.page || null };
  } catch {
    return null;
  }
}

async function fetchWikidataHq(name) {
  const data = await fetchWikidataEntity(name);
  const claims = data?.entity?.claims?.P159;
  if (!claims?.length) return null;
  const id = claims[0]?.mainsnak?.datavalue?.value?.id;
  if (!id) return null;
  const label = await labelForId(id);
  if (!label) return null;
  return { location: label, evidence: `Wikidata P159 → ${label}`, url: `https://www.wikidata.org/wiki/${data.id}` };
}

async function fetchWikidataFounders(name) {
  const data = await fetchWikidataEntity(name);
  const claims = data?.entity?.claims?.P112;
  if (!claims?.length) return null;
  const names = [];
  for (const c of claims.slice(0, 6)) {
    const id = c?.mainsnak?.datavalue?.value?.id;
    if (!id) continue;
    const label = await labelForId(id);
    if (label) names.push(label);
  }
  if (!names.length) return null;
  return {
    founders: names.join('; '),
    evidence: `Wikidata P112 → ${names.join('; ')}`,
    url: `https://www.wikidata.org/wiki/${data.id}`
  };
}

async function fetchWikidataEmployees(name) {
  const data = await fetchWikidataEntity(name);
  const claims = data?.entity?.claims?.P1128;
  if (!claims?.length) return null;
  const amount = claims[0]?.mainsnak?.datavalue?.value?.amount;
  if (amount == null) return null;
  const n = String(amount).replace(/^\+/, '');
  return {
    employees: n,
    evidence: `Wikidata P1128 → ${n}`,
    url: `https://www.wikidata.org/wiki/${data.id}`
  };
}

function scoreLocation(got, entry) {
  if (isBlankOrUnknown(got)) return 'unknown';
  if (!entry.expectedLocation) return 'unknown';
  return locationEquivalent(got, entry.expectedLocation, entry.altLocations) ? 'correct' : 'incorrect';
}

function scoreFounders(got, entry) {
  return classifyFounderMatch(got, entry.expectedFounders, entry.altFounders, {
    foundersApplicable: entry.foundersApplicable !== false && entry.expectedFounders != null
  });
}

function scoreHeadcount(got, entry) {
  if (isBlankOrUnknown(got)) return 'unknown';
  if (!entry.expectedHeadcount) return 'unknown';
  return headcountEquivalent(got, entry.expectedHeadcount, entry.altHeadcounts) ? 'correct' : 'incorrect';
}

function summarizeField(outcomes, { includeNA = false } = {}) {
  const correct = outcomes.filter((o) => o === 'correct').length;
  const incorrect = outcomes.filter((o) => o === 'incorrect').length;
  const unknown = outcomes.filter((o) => o === 'unknown').length;
  const notApplicable = outcomes.filter((o) => o === 'not_applicable').length;
  const populated = correct + incorrect;
  const applicable = includeNA
    ? outcomes.length - notApplicable
    : outcomes.filter((o) => o !== 'not_applicable').length;
  const precision = populated ? Math.round((correct / populated) * 1000) / 10 : 0;
  const coverage = applicable ? Math.round((populated / applicable) * 1000) / 10 : 0;
  return { correct, incorrect, unknown, notApplicable, populated, applicable, precision, coverage };
}

function summarizeFounders(rows) {
  const details = rows.map((r) => r.foundersDetail).filter(Boolean);
  const outcomes = details.map((d) => d.outcome);
  const exactComplete = outcomes.filter((o) => o === 'exact_complete').length;
  const correctPartial = outcomes.filter((o) => o === 'correct_partial').length;
  const incorrect = outcomes.filter((o) => o === 'incorrect').length;
  const unknown = outcomes.filter((o) => o === 'unknown').length;
  const notApplicable = outcomes.filter((o) => o === 'not_applicable').length;
  const populated = exactComplete + correctPartial + incorrect;
  const applicable = rows.length - notApplicable;
  // Exact-set precision: fully correct sets / all populated
  const exactPrecision = populated ? Math.round((exactComplete / populated) * 1000) / 10 : 0;
  // Legacy "precision" for gate: person-accurate populated (exact + partial) / populated
  const personAccuratePopulated = exactComplete + correctPartial;
  const personSetPrecision = populated ? Math.round((personAccuratePopulated / populated) * 1000) / 10 : 0;
  const coverage = applicable ? Math.round((populated / applicable) * 1000) / 10 : 0;

  let correctPersons = 0;
  let totalPersons = 0;
  let matchedForCompleteness = 0;
  let expectedForCompleteness = 0;
  for (const d of details) {
    if (d.outcome === 'not_applicable' || d.outcome === 'unknown') continue;
    totalPersons += d.gotKeys?.length || 0;
    correctPersons += d.matchedKeys?.length || 0;
    if (d.outcome === 'exact_complete' || d.outcome === 'correct_partial' || d.outcome === 'incorrect') {
      expectedForCompleteness += d.expectedKeys?.length || 0;
      matchedForCompleteness += (d.matchedKeys || []).filter((m) =>
        (d.expectedKeys || []).some((e) => e === m || e.includes(m) || m.includes(e))
      ).length;
    }
  }
  // For incorrect rows, matchedKeys are still valid names; completeness should count only correct matches
  const personPrecision = totalPersons ? Math.round((correctPersons / totalPersons) * 1000) / 10 : 0;
  const completeness =
    expectedForCompleteness > 0
      ? Math.round((matchedForCompleteness / expectedForCompleteness) * 1000) / 10
      : 0;

  const partialCases = rows
    .filter((r) => r.foundersDetail?.outcome === 'correct_partial')
    .map((r) => ({
      name: r.name,
      got: r.founders,
      missing: r.foundersDetail.missingKeys,
      matched: r.foundersDetail.matchedKeys,
      expected: r.foundersDetail.expectedKeys
    }));

  return {
    exactComplete,
    correctPartial,
    incorrect,
    unknown,
    notApplicable,
    populated,
    applicable,
    // Gates / compatibility
    correct: personAccuratePopulated,
    precision: personSetPrecision,
    coverage,
    exactPrecision,
    personPrecision,
    completeness,
    partialCases
  };
}

async function enrichOne(entry) {
  const started = Date.now();
  // Gate: fixtures supply resolved domain (identity already validated in identity eval)
  const domain = entry.domain;
  if (!domain) {
    return {
      name: entry.name,
      skipped: true,
      locationOutcome: 'unknown',
      foundersOutcome: 'unknown',
      headcountOutcome: 'unknown'
    };
  }

  const deps = {
    fetchHtml,
    searchSnippets,
    fetchWikidataHq,
    fetchWikidataFounders,
    fetchWikidataEmployees,
    fetchWikipediaSummary
  };

  const fields = await enrichResolvedFields(entry.name, domain, deps);
  const locationVal = fields.location?.value;
  const foundersVal = fields.founders?.value;
  const headcountVal = fields.headcount?.value;
  const foundersDetail = scoreFounders(foundersVal, entry);

  return {
    name: entry.name,
    category: entry.category,
    domain,
    location: locationVal,
    locationRecord: fields.location,
    locationOutcome: scoreLocation(locationVal, entry),
    founders: foundersVal,
    foundersRecord: fields.founders,
    foundersDetail,
    foundersOutcome: foundersDetail.outcome,
    headcount: headcountVal,
    headcountRecord: fields.headcount,
    headcountOutcome: scoreHeadcount(headcountVal, entry),
    elapsedMs: Date.now() - started
  };
}

function buildSummary(rows) {
  const loc = summarizeField(rows.map((r) => r.locationOutcome));
  const founders = summarizeFounders(rows);
  const headcount = summarizeField(rows.map((r) => r.headcountOutcome));

  return {
    companyCount: rows.length,
    hq: loc,
    founders,
    headcount,
    incorrect: {
      hq: rows.filter((r) => r.locationOutcome === 'incorrect').map((r) => ({
        name: r.name,
        got: r.location,
        expected: null,
        source: r.locationRecord?.source,
        evidence: r.locationRecord?.evidence
      })),
      founders: rows.filter((r) => r.foundersOutcome === 'incorrect').map((r) => ({
        name: r.name,
        got: r.founders,
        source: r.foundersRecord?.source,
        evidence: r.foundersRecord?.evidence,
        extra: r.foundersDetail?.extraKeys
      })),
      headcount: rows.filter((r) => r.headcountOutcome === 'incorrect').map((r) => ({
        name: r.name,
        got: r.headcount,
        source: r.headcountRecord?.source,
        evidence: r.headcountRecord?.evidence
      }))
    },
    unknown: {
      hq: rows.filter((r) => r.locationOutcome === 'unknown').map((r) => r.name),
      founders: rows.filter((r) => r.foundersOutcome === 'unknown').map((r) => r.name),
      headcount: rows.filter((r) => r.headcountOutcome === 'unknown').map((r) => r.name)
    },
    partialFounders: founders.partialCases,
    avgProcessingMs: Math.round(rows.reduce((a, r) => a + (r.elapsedMs || 0), 0) / (rows.length || 1))
  };
}

async function runBatch(companies, concurrency = 2) {
  const rows = new Array(companies.length);
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const entry = companies[idx];
      process.stdout.write(`  ${entry.name}... `);
      try {
        const row = await enrichOne(entry);
        rows[idx] = row;
        console.log(
          `HQ=${row.locationOutcome}(${row.location}) | F=${row.foundersOutcome}(${String(row.founders).slice(0, 40)}) | HC=${row.headcountOutcome}(${row.headcount})`
        );
      } catch (e) {
        rows[idx] = {
          name: entry.name,
          locationOutcome: 'unknown',
          foundersOutcome: 'unknown',
          headcountOutcome: 'unknown',
          location: UNKNOWN,
          founders: UNKNOWN,
          headcount: UNKNOWN,
          error: String(e.message || e),
          elapsedMs: 0
        };
        console.log('ERR', e.message || e);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  // Attach expected for incorrect reporting
  for (let j = 0; j < rows.length; j++) {
    rows[j].expectedLocation = companies[j].expectedLocation;
    rows[j].expectedFounders = companies[j].expectedFounders;
    rows[j].expectedHeadcount = companies[j].expectedHeadcount;
  }
  const summary = buildSummary(rows);
  // Fill expected into incorrect lists
  summary.incorrect.hq = summary.incorrect.hq.map((x) => {
    const row = rows.find((r) => r.name === x.name);
    return { ...x, expected: row?.expectedLocation };
  });
  summary.incorrect.founders = summary.incorrect.founders.map((x) => {
    const row = rows.find((r) => r.name === x.name);
    return { ...x, expected: row?.expectedFounders };
  });
  summary.incorrect.headcount = summary.incorrect.headcount.map((x) => {
    const row = rows.find((r) => r.name === x.name);
    return { ...x, expected: row?.expectedHeadcount };
  });
  return { rows, summary };
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const outDir = path.join(root, 'data/eval');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== Field enrichment (${dataset.companies.length}) ===`);
  const { rows, summary } = await runBatch(dataset.companies, 2);

  // Previous baseline from generic eval (coverage only; precision was unmeasured)
  const previous = {
    hq: { coverage: 44.4, precision: null },
    founders: { coverage: 3.7, precision: null },
    headcount: { coverage: 37.0, precision: null }
  };

  // Previous founder metrics under lenient "subset = correct" scoring (last green run)
  const previousFounderMetrics = {
    exactPrecision: 33.3, // only ~1/3 populated sets were fully complete (Spotify); NVIDIA/Lux were partial counted as correct
    personPrecision: 100,
    completeness: null, // not measured
    coverage: 17.6
  };

  const report = {
    generatedAt: new Date().toISOString(),
    previous,
    previousFounderMetrics,
    summary,
    rows,
    beforeVsAfter: {
      hq: { previousCoverage: previous.hq.coverage, newCoverage: summary.hq.coverage, newPrecision: summary.hq.precision },
      founders: {
        previousCoverage: previous.founders.coverage,
        newCoverage: summary.founders.coverage,
        newPrecision: summary.founders.precision,
        exactPrecision: summary.founders.exactPrecision,
        personPrecision: summary.founders.personPrecision,
        completeness: summary.founders.completeness,
        previousExactPrecision: previousFounderMetrics.exactPrecision,
        previousPersonPrecision: previousFounderMetrics.personPrecision,
        previousCompleteness: previousFounderMetrics.completeness,
        previousCoverage: previousFounderMetrics.coverage
      },
      headcount: {
        previousCoverage: previous.headcount.coverage,
        newCoverage: summary.headcount.coverage,
        newPrecision: summary.headcount.precision
      }
    }
  };

  fs.writeFileSync(path.join(outDir, 'field-enrichment-report.json'), JSON.stringify(report, null, 2));
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  console.log('\nFounder metrics:', {
    exactPrecision: summary.founders.exactPrecision,
    personPrecision: summary.founders.personPrecision,
    completeness: summary.founders.completeness,
    coverage: summary.founders.coverage,
    exactComplete: summary.founders.exactComplete,
    correctPartial: summary.founders.correctPartial,
    partialCases: summary.partialFounders
  });
  console.log('\nBefore vs After:', JSON.stringify(report.beforeVsAfter, null, 2));
  console.log('\nWrote data/eval/field-enrichment-report.json');

  // Precision gate: HQ/headcount unchanged; founders gate on person-accurate populated sets (exact+partial)
  // Exact-set precision is reported but not gated so partial high-precision results are not discarded.
  const ok =
    (summary.hq.populated === 0 || summary.hq.precision >= 90) &&
    (summary.founders.populated === 0 || summary.founders.personPrecision >= 90) &&
    (summary.headcount.populated === 0 || summary.headcount.precision >= 90);
  if (!ok) {
    console.error('\nFIELD PRECISION TARGET NOT MET', {
      hq: summary.hq,
      founders: summary.founders,
      headcount: summary.headcount,
      incorrect: summary.incorrect
    });
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
