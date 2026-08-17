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

/**
 * Wikipedia infobox `| founder / founders =` — wikilinks, not the lead paragraph.
 * Lead summaries usually omit founders, which is why coverage was so low.
 */
export function extractInfoboxFounderNames(wikitext) {
  const t = String(wikitext || '');
  if (!t) return [];
  const field = t.match(/\|\s*founders?\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=|\n\}\})/i);
  const raw = field ? field[1] : '';
  if (!raw.trim()) return [];
  const names = [];
  const re = /\[\[(?!File:|Image:)([^\]|#]+)(?:\|[^\]]+)?\]\]/gi;
  let m;
  while ((m = re.exec(raw))) {
    const name = String(m[1] || '')
      .replace(/_/g, ' ')
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.split(/\s+/).length >= 2 && name.length < 60 && !/^(infobox|unbulleted|ubl|plainlist)$/i.test(name)) {
      names.push(name);
    }
  }
  if (!names.length) {
    const plain = raw
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .replace(/<ref[\s\S]*?<\/ref>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/'{2,}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const person = plain.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})$/);
    if (person) names.push(person[1]);
  }
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

export function scoreWikipediaTitleForCompany(title, companyName) {
  const rawTitle = String(title || '');
  const rawName = String(companyName || '');
  if (!rawTitle || !rawName) return 0;
  if (/\(disambiguation\)|\balbum\b|\bfilm\b|\bsong\b|\btv series\b|\blist of\b/i.test(rawTitle)) return -100;
  const t = rawTitle.toLowerCase();
  const n = rawName
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|corp|corporation|ltd|co|plc|pbc|group)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || n.length < 2) return 0;
  const tCore = t.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  let s = 0;
  if (tCore === n) s += 50;
  if (t === n || t.startsWith(`${n} `) || t.startsWith(`${n},`)) s += 25;
  if (/\((?:company|firm|business|bank|organization|organisation)\)/i.test(rawTitle)) s += 20;
  if (n.length >= 4 && (t.includes(n) || tCore.includes(n))) s += 15;
  const tokens = n.split(/\s+/).filter((tok) => tok.length > 2);
  if (tokens.length >= 2 && tokens.every((tok) => t.includes(tok))) s += 12;
  return s;
}

/**
 * Founder-fill cache / rule version. Bump this string when founder-resolution
 * rules change so stale enrichCache rows are not reused.
 * v10: weighted Wikipedia mismatch scores (industry 2 / HQ 1.5 / founded 1, skip at >= 3),
 * completenessReason on founderDebug, partial-male guard counter, learned gender short-circuit.
 * v9: wiki disambiguation guard, infobox↔P112 completeness, team-bio fallback,
 * nameVariants search, Unknown: no data vs pipeline error.
 */
export const FOUNDERS_PIPELINE_VERSION = 'founders-v10';

export const FOUNDERS_UNKNOWN_LABELS = {
  unknown_no_data: 'Unknown: no data',
  unknown_pipeline_error: 'Unknown: pipeline error'
};

export function companyNameCore(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parenthetical aliases plus identity-lock aka / former / matched names. Current name is not included. */
export function collectNameVariants(companyName, extras = []) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    const s = String(n || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const raw = String(companyName || '');
  const parenRe = /\(([^)]{2,60})\)/g;
  let m;
  while ((m = parenRe.exec(raw))) push(m[1]);
  const withoutParen = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutParen && withoutParen.toLowerCase() !== raw.trim().toLowerCase()) push(withoutParen);
  for (const extra of extras || []) push(extra);
  const current = raw.trim().toLowerCase();
  return out.filter((v) => v.toLowerCase() !== current);
}

