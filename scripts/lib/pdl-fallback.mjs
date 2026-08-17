/**
 * PDL fallback enrichment — only fills Unknown fields after public-source enrichment.
 * Never overwrites high-confidence official / authoritative structured values.
 */

import {
  UNKNOWN,
  isBlankOrUnknown,
  normalizeHeadcount,
  normalizeFounders,
  normalizeLocation,
  fieldRecord,
  companyMatchKey
} from './enrichment-quality.mjs';
import { pdlCompanyEnrich, pdlCompanyEnrichBulk, pdlSearchFounders, isPdlConfigured, getPdlApiKey } from './pdl-client.mjs';
import { validatePdlCompanyMatch, filterPdlFounderPeople, normalizeDomainHost } from './pdl-validate.mjs';
import { readPdlCache, writePdlCache } from './pdl-cache.mjs';

const US_STATE_NAMES = {
  california: 'CA', 'new york': 'NY', texas: 'TX', washington: 'WA', massachusetts: 'MA',
  illinois: 'IL', florida: 'FL', colorado: 'CO', georgia: 'GA', oregon: 'OR', virginia: 'VA',
  pennsylvania: 'PA', 'new jersey': 'NJ', arizona: 'AZ', michigan: 'MI', 'north carolina': 'NC'
};

function formatPdlHqValue(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  s = s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[0];
    const region = parts[1].toLowerCase();
    if (US_STATE_NAMES[region]) return `${city}, ${US_STATE_NAMES[region]}`;
    if (/^[A-Za-z]{2}$/.test(parts[1])) return `${city}, ${parts[1].toUpperCase()}`;
    if (/united states|usa/i.test(parts[parts.length - 1]) && US_STATE_NAMES[region]) {
      return `${city}, ${US_STATE_NAMES[region]}`;
    }
    // International: City, Country (prefer last token if 3-part)
    if (parts.length >= 3) return normalizeLocation(`${parts[0]}, ${parts[parts.length - 1]}`);
    return normalizeLocation(`${parts[0]}, ${parts[1]}`);
  }
  const n = normalizeLocation(s);
  return isBlankOrUnknown(n) ? null : n;
}

export function createPdlStats() {
  return {
    enabled: false,
    requestsMade: 0,
    cacheHits: 0,
    successfulMatches: 0,
    rejectedMatches: 0,
    notFound: 0,
    errors: 0,
    companyCredits: 0,
    personSearchCredits: 0,
    hqFilled: 0,
    headcountFilled: 0,
    founderNamesFilled: 0,
    conflictsWithPublic: 0,
    incorrectIntroduced: 0 // filled by eval harness when scoring
  };
}

/** Map PDL size enum / employee_count → product buckets. */
export function mapPdlHeadcount(data) {
  if (!data) return { bucket: null, raw: null };
  const size = String(data.size || '').trim().toLowerCase().replace(/\s+/g, '');
  const SIZE_MAP = {
    '1-10': '1–10',
    '11-50': '11–50',
    '51-200': '51–200',
    '201-500': '201–500',
    '501-1000': '501–1,000',
    '1001-5000': '1,001–5,000',
    '5001-10000': '5,001–10,000',
    '10001+': '10,001+'
  };
  if (SIZE_MAP[size]) {
    return { bucket: SIZE_MAP[size], raw: data.size, method: 'pdl_size_enum' };
  }
  if (data.employee_count != null && Number.isFinite(Number(data.employee_count))) {
    const n = Number(data.employee_count);
    const bucket = normalizeHeadcount(String(n));
    if (!isBlankOrUnknown(bucket)) {
      return { bucket, raw: n, method: 'pdl_employee_count' };
    }
  }
  return { bucket: null, raw: data.employee_count ?? data.size ?? null };
}

/** Build HQ candidate from PDL location object (HQ fields only). */
export function mapPdlHeadquarters(data) {
  const loc = data?.location;
  if (!loc || typeof loc !== 'object') return null;
  const locality = loc.locality || '';
  const region = loc.region || '';
  const country = loc.country || '';
  let raw = '';
  if (locality && region) raw = `${locality}, ${region}`;
  else if (locality && country) raw = `${locality}, ${country}`;
  else if (loc.name) {
    // "san francisco, california, united states" → locality, region
    const parts = String(loc.name)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) raw = `${parts[0]}, ${parts[1]}`;
  }
  if (!raw) return null;
  // Title-case lightly for normalizer
  const value = formatPdlHqValue(raw);
  return value && !isBlankOrUnknown(value) ? { value, raw, evidence: `PDL location: ${loc.name || raw}` } : null;
}

