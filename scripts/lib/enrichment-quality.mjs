import { classifyIndustry } from './industry-classify.mjs';

export { classifyIndustry } from './industry-classify.mjs';
export {
  scoreIdentityCandidate,
  selectIdentity,
  hostOf as identityHostOf,
  JUNK_DOMAIN_RE
} from './identity-resolve.mjs';

export const UNKNOWN = 'Unknown';

export const PIPELINE_NOTES_RE =
  /Verifying selected domain\.?\.?\.?|Queueing\.?\.?\.?|Re-running enrichment\.?\.?\.?|Enriching confirmed|Select the correct website|Pick a candidate|Select or enter a domain|Ambiguous matches|Candidates:|Possible matches|Could not verify|Could not fetch|Could not resolve|Domain does not resolve|Page content does not match|AI search error|Score \d+|confirm required|Low confidence|Auto-selected \([^)]+\)|scrape failed|SPARQL|DNS|HTTP \d{3}|retry|timeout|allorigins|corsproxy|codetabs|enrichSource|confidenceScore|resolveMethod|major firm/gi;

/** Legal suffixes stripped for matching (canonical display name preserved separately). */
export const LEGAL_SUFFIX_RE =
  /\b(inc\.?|incorporated|llc|l\.l\.c\.?|llp|l\.l\.p\.?|lp|l\.p\.?|plc|ltd\.?|limited|corp\.?|corporation|co\.?|company|holdings?|group|gmbh|ag|sa|nv|bv|pvt\.?|pte\.?|spa|srl)\b/gi;

export const INDUSTRY_TAXONOMY = [
  { re: /\b(semiconductor|chipmaker|chip design|invents the GPU|GPU (?:chip|company|maker)|foundry)\b/i, label: 'Semiconductors' },
  { re: /\b(cybersecurity|cyber security|information security)\b/i, label: 'Cybersecurity' },
  { re: /\b(enterprise software|b2b software|\bSaaS\b|productivity software|cloud software|developer tools)\b/i, label: 'Enterprise Software' },
  { re: /\b(fintech|financial technology|payments? infrastructure|neobank|corporate cards)\b/i, label: 'Fintech' },
  { re: /\b(biotech|biotechnology|therapeutics|genomics|gene sequencing)\b/i, label: 'Biotechnology' },
  { re: /\b(healthcare|health care|medical device|hospital system|clinical)\b/i, label: 'Healthcare' },
  { re: /\b(e-?commerce|online retail|direct[- ]to[- ]consumer|marketplace)\b/i, label: 'E-Commerce' },
  { re: /\b(consumer electronics|apparel|footwear|eyewear|consumer brand|consumer goods)\b/i, label: 'Consumer' },
  { re: /\b(streaming|media company|entertainment company|publishing)\b/i, label: 'Media & Entertainment' },
  { re: /\b(gaming|video game|game studio)\b/i, label: 'Gaming' },
  { re: /\b(renewable energy|clean energy|solar|wind power|climate tech)\b/i, label: 'Renewable Energy' },
  { re: /\b(oil\s*(?:&|and)\s*gas|petroleum|upstream energy)\b/i, label: 'Oil & Gas' },
  { re: /\b(electric utility|power generation|energy company)\b/i, label: 'Energy' },
  { re: /\b(aerospace|defense contractor|space systems|autonomous defense)\b/i, label: 'Aerospace & Defense' },
  { re: /\b(industrial|manufacturing|automation|robotics)\b/i, label: 'Industrial Technology' },
  { re: /\b(automotive|electric vehicle|\bEV\b|mobility)\b/i, label: 'Automotive' },
  { re: /\b(venture capital|\bVC firm\b|early[- ]stage (?:venture|investor)|seed (?:and|&) early)\b/i, label: 'Venture Capital' },
  { re: /\b(private equity|\bPE firm\b|buyout)\b/i, label: 'Private Equity' },
  { re: /\b(investment bank|investment banking|M&A advisory)\b/i, label: 'Investment Banking' },
  { re: /\b(asset management|investment management|wealth management)\b/i, label: 'Asset Management' },
  { re: /\b(hedge fund)\b/i, label: 'Hedge Fund' },
  { re: /\b(real estate|reit|property investment)\b/i, label: 'Real Estate' },
  { re: /\b(professional services|consulting|advisory firm)\b/i, label: 'Professional Services' },
  { re: /\b(higher education|research university|\buniversity\b|\bcollege\b)\b/i, label: 'Education' },
  { re: /\b(government|public agency|municipal|federal agency)\b/i, label: 'Government' },
  { re: /\b(nonprofit|non-profit|foundation|charity)\b/i, label: 'Nonprofit / Foundation' },
  { re: /\b(legal services|law firm)\b/i, label: 'Legal Services' },
  { re: /\b(banking|commercial bank|retail bank)\b/i, label: 'Banking' },
  // AI last among tech labels — many sites mention "AI" without being AI companies
  { re: /\b(artificial intelligence (?:company|lab|research)|AI (?:company|lab|research|safety)|generative AI (?:company|lab))\b/i, label: 'Artificial Intelligence' },
  { re: /\b(technology company|software company)\b/i, label: 'Technology' }
];