function cleanInfoboxValue(raw) {
  return String(raw || '')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/<ref[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractInfoboxField(wikitext, keys) {
  const t = String(wikitext || '');
  for (const key of keys) {
    const re = new RegExp(
      String.raw`\|\s*${key}\s*=\s*([\s\S]*?)(?=\n\s*\|\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=|\n\}\}|$)`,
      'i'
    );
    const m = t.match(re);
    if (m && String(m[1]).trim()) return cleanInfoboxValue(m[1]);
  }
  return '';
}

export function extractYearFromText(raw) {
  const m = String(raw || '').match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  return m ? Number(m[1]) : null;
}

export function extractInfoboxMeta(wikitext) {
      const industry = extractInfoboxField(wikitext, ['industry', 'industries']);
  const founded = extractInfoboxField(wikitext, ['founded', 'established', 'foundation']);
  const hq = extractInfoboxField(wikitext, [
    'headquarters',
    'hq',
    'hq_location',
    'hq_location_city',
    'location',
    'location_city'
  ]);
  const former = extractInfoboxField(wikitext, [
    'former_name',
    'former_names',
    'native_name',
    'aka',
    'also_known_as',
    'traded_as'
  ]);
  return {
    industry,
    founded,
    foundedYear: extractYearFromText(founded),
    hq,
    formerNames: former
  };
}

export function classifyNameMatchKind(title, companyName, extraAliases = []) {
  const coreName = companyNameCore(companyName);
  const coreTitle = companyNameCore(title);
  if (!coreName || !coreTitle) return 'none';
  const titleScore = scoreWikipediaTitleForCompany(title, companyName);
  if (titleScore < 0) return 'none';
  if (coreTitle === coreName) return 'exact';
  const aliases = [companyName, ...(extraAliases || [])].map(companyNameCore).filter(Boolean);
  if (aliases.some((a) => a === coreTitle)) return 'exact';
  if (
    coreTitle.startsWith(`${coreName} `) ||
    coreName.startsWith(`${coreTitle} `) ||
    titleScore >= 50 ||
    /\((?:company|firm|business|bank|organization|organisation)\)/i.test(String(title || ''))
  ) {
    return 'near-exact';
  }
  if (titleScore >= 25) return 'weak';
  return 'none';
}

export function industryFieldsCompatible(resolvedIndustry, infoboxIndustry) {
  if (isBlankOrUnknown(resolvedIndustry) || !infoboxIndustry) return true;
  const na = normalizeIndustry(resolvedIndustry);
  const nb = normalizeIndustry(infoboxIndustry);
  if (!isBlankOrUnknown(na) && !isBlankOrUnknown(nb) && na.toLowerCase() === nb.toLowerCase()) return true;
  const tokens = (s) =>
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3);
  const a = tokens(resolvedIndustry);
  const b = tokens(infoboxIndustry);
  if (a.some((t) => b.includes(t))) return true;
  const families = [
    /software|saas|technology|internet|computer|electronics|semiconductor|gpu/,
    /venture|capital|private.?equity|investment|asset management/,
    /health|bio|pharma|medical|therapeutics/,
    /energy|oil|gas|renewable|climate/,
    /bank|fintech|payment|financial/
  ];
  const blobA = String(resolvedIndustry);
  const blobB = String(infoboxIndustry);
  return families.some((re) => re.test(blobA) && re.test(blobB));
}

export function locationFieldsCompatible(resolvedLocation, infoboxHq) {
  if (isBlankOrUnknown(resolvedLocation) || !infoboxHq) return true;
  const na = normalizeLocation(resolvedLocation).toLowerCase();
  const nb = normalizeLocation(infoboxHq).toLowerCase();
  if (na && nb && (na === nb || na.includes(nb) || nb.includes(na))) return true;
  const tokens = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !['the', 'and', 'united', 'states', 'usa', 'city'].includes(t));
  const a = new Set(tokens(resolvedLocation));
  const b = new Set(tokens(infoboxHq));
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}

/**
 * Reject a Wikipedia page for founders unless the title is exact/near-exact
 * AND the weighted infobox mismatch score is below 3.
 * Weights: industry 2, HQ 1.5, founded-year 1. Missing fields are not mismatches.
 */
