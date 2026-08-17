/**
 * A/B field enrichment eval: public-only vs public + optional PDL fallback.
 *
 * Usage:
 *   PDL_API_KEY=... npm run eval:pdl
 *
 * Without PDL_API_KEY, runs public-only and records that live PDL was skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNKNOWN, isBlankOrUnknown } from './lib/enrichment-quality.mjs';
import {
  enrichResolvedFields,
  locationEquivalent,
  classifyFounderMatch,
  headcountEquivalent
} from './lib/field-enrich.mjs';
import { isPdlConfigured, getPdlApiKey } from './lib/pdl-client.mjs';
import { createPdlStats } from './lib/pdl-fallback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fixturePath = path.join(root, 'data/eval/field-enrichment-companies.json');

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchHtml(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'ClayMimicPdlEval/1.0', Accept: 'text/html' }, redirect: 'follow' },
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
    if (json.AbstractText) out.push({ snippet: json.AbstractText, title: json.Heading || '', url: json.AbstractURL || null });
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
    const hit =
      (searchJson.search || []).find((h) => !/disambiguation|family name|given name/i.test(h.description || '')) ||
      searchJson.search?.[0];
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
  return { employees: n, evidence: `Wikidata P1128 → ${n}`, url: `https://www.wikidata.org/wiki/${data.id}` };
}

function scoreLocation(got, entry) {
  if (isBlankOrUnknown(got)) return 'unknown';
  if (!entry.expectedLocation) return 'unknown';
  return locationEquivalent(got, entry.expectedLocation, entry.altLocations) ? 'correct' : 'incorrect';
}

function scoreHeadcount(got, entry) {
  if (isBlankOrUnknown(got)) return 'unknown';
  if (!entry.expectedHeadcount) return 'unknown';
  return headcountEquivalent(got, entry.expectedHeadcount, entry.altHeadcounts) ? 'correct' : 'incorrect';
}

function summarizeSimple(outcomes) {
  const correct = outcomes.filter((o) => o === 'correct').length;
  const incorrect = outcomes.filter((o) => o === 'incorrect').length;
  const unknown = outcomes.filter((o) => o === 'unknown').length;
  const populated = correct + incorrect;
  const applicable = outcomes.length;
  return {
    correct,
    incorrect,
    unknown,
    populated,
    applicable,
    precision: populated ? Math.round((correct / populated) * 1000) / 10 : 0,
    coverage: applicable ? Math.round((populated / applicable) * 1000) / 10 : 0
  };
}

function summarizeFounders(rows) {
  const details = rows.map((r) => r.foundersDetail).filter(Boolean);
  const exactComplete = details.filter((d) => d.outcome === 'exact_complete').length;
  const correctPartial = details.filter((d) => d.outcome === 'correct_partial').length;
  const incorrect = details.filter((d) => d.outcome === 'incorrect').length;
  const unknown = details.filter((d) => d.outcome === 'unknown').length;
  const notApplicable = details.filter((d) => d.outcome === 'not_applicable').length;
  const populated = exactComplete + correctPartial + incorrect;
  const applicable = rows.length - notApplicable;
  let correctPersons = 0;
  let totalPersons = 0;
  let matched = 0;
  let expected = 0;
  for (const d of details) {
    if (d.outcome === 'not_applicable' || d.outcome === 'unknown') continue;
    totalPersons += d.gotKeys?.length || 0;
    correctPersons += d.matchedKeys?.length || 0;
    expected += d.expectedKeys?.length || 0;
    matched += d.matchedKeys?.length || 0;
  }
  return {
    exactComplete,
    correctPartial,
    incorrect,
    unknown,
    notApplicable,
    populated,
    applicable,
    coverage: applicable ? Math.round((populated / applicable) * 1000) / 10 : 0,
    exactPrecision: populated ? Math.round((exactComplete / populated) * 1000) / 10 : 0,
    personPrecision: totalPersons ? Math.round((correctPersons / totalPersons) * 1000) / 10 : 0,
    completeness: expected ? Math.round((matched / expected) * 1000) / 10 : 0,
    precision: populated ? Math.round(((exactComplete + correctPartial) / populated) * 1000) / 10 : 0
  };
}

function publicDeps() {
  return {
    fetchHtml,
    searchSnippets,
    fetchWikidataHq,
    fetchWikidataFounders,
    fetchWikidataEmployees,
    fetchWikipediaSummary
  };
}

async function enrichOne(entry, { enablePdl, pdlStats }) {
  const started = Date.now();
  const domain = entry.domain;
  if (!domain) {
    return { name: entry.name, skipped: true };
  }
  const deps = {
    ...publicDeps(),
    enablePdl: Boolean(enablePdl),
    pdlStats,
    pdl: enablePdl
      ? {
          enableFounderSearch: true,
          minLikelihood: 6,
          skipCache: false
        }
      : undefined
  };
  const fields = await enrichResolvedFields(entry.name, domain, deps);
  const foundersDetail = classifyFounderMatch(fields.founders?.value, entry.expectedFounders, entry.altFounders, {
    foundersApplicable: entry.foundersApplicable !== false && entry.expectedFounders != null
  });
  return {
    name: entry.name,
    domain,
    location: fields.location?.value,
    locationSource: fields.location?.source,
    locationOutcome: scoreLocation(fields.location?.value, entry),
    headcount: fields.headcount?.value,
    headcountSource: fields.headcount?.source,
    headcountOutcome: scoreHeadcount(fields.headcount?.value, entry),
    founders: fields.founders?.value,
    foundersSource: fields.founders?.source,
    foundersDetail,
    foundersOutcome: foundersDetail.outcome,
    pdl: fields.pdl || null,
    elapsedMs: Date.now() - started
  };
}

async function runSuite(companies, { enablePdl, label, concurrency = 2 }) {
  console.log(`\n=== ${label} (${companies.length}) ===`);
  const pdlStats = createPdlStats();
  const rows = new Array(companies.length);
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const entry = companies[idx];
      process.stdout.write(`  ${entry.name}... `);
      try {
        const row = await enrichOne(entry, { enablePdl, pdlStats });
        rows[idx] = row;
        console.log(
          `HQ=${row.locationOutcome}(${row.location}) src=${row.locationSource} | F=${row.foundersOutcome} | HC=${row.headcountOutcome}(${row.headcount}) src=${row.headcountSource}`
        );
      } catch (e) {
        rows[idx] = {
          name: entry.name,
          locationOutcome: 'unknown',
          headcountOutcome: 'unknown',
          foundersOutcome: 'unknown',
          foundersDetail: classifyFounderMatch(UNKNOWN, entry.expectedFounders, entry.altFounders, {
            foundersApplicable: entry.foundersApplicable !== false && entry.expectedFounders != null
          }),
          error: String(e.message || e)
        };
        console.log('ERR', e.message || e);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const hq = summarizeSimple(rows.map((r) => r.locationOutcome));
  const headcount = summarizeSimple(rows.map((r) => r.headcountOutcome));
  const founders = summarizeFounders(rows);
  return { rows, summary: { hq, headcount, founders }, pdlStats };
}

function incrementalGain(publicRows, pdlRows, companies) {
  const gained = { hq: [], headcount: [], founders: [], incorrectIntroduced: [] };
  for (let i = 0; i < companies.length; i++) {
    const a = publicRows[i];
    const b = pdlRows[i];
    if (!a || !b) continue;
    if (a.locationOutcome === 'unknown' && b.locationOutcome === 'correct' && b.locationSource === 'pdl') {
      gained.hq.push(b.name);
    }
    if (a.locationOutcome === 'unknown' && b.locationOutcome === 'incorrect' && b.locationSource === 'pdl') {
      gained.incorrectIntroduced.push({ field: 'hq', name: b.name, got: b.location });
    }
    if (a.headcountOutcome === 'unknown' && b.headcountOutcome === 'correct' && b.headcountSource === 'pdl') {
      gained.headcount.push(b.name);
    }
    if (a.headcountOutcome === 'unknown' && b.headcountOutcome === 'incorrect' && b.headcountSource === 'pdl') {
      gained.incorrectIntroduced.push({ field: 'headcount', name: b.name, got: b.headcount });
    }
    if (
      (a.foundersOutcome === 'unknown' || a.foundersOutcome === 'correct_partial') &&
      (b.foundersOutcome === 'exact_complete' || b.foundersOutcome === 'correct_partial') &&
      b.foundersSource === 'pdl'
    ) {
      gained.founders.push({ name: b.name, outcome: b.foundersOutcome, value: b.founders });
    }
    if (a.foundersOutcome !== 'incorrect' && b.foundersOutcome === 'incorrect' && b.foundersSource === 'pdl') {
      gained.incorrectIntroduced.push({ field: 'founders', name: b.name, got: b.founders });
    }
  }
  return gained;
}

function recommendation({ pdlEnabled, publicSummary, pdlSummary, gained, stats }) {
  if (!pdlEnabled) {
    return {
      choice: 3,
      label: 'PDL does not add enough value; test another provider',
      reason:
        'Live PDL evaluation was skipped (no PDL_API_KEY). Do not upgrade or pay until a free/test key run demonstrates meaningful incremental coverage on this eval set.'
    };
  }
  const useful =
    gained.hq.length + gained.headcount.length + gained.founders.length;
  const incorrect = gained.incorrectIntroduced.length;
  const credits = (stats.companyCredits || 0) + (stats.personSearchCredits || 0);
  const hqOk = !pdlSummary.hq.populated || pdlSummary.hq.precision >= 95;
  const hcOk = !pdlSummary.headcount.populated || pdlSummary.headcount.precision >= 95;
  const fOk = !pdlSummary.founders.populated || pdlSummary.founders.personPrecision >= 95;

  if (incorrect > 0 || !hqOk || !hcOk || !fOk) {
    return {
      choice: 3,
      label: 'PDL does not add enough value; test another provider',
      reason: `PDL introduced precision risk (incorrect=${incorrect}, hqPrec=${pdlSummary.hq.precision}, hcPrec=${pdlSummary.headcount.precision}, founderPersonPrec=${pdlSummary.founders.personPrecision}).`
    };
  }
  if (useful === 0) {
    return {
      choice: 3,
      label: 'PDL does not add enough value; test another provider',
      reason: 'No previously-Unknown cells were correctly filled by validated PDL on this set.'
    };
  }
  const founderGain = gained.founders.length;
  const hqHcGain = gained.hq.length + gained.headcount.length;
  if (founderGain === 0 && hqHcGain > 0) {
    return {
      choice: 2,
      label: 'Keep PDL only for HQ/headcount',
      reason: `PDL correctly filled ${hqHcGain} HQ/headcount cells (${credits} credits) without founder completeness gains.`
    };
  }
  if (useful >= 3 && credits > 0) {
    return {
      choice: 1,
      label: 'Keep PDL and make it the production fallback',
      reason: `Meaningful incremental coverage (${useful} useful fields, ${credits} credits) with precision gates held.`
    };
  }
  return {
    choice: 2,
    label: 'Keep PDL only for HQ/headcount',
    reason: `Modest gain (useful=${useful}). Prefer HQ/headcount-only until founder search proves value.`
  };
}

async function main() {
  loadDotEnv();
  const dataset = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const companies = dataset.companies;
  const outDir = path.join(root, 'data/eval');
  fs.mkdirSync(outDir, { recursive: true });

  const publicRun = await runSuite(companies, { enablePdl: false, label: 'A) Public sources only' });

  const pdlEnabled = isPdlConfigured();
  let pdlRun = null;
  let gained = { hq: [], headcount: [], founders: [], incorrectIntroduced: [] };

  if (pdlEnabled) {
    console.log(`\nPDL_API_KEY detected (len=${getPdlApiKey().length}). Running B) Public + PDL…`);
    pdlRun = await runSuite(companies, { enablePdl: true, label: 'B) Public sources + PDL fallback' });
    gained = incrementalGain(publicRun.rows, pdlRun.rows, companies);
    pdlRun.pdlStats.incorrectIntroduced = gained.incorrectIntroduced.length;
  } else {
    console.log('\nNo PDL_API_KEY — skipping live PDL suite. Set PDL_API_KEY in env or .env to evaluate.');
  }

  const credits =
    (pdlRun?.pdlStats.companyCredits || 0) + (pdlRun?.pdlStats.personSearchCredits || 0);
  const usefulFields = gained.hq.length + gained.headcount.length + gained.founders.length;
  const coveragePer100Matches =
    pdlRun && pdlRun.pdlStats.successfulMatches
      ? Math.round((usefulFields / pdlRun.pdlStats.successfulMatches) * 1000) / 10
      : null;

  const rec = recommendation({
    pdlEnabled,
    publicSummary: publicRun.summary,
    pdlSummary: pdlRun?.summary || publicRun.summary,
    gained,
    stats: pdlRun?.pdlStats || createPdlStats()
  });

  const report = {
    generatedAt: new Date().toISOString(),
    pdlConfigured: pdlEnabled,
    publicOnly: publicRun.summary,
    publicPlusPdl: pdlRun?.summary || null,
    comparisonTable: {
      hq: {
        publicPrecision: publicRun.summary.hq.precision,
        pdlPrecision: pdlRun?.summary.hq.precision ?? null,
        publicCoverage: publicRun.summary.hq.coverage,
        pdlCoverage: pdlRun?.summary.hq.coverage ?? null
      },
      founders: {
        publicPrecision: publicRun.summary.founders.precision,
        pdlPrecision: pdlRun?.summary.founders.precision ?? null,
        publicCoverage: publicRun.summary.founders.coverage,
        pdlCoverage: pdlRun?.summary.founders.coverage ?? null,
        publicExactPrecision: publicRun.summary.founders.exactPrecision,
        pdlExactPrecision: pdlRun?.summary.founders.exactPrecision ?? null,
        publicPersonPrecision: publicRun.summary.founders.personPrecision,
        pdlPersonPrecision: pdlRun?.summary.founders.personPrecision ?? null,
        publicCompleteness: publicRun.summary.founders.completeness,
        pdlCompleteness: pdlRun?.summary.founders.completeness ?? null
      },
      headcount: {
        publicPrecision: publicRun.summary.headcount.precision,
        pdlPrecision: pdlRun?.summary.headcount.precision ?? null,
        publicCoverage: publicRun.summary.headcount.coverage,
        pdlCoverage: pdlRun?.summary.headcount.coverage ?? null
      }
    },
    pdlContribution: pdlRun
      ? {
          ...pdlRun.pdlStats,
          newlyFilledCorrect: gained,
          usefulFieldsGained: usefulFields,
          creditsUsed: credits,
          coverageGainedPer100Matches: coveragePer100Matches
        }
      : null,
    recommendation: rec,
    rows: {
      public: publicRun.rows,
      pdl: pdlRun?.rows || null
    }
  };

  fs.writeFileSync(path.join(outDir, 'pdl-fallback-report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== Comparison ===');
  console.log(JSON.stringify(report.comparisonTable, null, 2));
  console.log('\n=== PDL contribution ===');
  console.log(JSON.stringify(report.pdlContribution, null, 2));
  console.log('\n=== Recommendation ===');
  console.log(`${rec.choice}. ${rec.label}`);
  console.log(rec.reason);
  console.log('\nWrote data/eval/pdl-fallback-report.json');

  // Public suite: hold HQ/headcount ≥95; founder person-level aligns with existing field eval (≥90)
  const pubOk =
    (publicRun.summary.hq.populated === 0 || publicRun.summary.hq.precision >= 95) &&
    (publicRun.summary.headcount.populated === 0 || publicRun.summary.headcount.precision >= 95) &&
    (publicRun.summary.founders.populated === 0 || publicRun.summary.founders.personPrecision >= 90);
  if (!pubOk) {
    console.error('PUBLIC PRECISION GATE FAILED', publicRun.summary);
    process.exitCode = 2;
  }
  if (pdlRun) {
    const pdlOk =
      (pdlRun.summary.hq.populated === 0 || pdlRun.summary.hq.precision >= 95) &&
      (pdlRun.summary.headcount.populated === 0 || pdlRun.summary.headcount.precision >= 95) &&
      (pdlRun.summary.founders.populated === 0 || pdlRun.summary.founders.personPrecision >= 95);
    if (!pdlOk) {
      console.error('PDL PRECISION GATE FAILED', pdlRun.summary);
      process.exitCode = 2;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