function isHighAuthoritative(field) {
  if (!field || isBlankOrUnknown(field.value)) return false;
  if (field.confidence !== 'high') return false;
  return /official|wikidata|json_ld/i.test(String(field.source || ''));
}

function needsFallback(field) {
  return !field || isBlankOrUnknown(field.value);
}

/**
 * Apply PDL company record onto public fields (Unknown only).
 */
export function applyPdlCompanyToFields(publicFields, { companyName, domain, pdlData, matchMeta, stats }) {
  const out = {
    location: publicFields.location,
    founders: publicFields.founders,
    headcount: publicFields.headcount,
    pdl: {
      ...matchMeta,
      applied: { location: false, headcount: false, founders: false }
    }
  };

  if (!matchMeta?.accepted || !pdlData) return out;

  if (needsFallback(publicFields.location) && !isHighAuthoritative(publicFields.location)) {
    const hq = mapPdlHeadquarters(pdlData);
    if (hq) {
      out.location = fieldRecord(hq.value, 'pdl', 'medium', {
        sourceType: 'pdl',
        sourceUrl: pdlData.website ? `https://${normalizeDomainHost(pdlData.website)}` : null,
        method: 'pdl_fallback',
        evidence: hq.evidence,
        pdlLikelihood: matchMeta.pdlLikelihood,
        rawPdl: hq.raw
      });
      out.pdl.applied.location = true;
      if (stats) stats.hqFilled += 1;
    }
  } else if (!needsFallback(publicFields.location) && mapPdlHeadquarters(pdlData)) {
    const hq = mapPdlHeadquarters(pdlData);
    if (hq && publicFields.location?.value && hq.value !== publicFields.location.value) {
      // Track conflict but do not overwrite
      if (stats) stats.conflictsWithPublic += 1;
      out.pdl.hqConflict = { public: publicFields.location.value, pdl: hq.value };
    }
  }

  if (needsFallback(publicFields.headcount) && !isHighAuthoritative(publicFields.headcount)) {
    const hc = mapPdlHeadcount(pdlData);
    if (hc.bucket) {
      out.headcount = fieldRecord(hc.bucket, 'pdl', 'medium', {
        sourceType: 'pdl',
        sourceUrl: pdlData.website ? `https://${normalizeDomainHost(pdlData.website)}` : null,
        method: 'pdl_fallback',
        evidence: `PDL ${hc.method}: ${hc.raw}`,
        pdlLikelihood: matchMeta.pdlLikelihood,
        rawPdl: hc.raw
      });
      out.pdl.applied.headcount = true;
      if (stats) stats.headcountFilled += 1;
    }
  } else if (!needsFallback(publicFields.headcount)) {
    const hc = mapPdlHeadcount(pdlData);
    if (hc.bucket && publicFields.headcount?.value && hc.bucket !== publicFields.headcount.value) {
      if (stats) stats.conflictsWithPublic += 1;
      out.pdl.headcountConflict = { public: publicFields.headcount.value, pdl: hc.bucket };
    }
  }

  return out;
}

/**
 * Merge founder names from PDL person search into an Unknown or partial public founder field.
 * Never adds names without explicit founder title evidence.
 */
export function applyPdlFounders(publicFounders, founderPeople, { matchMeta, stats } = {}) {
  if (!founderPeople?.length) return { founders: publicFounders, appliedNames: [] };
  const names = normalizeFounders(founderPeople.map((p) => p.name).join('; '));
  if (isBlankOrUnknown(names)) return { founders: publicFounders, appliedNames: [] };

  if (needsFallback(publicFounders)) {
    const record = fieldRecord(names, 'pdl', 'medium', {
      sourceType: 'pdl_person_search',
      method: 'pdl_founder_fallback',
      evidence: founderPeople.map((p) => p.evidence).join(' | ').slice(0, 400),
      pdlLikelihood: matchMeta?.pdlLikelihood ?? null
    });
    const appliedNames = names.split(/\s*;\s*/).filter(Boolean);
    if (stats) stats.founderNamesFilled += appliedNames.length;
    return { founders: record, appliedNames };
  }

  // Partial public set: only add PDL names that are new and strongly titled founder
  const existing = String(publicFounders.value || '')
    .split(/\s*;\s*/)
    .map((n) => companyMatchKey(n))
    .filter(Boolean);
  const additions = founderPeople.filter((p) => !existing.includes(companyMatchKey(p.name)));
  if (!additions.length) return { founders: publicFounders, appliedNames: [] };

  // Conservative: do not auto-promote partial→exact via PDL in production merge unless
  // public was Unknown. For partial, keep public value and attach pdlCandidates for eval.
  return {
    founders: publicFounders,
    appliedNames: [],
    pdlExtraCandidates: additions,
    note: 'pdl_founders_not_merged_over_public_partial'
  };
}