export const WIKI_MISMATCH_WEIGHTS = { industry: 2, location: 1.5, founded: 1 };
export const WIKI_MISMATCH_WEIGHT_THRESHOLD = 3;

export function weightedWikiMismatchScore(mismatches = []) {
  const contributed = [];
  let weightedScore = 0;
  for (const field of mismatches) {
    const weight = WIKI_MISMATCH_WEIGHTS[field];
    if (!weight) continue;
    weightedScore += weight;
    contributed.push({ field, weight });
  }
  return {
    weightedScore,
    contributed,
    overThreshold: weightedScore >= WIKI_MISMATCH_WEIGHT_THRESHOLD
  };
}

export function scoreWikipediaPageAgainstResolved(page, resolved = {}) {
  const title = page?.title || '';
  const wikitext = page?.wikitext || '';
  const pageAliases = page?.aliases || [];
  const companyName = String(resolved.companyName || '').trim();
  const variants = collectNameVariants(companyName, resolved.nameVariants);
  const searchNames = [companyName, ...variants].filter(Boolean);
  const meta = extractInfoboxMeta(wikitext);
  const infoboxAliases = String(meta.formerNames || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let nameMatchKind = 'none';
  let titleScore = 0;
  let matchedVariant = companyName;
  const rank = { exact: 3, 'near-exact': 2, weak: 1, none: 0 };
  for (const n of searchNames) {
    const kind = classifyNameMatchKind(title, n, [...pageAliases, ...infoboxAliases]);
    const sc = scoreWikipediaTitleForCompany(title, n);
    if (rank[kind] > rank[nameMatchKind] || (kind === nameMatchKind && sc > titleScore)) {
      nameMatchKind = kind;
      titleScore = sc;
      matchedVariant = n;
    }
  }
  if (nameMatchKind !== 'exact' && nameMatchKind !== 'near-exact' && meta.formerNames) {
    for (const n of searchNames) {
      if (companyNameCore(n) && meta.formerNames.toLowerCase().includes(companyNameCore(n))) {
        nameMatchKind = 'near-exact';
        matchedVariant = n;
        break;
      }
    }
  }

  const reasons = [];
  const mismatches = [];
  if (nameMatchKind !== 'exact' && nameMatchKind !== 'near-exact') {
    reasons.push(
      `encyclopedia skipped — low confidence match (name is ${nameMatchKind}, not exact/near-exact)`
    );
    return {
      ok: false,
      score: titleScore,
      nameMatchKind,
      mismatches: ['name'],
      reasons,
      matchedVariant,
      meta
    };
  }

  if (!industryFieldsCompatible(resolved.industry, meta.industry)) {
    mismatches.push('industry');
    reasons.push(`industry mismatch: resolved=${resolved.industry} infobox=${meta.industry}`);
  }
  const resolvedYear = resolved.foundedYear || extractYearFromText(resolved.founded);
  if (resolvedYear && meta.foundedYear && Number(resolvedYear) !== Number(meta.foundedYear)) {
    mismatches.push('founded');
    reasons.push(`founded year mismatch: resolved=${resolvedYear} infobox=${meta.foundedYear}`);
  }
  if (!locationFieldsCompatible(resolved.location, meta.hq)) {
    mismatches.push('location');
    reasons.push(`HQ mismatch: resolved=${resolved.location} infobox=${meta.hq}`);
  }

  if (mismatches.length >= 1) {
    const weights = weightedWikiMismatchScore(mismatches);
    if (weights.overThreshold) {
      reasons.push(
        `encyclopedia skipped — low confidence match (weighted mismatch ${weights.weightedScore} >= ${WIKI_MISMATCH_WEIGHT_THRESHOLD}; ${weights.contributed.map((c) => `${c.field}×${c.weight}`).join(', ')})`
      );
      return {
        ok: false,
        score: titleScore,
        nameMatchKind,
        mismatches,
        reasons,
        matchedVariant,
        meta,
        weightedMismatchScore: weights.weightedScore,
        mismatchWeights: weights.contributed
      };
    }
  }

  const weights = weightedWikiMismatchScore(mismatches);
  reasons.push(
    `wikipedia accepted (${nameMatchKind} name match via ${matchedVariant}; weighted mismatch ${weights.weightedScore})`
  );
  return {
    ok: true,
    score: titleScore + Math.max(0, 20 - weights.weightedScore * 4),
    nameMatchKind,
    mismatches,
    reasons,
    matchedVariant,
    meta,
    weightedMismatchScore: weights.weightedScore,
    mismatchWeights: weights.contributed
  };
}

export function founderNameKeySet(names) {
  const arr = Array.isArray(names)
    ? names
    : String(names || '')
        .split(/\s*;\s*/)
        .map((s) => s.trim());
  const set = new Set();
  for (const n of arr) {
    const k = String(n || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (k.split(/\s+/).length >= 2) set.add(k);
  }
  return set;
}

/**
 * Infobox wikilinks vs Wikidata P112 on the same QID.
 * complete = same count and the name sets are identical.
 * partial = one source missing, counts differ, or names do not overlap.
 */
export function founderListCompletenessDetail(infoboxNames, p112Names) {
  const a = founderNameKeySet(infoboxNames);
  const b = founderNameKeySet(p112Names);
  const infoboxCount = a.size;
  const p112Count = b.size;
  if (!a.size && !b.size) {
    return { completeness: 'none', completenessReason: null, infoboxCount, p112Count, completenessReasonDetail: null };
  }
  if (!a.size && b.size) {
    return {
      completeness: 'partial',
      completenessReason: 'infobox_empty',
      infoboxCount,
      p112Count,
      completenessReasonDetail: `infobox: ${infoboxCount}, P112: ${p112Count}`
    };
  }
  if (a.size && !b.size) {
    return {
      completeness: 'partial',
      completenessReason: 'p112_empty',
      infoboxCount,
      p112Count,
      completenessReasonDetail: `infobox: ${infoboxCount}, P112: ${p112Count}`
    };
  }
  let overlap = 0;
  for (const k of a) {
    if (b.has(k)) overlap += 1;
  }
  if (overlap === 0) {
    return {
      completeness: 'partial',
      completenessReason: 'no_overlap',
      infoboxCount,
      p112Count,
      completenessReasonDetail: `infobox: ${infoboxCount}, P112: ${p112Count}`
    };
  }
  if (a.size === b.size && overlap === a.size) {
    return { completeness: 'complete', completenessReason: null, infoboxCount, p112Count, completenessReasonDetail: null };
  }
  return {
    completeness: 'partial',
    completenessReason: 'count_mismatch',
    infoboxCount,
    p112Count,
    completenessReasonDetail: `infobox: ${infoboxCount}, P112: ${p112Count}`
  };
}

export function classifyFounderListCompleteness(infoboxNames, p112Names) {
  return founderListCompletenessDetail(infoboxNames, p112Names).completeness;
}

export function classifyFoundersUnknownStatus(contacts, pipelineErrors = []) {
  if (!isBlankOrUnknown(contacts)) return null;
  if (Array.isArray(pipelineErrors) && pipelineErrors.length) return 'unknown_pipeline_error';
  return 'unknown_no_data';
}

export function extractExplicitFoundedByNames(text) {
  const blob = String(text || '');
  const collected = [];
  const push = (raw) => {
    const n = normalizeFounders(raw);
    if (!isBlankOrUnknown(n)) collected.push(n);
  };
  const foundedBy =
    /(?:[Ff]ounded by|[Cc]o-founded by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,3}(?:\s+(?:and|&|,)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,3}){0,4})/g;
  let m;
  while ((m = foundedBy.exec(blob))) push(m[1]);
  const isFounder =
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:is|was)\s+(?:a\s+|the\s+)?(?:co-)?founder\b/gi;
  while ((m = isFounder.exec(blob))) push(m[1]);
  return normalizeFounders(collected.join('; '));
}