export function isBlankOrUnknown(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return (
    !s ||
    s === '-' ||
    /^unknown$/i.test(s) ||
    /^needs manual/i.test(s) ||
    /^needs verification/i.test(s) ||
    /^not_applicable$/i.test(s)
  );
}

export function normalizeEnrichValue(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function stripLegalSuffixes(name) {
  return String(name || '')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function companyMatchKey(name) {
  return stripLegalSuffixes(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Expand messy pasted input into company-name lines.
 * Supports newlines, bullets, numbering, comma-separated lists, Excel row pastes.
 */
export function expandPastedCompanyInput(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  for (const line of text.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    s = s.replace(/^[\s]*[-*•●◦▪▸►]\s+/, '');
    s = s.replace(/^\d+[\.)]\s+/, '');
    s = s.replace(/^\[?\d+\]?\s+/, '');
    if (!s) continue;

    // Tab-separated person/company — keep as one logical line
    if (s.includes('\t')) {
      lines.push(s);
      continue;
    }

    // Comma-separated company list (no person titles): "Nvidia, Apple, Ramp"
    const commaParts = s.split(',').map((p) => p.trim()).filter(Boolean);
    const looksLikeList =
      commaParts.length >= 2 &&
      commaParts.every((p) => p.length <= 60 && !/\t/.test(p)) &&
      !/\b(Inc|LLC|Ltd|Corp|Corporation|LP|LLP|PLC)\s*,/i.test(s) &&
      commaParts.every((p) => !/\b(CEO|CTO|Partner|Director|Manager|Analyst)\b/i.test(p));
    // Allow "Apple Inc, Ramp" style if each segment is short
    const softList =
      commaParts.length >= 3 &&
      commaParts.every((p) => p.split(/\s+/).length <= 5) &&
      !/\b(CEO|Partner|Director)\b/i.test(s);

    if (looksLikeList || softList) {
      for (const part of commaParts) {
        if (part) lines.push(part);
      }
    } else {
      lines.push(s);
    }
  }
  return lines;
}

/**
 * Deduplicate company rows by match key (NVIDIA ≈ NVIDIA Corporation).
 * Keeps first occurrence's display name.
 */
export function dedupeCompanyNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const n = String(name || '').trim();
    if (!n) continue;
    const key = companyMatchKey(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function sanitizeUserFacingNotes(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s || s === '-') return '';
  s = s.replace(PIPELINE_NOTES_RE, ' ');
  s = s
    .split(/\s*[·|]\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      if (/^(verifying|queueing|searching|enriching|pending)/i.test(part)) return false;
      if (/score\s*\d+/i.test(part) && part.length < 40) return false;
      if (/verifying selected domain|sparql|confidence\s*0\.\d+/i.test(part)) return false;
      if (/may refer to|disambiguation|launching soon|open menu/i.test(part)) return false;
      return true;
    })
    .join(' · ');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*·\s*·+/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '').trim();
  if (!s || isBlankOrUnknown(s)) return '';
  return s.slice(0, 320);
}

export function normalizeIndustry(raw) {
  if (isBlankOrUnknown(raw)) return UNKNOWN;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  // Exact taxonomy short-circuits
  for (const { re, label } of INDUSTRY_TAXONOMY) {
    if (re.test(s)) return label;
  }
  // Collapse common aliases
  const aliases = {
    vc: 'Venture Capital',
    'v.c.': 'Venture Capital',
    pe: 'Private Equity',
    saas: 'Enterprise Software',
    'software / saas': 'Enterprise Software',
    'software & cloud': 'Enterprise Software',
    'financial technology': 'Fintech',
    'healthcare / biotech': 'Healthcare',
    'e-commerce / retail': 'E-Commerce',
    'media / entertainment': 'Media & Entertainment',
    aerospace: 'Aerospace & Defense',
    'climate tech vc': 'Venture Capital',
    'deep tech vc': 'Venture Capital'
  };
  const lower = s.toLowerCase();
  if (aliases[lower]) return aliases[lower];
  if (s.length <= 40) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bVc\b/g, 'VC');
  }
  return s.slice(0, 60);
}