/**
 * Fetch + validate one company (with cache). Does not throw.
 */
export async function fetchValidatedPdlCompany(companyName, domain, opts = {}) {
  const stats = opts.stats || createPdlStats();
  stats.enabled = isPdlConfigured(opts.env);

  if (!domain) {
    return { match: validatePdlCompanyMatch({}), data: null, fromCache: false };
  }
  if (!stats.enabled && !opts.apiKey) {
    return {
      match: validatePdlCompanyMatch({ pdlResponse: { enabled: false } }),
      data: null,
      fromCache: false
    };
  }

  const cached = opts.skipCache ? null : readPdlCache(domain, { cacheDir: opts.cacheDir, ttlMs: opts.ttlMs });
  if (cached?.company) {
    stats.cacheHits += 1;
    const fakeResponse = {
      enabled: true,
      status: cached.match?.pdlMatchStatus === 'accepted' ? 200 : cached.status || 200,
      data: cached.company,
      likelihood: cached.match?.pdlLikelihood ?? cached.company.likelihood
    };
    const match =
      cached.match ||
      validatePdlCompanyMatch({
        requestedDomain: domain,
        requestedName: companyName,
        pdlResponse: fakeResponse,
        minLikelihood: opts.minLikelihood ?? 6
      });
    if (match.accepted) stats.successfulMatches += 1;
    else if (match.pdlMatchStatus === 'rejected') stats.rejectedMatches += 1;
    return { match, data: cached.company, fromCache: true };
  }

  stats.requestsMade += 1;
  const response = await pdlCompanyEnrich({
    website: domain,
    name: companyName,
    apiKey: opts.apiKey || getPdlApiKey(opts.env),
    minLikelihood: opts.minLikelihood ?? 5, // request floor; we validate higher locally
    timeoutMs: opts.timeoutMs
  });
  if (response.creditCharged) stats.companyCredits += 1;
  if (response.error && response.status !== 200 && response.status !== 404) stats.errors += 1;
  if (response.status === 404) stats.notFound += 1;

  const match = validatePdlCompanyMatch({
    requestedDomain: domain,
    requestedName: companyName,
    pdlResponse: response,
    minLikelihood: opts.minLikelihood ?? 6
  });
  if (match.accepted) stats.successfulMatches += 1;
  else if (match.pdlMatchStatus === 'rejected') stats.rejectedMatches += 1;

  if (!opts.skipCacheWrite) {
    writePdlCache(
      domain,
      {
        status: response.status,
        match,
        company: response.data,
        likelihood: response.likelihood
      },
      { cacheDir: opts.cacheDir }
    );
  }

  return { match, data: response.data, fromCache: false, response };
}

/**
 * Public fields → optional PDL fallback for Unknown HQ / headcount / founders.
 */
