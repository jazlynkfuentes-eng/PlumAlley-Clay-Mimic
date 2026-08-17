/**
 * Shared PDL HTTP handler used by Vercel (/api/pdl-enrich) and local dev-static-server.
 */
import { isPdlConfigured, getPdlApiKey } from './pdl-client.mjs';
import { enrichWithPdlFallback, createPdlStats, prefetchPdlCompanies } from './pdl-fallback.mjs';
import { UNKNOWN, fieldRecord, isBlankOrUnknown } from './enrichment-quality.mjs';

function asPublicField(value, source = 'public', confidence = 'medium') {
  if (isBlankOrUnknown(value)) {
    return fieldRecord(UNKNOWN, 'none', 'low', { method: 'unknown', unknownReason: 'unresolved_public' });
  }
  return fieldRecord(value, source, confidence, { method: 'public_prefill' });
}

export async function handlePdlEnrichRequest(body = {}) {
  const enabled = isPdlConfigured();
  if (!enabled) {
    return { status: 200, payload: { enabled: false, results: [], stats: createPdlStats() } };
  }

  const companies = Array.isArray(body.companies) ? body.companies : [];
  const enableFounders = body.enableFounders === true;
  const stats = createPdlStats();
  stats.enabled = true;

  try {
    await prefetchPdlCompanies(
      companies.filter((c) => c.domain).map((c) => ({ name: c.name, domain: c.domain })),
      { stats, apiKey: getPdlApiKey() }
    );

    const results = [];
    for (const c of companies.slice(0, 100)) {
      const domain = String(c.domain || '').trim();
      const name = String(c.name || '').trim();
      if (!domain) {
        results.push({ name, domain: null, error: 'identity_not_resolved' });
        continue;
      }
      const publicFields = {
        location: asPublicField(c.location, c.locationSource, c.locationConfidence),
        headcount: asPublicField(c.headcount, c.headcountSource, c.headcountConfidence),
        founders: asPublicField(c.founders, c.foundersSource, c.foundersConfidence)
      };
      const merged = await enrichWithPdlFallback(name, domain, publicFields, {
        stats,
        enableFounderSearch: enableFounders,
        apiKey: getPdlApiKey()
      });
      results.push({
        name,
        domain,
        location: merged.location,
        headcount: merged.headcount,
        founders: merged.founders,
        pdl: merged.pdl
      });
    }
    return { status: 200, payload: { enabled: true, results, stats } };
  } catch (e) {
    return {
      status: 500,
      payload: { enabled: true, error: e.message || String(e), results: [], stats }
    };
  }
}

export function pdlStatusPayload() {
  return { enabled: isPdlConfigured(), provider: 'peopledatalabs' };
}
