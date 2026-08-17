/**
 * People Data Labs API client (server-side / Node only).
 * Never import this into browser bundles with a real API key.
 */

const COMPANY_ENRICH_URL = 'https://api.peopledatalabs.com/v5/company/enrich';
const COMPANY_BULK_URL = 'https://api.peopledatalabs.com/v5/company/enrich/bulk';
const PERSON_SEARCH_URL = 'https://api.peopledatalabs.com/v5/person/search';

export function getPdlApiKey(env = process.env) {
  const key = String(env.PDL_API_KEY || env.PEOPLEDATALABS_API_KEY || '').trim();
  return key || null;
}

export function isPdlConfigured(env = process.env) {
  return Boolean(getPdlApiKey(env));
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single company enrich by website/domain (+ optional name).
 * Credits: 1 per successful 200 match.
 */
export async function pdlCompanyEnrich({ website, name, apiKey, minLikelihood = 6, timeoutMs = 12000 } = {}) {
  const key = apiKey || getPdlApiKey();
  if (!key) return { enabled: false, status: 0, data: null, error: 'pdl_not_configured' };

  const params = new URLSearchParams();
  if (website) params.set('website', String(website).replace(/^https?:\/\//, '').replace(/\/$/, ''));
  if (name) params.set('name', String(name));
  params.set('min_likelihood', String(minLikelihood));
  params.set('titlecase', 'true');
  params.set('pretty', 'false');

  try {
    const { ok, status, json } = await fetchJson(`${COMPANY_ENRICH_URL}?${params}`, {
      headers: { 'X-Api-Key': key, Accept: 'application/json' },
      timeoutMs
    });
    if (status === 404) {
      return { enabled: true, status: 404, data: null, likelihood: null, creditCharged: false, error: 'not_found' };
    }
    if (!ok || status !== 200) {
      return {
        enabled: true,
        status,
        data: null,
        likelihood: json?.likelihood ?? null,
        creditCharged: false,
        error: json?.error?.message || json?.message || `http_${status}`
      };
    }
    // Single enrich returns flat company object with likelihood/status
    const likelihood = json?.likelihood ?? null;
    return {
      enabled: true,
      status: 200,
      data: json,
      likelihood,
      creditCharged: true,
      error: null
    };
  } catch (e) {
    return {
      enabled: true,
      status: 0,
      data: null,
      likelihood: null,
      creditCharged: false,
      error: e.name === 'AbortError' ? 'timeout' : String(e.message || e)
    };
  }
}

/**
 * Bulk company enrich (up to 100). Credits = number of 200 responses.
 */
export async function pdlCompanyEnrichBulk(requests, { apiKey, minLikelihood = 6, timeoutMs = 30000 } = {}) {
  const key = apiKey || getPdlApiKey();
  if (!key) return { enabled: false, results: [], error: 'pdl_not_configured' };
  if (!requests?.length) return { enabled: true, results: [], error: null };

  const body = {
    requests: requests.slice(0, 100).map((r) => ({
      params: {
        website: String(r.website || r.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
        ...(r.name ? { name: String(r.name) } : {}),
        min_likelihood: minLikelihood,
        titlecase: true
      }
    }))
  };

  try {
    const { ok, status, json } = await fetchJson(COMPANY_BULK_URL, {
      method: 'POST',
      headers: {
        'X-Api-Key': key,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      timeoutMs
    });
    if (!ok) {
      return {
        enabled: true,
        results: [],
        error: json?.error?.message || `http_${status}`,
        httpStatus: status
      };
    }
    const arr = Array.isArray(json) ? json : [];
    const results = arr.map((item, i) => {
      // Bulk may wrap as { status, likelihood, data } or flat
      const nested = item?.data && typeof item.data === 'object' ? item.data : null;
      const data = nested || (item?.status === 200 ? item : null);
      const st = item?.status ?? (data ? 200 : 0);
      const likelihood = item?.likelihood ?? data?.likelihood ?? null;
      return {
        index: i,
        request: requests[i],
        status: st,
        likelihood,
        data: st === 200 ? { ...data, likelihood } : null,
        creditCharged: st === 200,
        error: st === 200 ? null : item?.error || item?.message || `status_${st}`
      };
    });
    return { enabled: true, results, error: null };
  } catch (e) {
    return {
      enabled: true,
      results: [],
      error: e.name === 'AbortError' ? 'timeout' : String(e.message || e)
    };
  }
}

/**
 * Person search for founders only — explicit founder/co-founder title required.
 * Credits: person search pricing (tracked separately as personSearchCredits).
 */
export async function pdlSearchFounders({ website, companyName, apiKey, size = 8, timeoutMs = 15000 } = {}) {
  const key = apiKey || getPdlApiKey();
  if (!key) return { enabled: false, people: [], error: 'pdl_not_configured', creditCharged: false };

  const domain = String(website || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
  if (!domain) return { enabled: true, people: [], error: 'missing_website', creditCharged: false };

  // SQL: only titles containing founder/co-founder (not CEO-only)
  const escaped = domain.replace(/'/g, "''");
  const sql = `SELECT * FROM person WHERE job_company_website='${escaped}' AND (job_title LIKE '%founder%' OR job_title LIKE '%co-founder%' OR job_title LIKE '%cofounder%') LIMIT ${Math.min(size, 10)}`;

  try {
    const { ok, status, json } = await fetchJson(PERSON_SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-Api-Key': key,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql, size: Math.min(size, 10) }),
      timeoutMs
    });
    if (!ok) {
      return {
        enabled: true,
        people: [],
        error: json?.error?.message || `http_${status}`,
        creditCharged: false,
        status
      };
    }
    const data = Array.isArray(json?.data) ? json.data : [];
    return {
      enabled: true,
      people: data,
      error: null,
      creditCharged: true,
      status: 200,
      total: json?.total ?? data.length
    };
  } catch (e) {
    return {
      enabled: true,
      people: [],
      error: e.name === 'AbortError' ? 'timeout' : String(e.message || e),
      creditCharged: false
    };
  }
}