const CITY_ALIASES = {
  nyc: 'New York, NY',
  'new york city': 'New York, NY',
  'new york': 'New York, NY',
  sf: 'San Francisco, CA',
  'san fran': 'San Francisco, CA',
  'san francisco': 'San Francisco, CA',
  la: 'Los Angeles, CA',
  'los angeles': 'Los Angeles, CA',
  'silicon valley': 'Palo Alto, CA',
  brooklyn: 'Brooklyn, NY',
  'palo alto': 'Palo Alto, CA',
  'menlo park': 'Menlo Park, CA',
  'sao paulo': 'São Paulo, Brazil',
  'são paulo': 'São Paulo, Brazil'
};

export function normalizeLocation(raw) {
  if (isBlankOrUnknown(raw)) return UNKNOWN;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  const alias = CITY_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  s = s
    .replace(/,\s*United States of America$/i, '')
    .replace(/,\s*United States$/i, '')
    .replace(/,\s*USA$/i, '')
    .replace(/,\s*US$/i, '');
  s = s.replace(/,\s*United Kingdom$/i, ', UK');
  return s.slice(0, 55);
}

const HEADCOUNT_BUCKETS = [
  { max: 10, label: '1–10' },
  { max: 50, label: '11–50' },
  { max: 200, label: '51–200' },
  { max: 500, label: '201–500' },
  { max: 1000, label: '501–1,000' },
  { max: 5000, label: '1,001–5,000' },
  { max: 10000, label: '5,001–10,000' },
  { max: Infinity, label: '10,001+' }
];