/**
 * Tertiary team/people bio pass. Requires Founder / Co-Founder / Founding Partner
 * in the title. CEO / President alone is ignored.
 */
export function extractFounderTitleBios(text) {
  const blob = String(text || '');
  const collected = [];
  const skipName = (name) =>
    /^(Our|The|Meet|Team|About|Leadership|Company|Board|Staff|People|Home|Contact)$/i.test(name);
  const pushName = (raw) => {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!name || skipName(name) || name.split(/\s+/).length < 2) return;
    if (isExecTitleNotFounder(name)) return;
    const n = normalizeFounders(name);
    if (!isBlankOrUnknown(n)) collected.push(n);
  };
  const founderTitle = /\b(?:co-?founders?|founders?|founding\s+(?:partner|member))\b/i;
  const labeled =
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s*[,;:\u2013\u2014\-]\s*([^\n|]{2,80})/g;
  let m;
  while ((m = labeled.exec(blob))) {
    if (founderTitle.test(m[2])) pushName(m[1]);
  }
  const reverse =
    /\b(?:Co-)?Founders?\b(?:\s*[&,/]\s*(?:CEO|CTO|COO|President|Partner))?[^\n]{0,24}?([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})/g;
  while ((m = reverse.exec(blob))) {
    if (!/^(by|the|our|a)$/i.test(m[1])) pushName(m[1]);
  }
  const twoLine =
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s*[\n|]\s*(?:Co-)?Founder\b|\bFounding\s+(?:Partner|Member)\b/g;
  while ((m = twoLine.exec(blob))) pushName(m[1]);
  return normalizeFounders(collected.join('; '));
}

