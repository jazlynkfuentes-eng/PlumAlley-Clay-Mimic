/**
 * Validate PDL company enrich responses before consuming fields.
 */

import { companyMatchKey, stripLegalSuffixes } from './enrichment-quality.mjs';

export function normalizeDomainHost(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/:\d+$/, '')
    .replace(/[^a-z0-9.-]/g, '');
}

export function apexDomain(host) {
  const h = normalizeDomainHost(host);
  if (!h) return '';
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  // Keep simple eTLD+1 (good enough for enrichment matching; not a full PSL)
  const last2 = parts.slice(-2).join('.');
  const last3 = parts.slice(-3).join('.');
  if (/^(co|com|org|net|gov|ac)\.[a-z]{2}$/i.test(last2) || /\.(co|com|org|net)\.[a-z]{2}$/i.test(last3)) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

function nameTokensSimilar(a, b) {
  const ka = companyMatchKey(a);
  const kb = companyMatchKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.length >= 4 && kb.includes(ka)) return true;
  if (kb.length >= 4 && ka.includes(kb)) return true;
  return false;
}

/**
 * @returns {{
 *   pdlMatchStatus: 'accepted'|'rejected'|'not_found'|'error'|'disabled',
 *   pdlLikelihood: number|null,
 *   pdlMatchedDomain: string|null,
 *   pdlMatchedName: string|null,
 *   reason: string|null,
 *   accepted: boolean
 * }}
 */
export function validatePdlCompanyMatch({
  requestedDomain,
  requestedName,
  pdlResponse,
  minLikelihood = 6
} = {}) {
  if (!pdlResponse || pdlResponse.enabled === false) {
    return {
      pdlMatchStatus: 'disabled',
      pdlLikelihood: null,
      pdlMatchedDomain: null,
      pdlMatchedName: null,
      reason: 'pdl_not_configured',
      accepted: false
    };
  }
  if (pdlResponse.status === 404 || pdlResponse.error === 'not_found') {
    return {
      pdlMatchStatus: 'not_found',
      pdlLikelihood: null,
      pdlMatchedDomain: null,
      pdlMatchedName: null,
      reason: 'not_found',
      accepted: false
    };
  }
  if (pdlResponse.error && pdlResponse.status !== 200) {
    return {
      pdlMatchStatus: 'error',
      pdlLikelihood: pdlResponse.likelihood ?? null,
      pdlMatchedDomain: null,
      pdlMatchedName: null,
      reason: pdlResponse.error,
      accepted: false
    };
  }

  const data = pdlResponse.data;
  if (!data || pdlResponse.status !== 200) {
    return {
      pdlMatchStatus: 'error',
      pdlLikelihood: pdlResponse.likelihood ?? null,
      pdlMatchedDomain: null,
      pdlMatchedName: null,
      reason: 'empty_response',
      accepted: false
    };
  }

  const likelihood = Number(data.likelihood ?? pdlResponse.likelihood ?? 0);
  const matchedDomain = normalizeDomainHost(data.website || '');
  const matchedName = data.name || null;
  const reqApex = apexDomain(requestedDomain);
  const matchedApex = apexDomain(matchedDomain);
  const altDomains = [...(data.alternative_domains || []), ...(data.profiles || [])]
    .map((d) => apexDomain(String(d).replace(/^https?:\/\//, '').replace(/.*company\//, '')))
    .filter(Boolean);

  const domainOk =
    Boolean(reqApex) &&
    (matchedApex === reqApex ||
      altDomains.includes(reqApex) ||
      (matchedApex && reqApex.endsWith(`.${matchedApex}`)) ||
      (matchedApex && matchedApex.endsWith(`.${reqApex}`)));

  const aliases = [...(data.alternative_names || []), matchedName].filter(Boolean);
  const nameOk =
    !requestedName ||
    aliases.some((n) => nameTokensSimilar(n, requestedName)) ||
    nameTokensSimilar(matchedName, requestedName);

  if (!Number.isFinite(likelihood) || likelihood < minLikelihood) {
    return {
      pdlMatchStatus: 'rejected',
      pdlLikelihood: likelihood,
      pdlMatchedDomain: matchedDomain || null,
      pdlMatchedName: matchedName,
      reason: `likelihood_${likelihood}_below_${minLikelihood}`,
      accepted: false
    };
  }

  if (!domainOk) {
    return {
      pdlMatchStatus: 'rejected',
      pdlLikelihood: likelihood,
      pdlMatchedDomain: matchedDomain || null,
      pdlMatchedName: matchedName,
      reason: `domain_mismatch_req_${reqApex}_got_${matchedApex || 'none'}`,
      accepted: false
    };
  }

  // If name is wildly different AND likelihood is only middling, reject
  if (requestedName && !nameOk && likelihood < 8) {
    return {
      pdlMatchStatus: 'rejected',
      pdlLikelihood: likelihood,
      pdlMatchedDomain: matchedDomain || null,
      pdlMatchedName: matchedName,
      reason: 'name_mismatch_with_moderate_likelihood',
      accepted: false
    };
  }

  return {
    pdlMatchStatus: 'accepted',
    pdlLikelihood: likelihood,
    pdlMatchedDomain: matchedDomain || matchedApex || null,
    pdlMatchedName: matchedName,
    reason: null,
    accepted: true
  };
}

/**
 * Only accept person records whose title explicitly includes founder language
 * and whose company website/name matches the resolved company.
 */
export function filterPdlFounderPeople(people, { domain, companyName } = {}) {
  const reqApex = apexDomain(domain);
  const out = [];
  for (const p of people || []) {
    const title = String(p.job_title || p.headline || '').toLowerCase();
    if (!/\b(co-?founder|founder)\b/i.test(title)) continue;
    // Reject if title is only executive without founder word (already required above)
    const jobWebsite = normalizeDomainHost(p.job_company_website || p.job_company_website_clean || '');
    const jobApex = apexDomain(jobWebsite);
    const companyOk =
      !reqApex ||
      jobApex === reqApex ||
      nameTokensSimilar(p.job_company_name || '', companyName || '');
    if (!companyOk) continue;
    const fullName = [p.full_name, [p.first_name, p.last_name].filter(Boolean).join(' ')].find((n) => n && String(n).trim());
    if (!fullName || String(fullName).split(/\s+/).length < 2) continue;
    out.push({
      name: String(fullName).trim(),
      title: p.job_title || null,
      evidence: `${fullName} — ${p.job_title || 'Founder'} @ ${p.job_company_name || domain}`
    });
  }
  return out;
}