function parseHeadcountNumber(s) {
  const n = Number(String(s).replace(/,/g, '').replace(/\+/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function normalizeHeadcount(raw) {
  if (isBlankOrUnknown(raw)) return UNKNOWN;
  let s = String(raw).trim().replace(/\s+/g, ' ').replace(/-/g, '–').replace(/\bto\b/gi, '–');
  if (/more than\s*([\d,]+)|over\s*([\d,]+)|([\d,]+)\+/i.test(s)) {
    const m = s.match(/(?:more than|over)\s*([\d,]+)|([\d,]+)\+/i);
    const n = parseHeadcountNumber(m[1] || m[2]);
    if (n != null) {
      const effective = /more than|over/i.test(s) ? n + 1 : n;
      for (const bucket of HEADCOUNT_BUCKETS) {
        if (effective <= bucket.max) return bucket.label;
      }
    }
  }
  const range = s.match(/^(\d{1,3}(?:,\d{3})*|\d+)\s*[–-]\s*(\d{1,3}(?:,\d{3})*|\d+)\+?$/);
  if (range) {
    const a = parseHeadcountNumber(range[1]);
    const b = parseHeadcountNumber(range[2]);
    if (a != null && b != null) {
      const mid = Math.round((a + b) / 2);
      for (const bucket of HEADCOUNT_BUCKETS) {
        if (mid <= bucket.max) return bucket.label;
      }
    }
    return normalizeHeadcount(String(Math.round((parseHeadcountNumber(range[1]) + parseHeadcountNumber(range[2])) / 2)));
  }
  // Exact counts: allow up to 9 digits (with or without commas)
  const exact = s.match(/^(\d{1,3}(?:,\d{3})+|\d{1,9})\+?$/);
  if (exact) {
    const n = parseHeadcountNumber(exact[1]);
    if (n != null) {
      for (const bucket of HEADCOUNT_BUCKETS) {
        if (n <= bucket.max) return bucket.label;
      }
    }
  }
  const withWords = s.match(/(\d{1,3}(?:,\d{3})*|\d{1,9})\s*[–-]\s*(\d{1,3}(?:,\d{3})*|\d{1,9})/);
  if (withWords) return normalizeHeadcount(`${withWords[1]}–${withWords[2]}`);
  return s.slice(0, 40);
}

export function normalizeFounders(raw) {
  if (isBlankOrUnknown(raw)) return UNKNOWN;
  if (/^not_applicable$/i.test(String(raw).trim())) return 'not_applicable';
  let s = String(raw).trim();
  s = s.replace(/\s*\((?:Founder|Co-Founder|CEO|CTO|CFO|Partner|Managing Partner|MD)[^)]*\)/gi, '');
  s = s.replace(
    /,?\s*(?:Founder|Co-Founder|CEO|Chief Executive Officer|Managing Partner|Managing Director|General Partner|Chairman|President)\b/gi,
    ''
  );
  s = s.replace(/\s+and\s+/gi, '; ').replace(/\s*,\s*/g, '; ');
  const parts = s
    .split(/\s*;\s*/)
    .map((p) => p.trim())
    .filter((p) => p && p.split(/\s+/).length >= 2 && p.length < 60)
    .filter((p) => !/^(the|our|team|company)\b/i.test(p));
  if (!parts.length) return UNKNOWN;
  const seen = new Set();
  const out = [];
  for (const name of parts) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.join('; ') || UNKNOWN;
}

/** Wikidata P21: female, trans woman */
export const WD_GENDER_FEMALE = new Set(['Q6581072', 'Q1052281']);
/** Wikidata P21: male, trans man */
export const WD_GENDER_MALE = new Set(['Q6581097', 'Q2449503']);

export function qidFromWikidataUri(value) {
  const s = String(value || '').trim();
  const m = s.match(/Q(\d+)/i);
  return m ? `Q${m[1]}` : '';
}

export function genderFromWikidataQid(idOrUri) {
  const q = qidFromWikidataUri(idOrUri);
  if (WD_GENDER_FEMALE.has(q)) return 'Female';
  if (WD_GENDER_MALE.has(q)) return 'Male';
  return UNKNOWN;
}

function expandGenderToken(value) {
  const s = String(value || '').trim();
  if (!s || /^unknown$/i.test(s)) return [UNKNOWN];
  const hasF = /\bfemale\b/i.test(s);
  const hasM = /\bmale\b/i.test(s);
  if (hasF && hasM) return ['Female', 'Male'];
  if (hasF) return ['Female'];
  if (hasM) return ['Male'];
  return [UNKNOWN];
}

/**
 * Founding-team gender for screening (at least one woman), not current-CEO gender.
 * Male only when every listed founder is known male — incomplete lists stay Unknown.
 */
export function summarizeFoundingTeamGender(genders) {
  const tokens = [];
  for (const g of genders || []) tokens.push(...expandGenderToken(g));
  const hasF = tokens.some((t) => t === 'Female');
  const hasM = tokens.some((t) => t === 'Male');
  const hasU = !tokens.length || tokens.some((t) => t === UNKNOWN);
  if (hasF && hasM) return 'Female / Male';
  if (hasF) return 'Female';
  if (hasM && hasU) return UNKNOWN;
  if (hasM) return 'Male';
  return UNKNOWN;
}

/**
 * Dictionary "Name (CEO)" is current leadership, not a founder attribution.
 * Keep values that explicitly say founder / co-founder / founding partner.
 */
export function isExecTitleNotFounder(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/\b(?:founding\s+(?:partner|member)|co-?founders?|founders?)\b/i.test(s)) return false;
  return /\b(?:CEO|President|Managing Partner|Partner|CIO|CTO|CFO|Chairman|COO)\b/i.test(s);
}

/**
 * Finalize enrich fields for a batch row.
 * Repeated industry/location/headcount across companies is ALLOWED.
 * Never blank values solely because another company shares them.
 */
export function finalizeEnrichmentFields(fields) {
  const out = { ...fields };
  out.industry = normalizeIndustry(out.industry);
  out.headcount = normalizeHeadcount(out.headcount);
  out.location = normalizeLocation(out.location);
  out.contacts = normalizeFounders(out.contacts);
  out.notes = sanitizeUserFacingNotes(out.notes);
  if (!out.notes) out.notes = UNKNOWN;
  if (isBlankOrUnknown(out.gender)) out.gender = UNKNOWN;
  return out;
}

/** @deprecated Use finalizeEnrichmentFields — uniqueness blanking removed by design. */
export function applyBatchUniquenessGuardFixed(_registry, _domain, fields) {
  return finalizeEnrichmentFields(fields);
}

export function shouldBlockDuplicateIndustry(_value) {
  return false;
}

export function fieldRecord(value, source, confidence, extra = {}) {
  return {
    value: isBlankOrUnknown(value) ? UNKNOWN : value,
    source: source || 'none',
    sourceType: extra.sourceType || 'unknown',
    sourceUrl: extra.sourceUrl || null,
    confidence: confidence || 'low',
    method: extra.method || 'unknown',
    evidence: extra.evidence || null,
    fetchedAt: extra.fetchedAt || new Date().toISOString(),
    unknownReason: isBlankOrUnknown(value) ? extra.unknownReason || 'no_reliable_source_found' : null
  };
}

export function preferField(primary, fallback) {
  if (!isBlankOrUnknown(primary)) return primary;
  if (!isBlankOrUnknown(fallback)) return fallback;
  return UNKNOWN;
}

/**
 * Mine fields from free-text search / page corpus (industry-agnostic).
 */
export function extractFieldsFromSearchCorpus(corpus, companyName) {
  const text = String(corpus || '');
  const out = {
    industry: UNKNOWN,
    headcount: UNKNOWN,
    location: UNKNOWN,
    contacts: UNKNOWN,
    notes: UNKNOWN,
    provenance: {},
    unknownReason: {}
  };

  if (!text || text.length < 20) {
    out.unknownReason = { search: 'search_failed' };
    return out;
  }

  // Industry: evidence-based classifier on high-signal text only (not full page keyword scan)
  const highSignal = [
    text.match(/^[^.]{20,280}\./)?.[0],
    text.match(/\b(?:is an?|is a|provides|builds|develops|operates)[^.]{15,200}\./i)?.[0],
    text.slice(0, 500)
  ].filter(Boolean);
  const classified = classifyIndustry(highSignal);
  out.industry = classified.value;
  out.industryClassification = classified;
  if (!isBlankOrUnknown(classified.value)) {
    out.provenance.industry = fieldRecord(classified.value, classified.source, classified.confidence, {
      sourceType: 'classifier',
      method: 'evidence_based_industry',
      unknownReason: null
    });
    out.provenance.industry.evidence = classified.evidence;
  } else {
    out.unknownReason.industry = classified.source || 'insufficient_signal';
  }

  const loc =
    text.match(
      /\b(?:based in|headquartered in|headquarters in|HQ(?:\s+in)?)\s+([A-Z][a-zA-Z .'-]{1,40}?),\s*([A-Z]{2}|[A-Z][a-zA-Z][a-zA-Z .'-]{1,24})\b/
    ) ||
    text.match(
      /\b(?:based in|headquartered in|headquarters in|HQ(?:\s+in)?)\s+(New York City|San Francisco|Los Angeles|London|Boston|Chicago|Seattle|Austin|Palo Alto|Menlo Park|Brooklyn|São Paulo|Sao Paulo|Paris|Berlin|Tokyo|Singapore)\b/
    ) ||
    text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(CA|NY|TX|MA|WA|IL|CO|FL|GA|PA|UK|USA|Brazil|France|Germany|Japan)\b/);
  if (loc) {
    const rawLoc = loc[2] ? `${loc[1].trim()}, ${loc[2].trim()}` : loc[1].trim();
    out.location = normalizeLocation(rawLoc.replace(/\..*$/, '').replace(/\s+Inspiring.*$/i, '').trim());
    out.provenance.location = fieldRecord(out.location, 'search_snippet', 'medium', {
      sourceType: 'search',
      method: 'snippet_hq_phrase'
    });
  }

  const hc = text.match(
    /\b(?:(?:company size|employees?|team size|headcount)\s*[:=]?\s*)?(\d{1,3}(?:,\d{3})*\s*[–-]\s*\d{1,3}(?:,\d{3})*|\d{1,3}(?:,\d{3})*\+|more than\s+\d{1,3}(?:,\d{3})*)\s*(?:employees|people|team members)?\b/i
  );
  if (hc) {
    out.headcount = normalizeHeadcount(hc[1]);
    out.provenance.headcount = fieldRecord(out.headcount, 'search_snippet', 'medium', {
      sourceType: 'search',
      method: 'snippet_employee_range'
    });
  }

  const founder =
    text.match(
      /(?:(?:[Ff]ounded by|[Cc]o-founded by|[Ee]stablished by|[Ll]aunched by|[Ss]tarted by)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}(?:\s+(?:and|&)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})?)/
    ) ||
    text.match(
      /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:and|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+founded\b/
    ) ||
    text.match(
      /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:is|was)\s+(?:the\s+)?(?:co-)?founder\b/
    );
  if (founder) {
    const rawNames = founder[2] ? `${founder[1]}; ${founder[2]}` : founder[1];
    const name = normalizeFounders(rawNames);
    const companyLower = String(companyName || '').toLowerCase();
    const idx = text.search(/(?:[Ff]ounded by|[Cc]o-founded by|[Ff]ounders?[:\s]+)/);
    const window = idx >= 0 ? text.slice(Math.max(0, idx - 80), idx + 160).toLowerCase() : text.toLowerCase();
    const nameTokens = companyLower.split(/\s+/).filter((t) => t.length > 2);
    const nearCompany =
      nameTokens.length === 0 ||
      nameTokens.some((tok) => window.includes(tok)) ||
      window.includes(companyLower);
    if (!isBlankOrUnknown(name) && !companyLower.includes(name.toLowerCase()) && nearCompany) {
      out.contacts = name;
      out.provenance.contacts = fieldRecord(out.contacts, 'search_snippet', 'medium', {
        sourceType: 'search',
        method: 'snippet_founder_phrase'
      });
    }
  }

  const sentence = text.match(/([A-Z][^.]{40,180}\.)/);
  if (
    sentence &&
    !/wikipedia|duckduckgo|may refer to|disambiguation|launching soon|open menu|sign up to be/i.test(sentence[1])
  ) {
    out.notes = sanitizeUserFacingNotes(sentence[1]);
    if (out.notes) {
      out.provenance.notes = fieldRecord(out.notes, 'search_snippet', 'low', {
        sourceType: 'search',
        method: 'snippet_abstract'
      });
    }
  }

  return out;
}

export function makeFieldBag(value, source, confidence, extra = {}) {
  return fieldRecord(value, source, confidence, extra);
}