/** JSON-LD / founded-by first; team bios only when both are empty. */
export function mergeOfficialSiteFounders({ jsonLd = '', explicit = '', bios = '' } = {}) {
  const primary = normalizeFounders(
    [jsonLd, explicit].filter((v) => !isBlankOrUnknown(v)).join('; ')
  );
  if (!isBlankOrUnknown(primary)) return primary;
  return isBlankOrUnknown(bios) ? UNKNOWN : normalizeFounders(bios);
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
 * Gender used on the screening column.
 * Female / mixed still keep on a partial Wikipedia list (a woman must not be hidden).
 * All-male auto-skip is allowed only when infobox founders and Wikidata P112 agree
 * (completeness === 'complete'). A partial Wikipedia list routes to Unknown / review.
 * Non-Wikipedia sources (dictionary / site) keep summarizeFoundingTeamGender as-is
 * because completeness is 'none'.
 */
export function genderForFoundingTeamScreen(genders, completeness) {
  const gender = summarizeFoundingTeamGender(genders);
  if (gender === 'Male' && completeness === 'partial') return UNKNOWN;
  return gender;
}

/**
 * Additive wrapper around genderForFoundingTeamScreen. Does not change that
 * function's return values. A learned gender confirmation for this company
 * is checked before the partial-all-male → Unknown guard is applied.
 */
export function applyScreenedFoundingTeamGender(genders, completeness, opts = {}) {
  const rawGender = summarizeFoundingTeamGender(genders);
  const screenedGender = genderForFoundingTeamScreen(genders, completeness);
  const guardWouldBlock = completeness === 'partial' && rawGender === 'Male' && screenedGender === UNKNOWN;
  const learnedGender = String(opts.learnedGender || '').trim();
  const learnedOk = learnedGender && !/^unknown$/i.test(learnedGender);
  if (guardWouldBlock && learnedOk) {
    return {
      gender: learnedGender,
      rawGender,
      screenedGender,
      guardFired: false,
      guardShortCircuited: true
    };
  }
  return {
    gender: screenedGender,
    rawGender,
    screenedGender,
    guardFired: guardWouldBlock,
    guardShortCircuited: false
  };
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