export async function enrichWithPdlFallback(companyName, domain, publicFields, opts = {}) {
  const stats = opts.stats || createPdlStats();
  const base = {
    location: publicFields.location,
    founders: publicFields.founders,
    headcount: publicFields.headcount,
    pdl: { pdlMatchStatus: 'disabled', applied: { location: false, headcount: false, founders: false } }
  };

  if (!domain) return { ...base, pdl: { ...base.pdl, reason: 'identity_not_resolved' } };
  if (!isPdlConfigured(opts.env) && !opts.apiKey && !opts.injectCompany) {
    return base;
  }

  const needHq = needsFallback(publicFields.location);
  const needHc = needsFallback(publicFields.headcount);
  const needFounders = needsFallback(publicFields.founders);
  if (!needHq && !needHc && !needFounders && !opts.forceFetch) {
    return {
      ...base,
      pdl: { pdlMatchStatus: 'skipped', reason: 'no_unknown_fields', applied: { location: false, headcount: false, founders: false } }
    };
  }

  let match;
  let data;
  if (opts.injectCompany) {
    match = validatePdlCompanyMatch({
      requestedDomain: domain,
      requestedName: companyName,
      pdlResponse: { enabled: true, status: 200, data: opts.injectCompany, likelihood: opts.injectCompany.likelihood ?? 9 },
      minLikelihood: opts.minLikelihood ?? 6
    });
    data = opts.injectCompany;
    if (match.accepted) stats.successfulMatches += 1;
    else stats.rejectedMatches += 1;
  } else {
    const fetched = await fetchValidatedPdlCompany(companyName, domain, { ...opts, stats });
    match = fetched.match;
    data = fetched.data;
  }

  let merged = applyPdlCompanyToFields(publicFields, {
    companyName,
    domain,
    pdlData: match.accepted ? data : null,
    matchMeta: match,
    stats
  });

  if (needFounders && match.accepted && opts.enableFounderSearch !== false) {
    let people = opts.injectFounders || null;
    if (!people) {
      const search = await pdlSearchFounders({
        website: domain,
        companyName,
        apiKey: opts.apiKey || getPdlApiKey(opts.env),
        timeoutMs: opts.timeoutMs
      });
      if (search.creditCharged) stats.personSearchCredits += 1;
      people = filterPdlFounderPeople(search.people || [], { domain, companyName });
    } else {
      people = filterPdlFounderPeople(people, { domain, companyName });
    }
    const fr = applyPdlFounders(merged.founders, people, { matchMeta: match, stats });
    merged.founders = fr.founders;
    if (fr.appliedNames?.length) merged.pdl.applied.founders = true;
    if (fr.pdlExtraCandidates) merged.pdl.founderExtraCandidates = fr.pdlExtraCandidates;
  }

  merged.pdl = { ...merged.pdl, ...match };
  return merged;
}

/**
 * Bulk-prefetch company records for domains that still need fallback.
 */
export async function prefetchPdlCompanies(entries, opts = {}) {
  const stats = opts.stats || createPdlStats();
  stats.enabled = isPdlConfigured(opts.env) || Boolean(opts.apiKey);
  if (!stats.enabled) return { map: new Map(), stats };

  const need = [];
  for (const e of entries) {
    if (!e.domain) continue;
    const cached = opts.skipCache ? null : readPdlCache(e.domain, { cacheDir: opts.cacheDir, ttlMs: opts.ttlMs });
    if (cached?.company && cached.match) continue;
    need.push(e);
  }

  const map = new Map();
  const chunkSize = opts.chunkSize || 50;
  for (let i = 0; i < need.length; i += chunkSize) {
    const chunk = need.slice(i, i + chunkSize);
    stats.requestsMade += 1; // one bulk HTTP request
    const bulk = await pdlCompanyEnrichBulk(
      chunk.map((e) => ({ website: e.domain, name: e.name, domain: e.domain })),
      { apiKey: opts.apiKey, minLikelihood: opts.minLikelihood ?? 5, timeoutMs: opts.timeoutMs || 45000 }
    );
    if (bulk.error) {
      stats.errors += 1;
      continue;
    }
    for (const r of bulk.results) {
      if (r.creditCharged) stats.companyCredits += 1;
      const domain = r.request?.domain || r.request?.website;
      const match = validatePdlCompanyMatch({
        requestedDomain: domain,
        requestedName: r.request?.name,
        pdlResponse: {
          enabled: true,
          status: r.status,
          data: r.data,
          likelihood: r.likelihood,
          error: r.error
        },
        minLikelihood: opts.minLikelihood ?? 6
      });
      if (match.accepted) stats.successfulMatches += 1;
      else if (match.pdlMatchStatus === 'rejected') stats.rejectedMatches += 1;
      else if (match.pdlMatchStatus === 'not_found') stats.notFound += 1;
      writePdlCache(domain, { status: r.status, match, company: r.data, likelihood: r.likelihood }, { cacheDir: opts.cacheDir });
      map.set(normalizeDomainHost(domain), { match, data: r.data });
    }
  }
  return { map, stats };
}

export { isPdlConfigured, getPdlApiKey };
