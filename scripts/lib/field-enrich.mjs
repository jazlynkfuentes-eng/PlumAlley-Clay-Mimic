/**
 * Precision-first field enrichment: HQ, Founders, Headcount.
 * Only call when identityStatus === "resolved" with a trusted domain.
 */

import { UNKNOWN, isBlankOrUnknown, normalizeLocation, normalizeHeadcount, normalizeFounders, fieldRecord } from './enrichment-quality.mjs';

export const HEADCOUNT_BUCKETS = [
  '1–10',
  '11–50',
  '51–200',
  '201–500',
  '501–1,000',
  '1,001–5,000',
  '5,001–10,000',
  '10,001+'
];

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);

const US_STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC'
};

const KNOWN_COUNTRIES = new Set([
  'japan', 'uk', 'usa', 'germany', 'france', 'canada', 'australia', 'brazil', 'india', 'china',
  'sweden', 'netherlands', 'switzerland', 'ireland', 'spain', 'italy', 'singapore', 'south korea',
  'korea', 'mexico', 'israel', 'uae', 'hong kong'
]);

const SUBNATIONAL_NOT_COUNTRY = new Set([
  'aichi', 'osaka', 'hokkaido', 'kanagawa', 'california', 'texas', 'washington', 'massachusetts',
  'new york', 'florida', 'illinois', 'bavaria', 'england', 'scotland', 'wales', 'ontario', 'quebec'
]);

const NON_HQ_CONTEXT = /\b(office in|offices in|office location|branch in|portfolio compan|invests in|investment in|incorporated in|incorporation|delaware|registered in|remote[- ]first|distributed team|founder (?:lives|based)|born in)\b/i;

const EXEC_NOT_FOUNDER = /\b(CEO|Chief Executive|President|Chairman|Chairwoman|Managing Partner|General Partner|Managing Director|Partner|CTO|CFO|COO|Chief Technology|Chief Financial)\b/i;

function emptyField(reason, extra = {}) {
  return fieldRecord(UNKNOWN, 'none', 'low', {
    method: 'abstain',
    unknownReason: reason,
    evidence: extra.evidence || null,
    ...extra
  });
}

/** Strip HTML → plain text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractJsonLdOrganization(html) {
  const blocks = String(html || '').match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const raw = block.replace(/<\/?script[^>]*>/gi, '');
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
      for (const n of nodes) {
        const types = [].concat(n['@type'] || []).map(String);
        if (!types.some((t) => /Organization|Corporation|LocalBusiness/i.test(t))) continue;
        return n;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function normalizeHqCandidate(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s+/g, ' ');
  // Strip leading HQ prose accidentally captured
  s = s
    .replace(/^(?:our\s+)?(?:global\s+|corporate\s+|world\s+)?headquarters(?:\s+are|\s+is)?(?:\s+located)?(?:\s+in)?\s+/i, '')
    .replace(/^(?:is\s+)?(?:based|headquartered)\s+in\s+/i, '')
    .replace(/^of\s+/i, '')
    .replace(/\s+and\s+(?:has|have)\s+offices?\b.*$/i, '')
    .trim();
  s = s
    .replace(/,\s*United States of America$/i, '')
    .replace(/,\s*United States$/i, '')
    .replace(/,\s*USA$/i, '')
    .replace(/,\s*U\.S\.A\.?$/i, '')
    .replace(/,\s*US$/i, '')
    .replace(/,\s*United Kingdom$/i, ', UK')
    .replace(/,\s*England$/i, ', UK')
    .replace(/\.$/, '');
  // City, Region/Prefecture, Country → City, Country
  const triple = s.match(/^([A-Za-z][A-Za-z .'-]+),\s*[A-Za-z][A-Za-z .'-]+,\s*([A-Za-z][A-Za-z .'-]+)$/);
  if (triple) {
    s = `${triple[1].trim()}, ${triple[2].trim()}`;
  }
  s = normalizeLocation(s);
  if (isBlankOrUnknown(s)) return null;
  if (/\b(employees?|founded|venture|equity|software|platform|inc|llc|located in|headquarters|of microsoft|lo\b)\b/i.test(s)) return null;
  if (s.length < 3 || s.length > 55) return null;
  // Require place-like shape: City, Region/Country or known solo city
  const cityState = s.match(/^([A-Za-z][A-Za-z .'-]+),\s*([A-Za-z]{2})$/);
  if (cityState && US_STATES.has(cityState[2].toUpperCase())) {
    const city = cityState[1].trim();
    if (/^(of|in|the|our|located)\b/i.test(city)) return null;
    if (city.split(/\s+/).length > 4) return null;
    return `${city}, ${cityState[2].toUpperCase()}`;
  }
  // Reject 2-letter leftovers that are not US states (e.g. "Ai" from Aichi)
  if (cityState && !US_STATES.has(cityState[2].toUpperCase())) return null;
  const cityCountry = s.match(/^([A-Za-z][A-Za-z .'-]+),\s*([A-Za-z][A-Za-z .'-]+)$/);
  if (cityCountry) {
    const city = cityCountry[1].trim();
    let regionOrCountry = cityCountry[2].trim();
    if (/^(of|in|the|our|located)\b/i.test(city)) return null;
    if (regionOrCountry.length < 2 || regionOrCountry.length > 32) return null;
    const regionLower = regionOrCountry.toLowerCase();
    // Map full US state names → abbrev
    if (US_STATE_NAMES[regionLower]) {
      return `${city}, ${US_STATE_NAMES[regionLower]}`;
    }
    // Subnational alone (prefecture) without country → reject; prefer City, Country form
    if (SUBNATIONAL_NOT_COUNTRY.has(regionLower) && !KNOWN_COUNTRIES.has(regionLower)) {
      return null;
    }
    if (KNOWN_COUNTRIES.has(regionLower) || regionOrCountry.length >= 4) {
      // Title-case country lightly
      if (/^[a-z]+$/i.test(regionOrCountry) && regionOrCountry.length > 3) {
        regionOrCountry = regionOrCountry[0].toUpperCase() + regionOrCountry.slice(1).toLowerCase();
      }
      return `${city}, ${regionOrCountry}`;
    }
    return `${city}, ${regionOrCountry}`;
  }
  // Bare city only if well-known
  const solo = s.toLowerCase();
  const KNOWN = new Set([
    'new york', 'san francisco', 'london', 'tokyo', 'singapore', 'paris', 'berlin',
    'stockholm', 'munich', 'cupertino', 'redmond', 'seattle', 'boston', 'chicago'
  ]);
  if (KNOWN.has(solo)) return normalizeLocation(s);
  return null;
}

function isExplicitHqPhrase(window) {
  return /\b(headquarters|headquartered|hq\b|corporate headquarters|global headquarters|based in)\b/i.test(window);
}

/**
 * Extract HQ candidates from text with evidence windows.
 */
export function extractHqFromText(text, opts = {}) {
  const t = String(text || '');
  const out = [];
  const patterns = [
    // Prefer City, Region, Country → keep City + Country
    /\b(?:global\s+|corporate\s+|world\s+)?headquarters(?:\s+are|\s+is|\s+in)?\s+(?:located\s+)?(?:in\s+)?([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z][a-zA-Z'-]{1,24}),\s*([A-Z][a-zA-Z'-]{1,24})\b/gi,
    /\bheadquartered\s+in\s+([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z][a-zA-Z'-]{1,24}),\s*([A-Z][a-zA-Z'-]{1,24})\b/gi,
    // US state: 2 letters only when not the start of a longer word (Aichi ≠ Ai)
    /\b(?:global\s+|corporate\s+|world\s+)?headquarters(?:\s+are|\s+is|\s+in)?\s+(?:located\s+)?(?:in\s+)?([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z]{2}(?![a-zA-Z])|[A-Z][a-zA-Z'-]{2,24})\b/gi,
    /\bheadquartered\s+in\s+([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z]{2}(?![a-zA-Z])|[A-Z][a-zA-Z'-]{2,24})\b/gi,
    /\b(?:is\s+)?based\s+in\s+([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z]{2}(?![a-zA-Z])|[A-Z][a-zA-Z'-]{2,24})\b/gi,
    /\bHQ(?:\s+in)?\s*[:\-]?\s*([A-Z][a-zA-Z '-]{1,40}?),\s*([A-Z]{2}(?![a-zA-Z])|[A-Z][a-zA-Z'-]{2,24})\b/gi,
    /\bheadquartered\s+in\s+(New York(?: City)?|San Francisco|Los Angeles|London|Boston|Chicago|Seattle|Austin|Palo Alto|Menlo Park|Mountain View|Cupertino|Santa Clara|Redmond|Seattle|Tokyo|Singapore|Berlin|Paris|São Paulo|Sao Paulo)\b/gi
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const idx = m.index;
      const window = t.slice(Math.max(0, idx - 60), idx + (m[0]?.length || 0) + 40);
      if (NON_HQ_CONTEXT.test(window) && !/\bheadquarters|headquartered\b/i.test(window)) continue;
      // Triple capture: City, Region, Country → City, Country
      const raw = m[3]
        ? `${m[1].trim()}, ${m[3].trim()}`
        : m[2]
          ? `${m[1].trim()}, ${m[2].trim()}`
          : m[1].trim();
      const value = normalizeHqCandidate(raw);
      if (!value) continue;
      const explicit = isExplicitHqPhrase(window);
      out.push({
        value,
        evidence: window.trim().slice(0, 220),
        explicit,
        source: opts.source || 'text',
        sourceUrl: opts.sourceUrl || null,
        authority: opts.authority || 1
      });
    }
  }
  return out;
}

/** True when founder title is attributed to a different organization (customer quote, press bio). */
export function isForeignFounderAttribution(window, companyName = '') {
  const w = String(window || '');
  // "Founder and CEO, Lightspeed" / "Founder of Acme" / "Co-Founder at Rivian"
  const m = w.match(
    /\b(?:Co-)?Founders?(?:\s+and\s+(?:CEO|CTO|President)|\s+&\s+(?:CEO|CTO|President))?\s*(?:,|of|at)\s+([A-Z][A-Za-z0-9&.'-]{1,40}(?:\s+[A-Z][A-Za-z0-9&.']{1,30}){0,3})/
  );
  if (!m) return false;
  let org = m[1]
    .replace(/\s+(?:Read|Inc|LLC|Ltd|Corp|Corporation|Company|the|story|case)\b.*$/i, '')
    .trim()
    .toLowerCase();
  if (!org || org.length < 2) return false;
  const c = String(companyName || '')
    .toLowerCase()
    .trim();
  if (!c) return true;
  if (org.includes(c) || c.includes(org)) return false;
  const cTokens = c.split(/\s+/).filter((t) => t.length > 2);
  if (cTokens.length && cTokens.every((tok) => org.includes(tok))) return false;
  // First significant token match (e.g. "Stripe Payments" vs "Stripe")
  if (cTokens[0] && org.split(/\s+/)[0] === cTokens[0]) return false;
  return true;
}

function companyInSentence(text, idx, matchLen, companyName) {
  const companyLower = String(companyName || '').toLowerCase();
  if (!companyLower) return true;
  const sentStart = Math.max(0, text.lastIndexOf('.', idx));
  const sentEnd = text.indexOf('.', idx + matchLen);
  const sentence = text.slice(sentStart, sentEnd === -1 ? idx + matchLen + 80 : sentEnd + 1).toLowerCase();
  const tokens = companyLower.split(/\s+/).filter((t0) => t0.length > 2);
  return (
    sentence.includes(companyLower) ||
    (tokens.length > 0 && tokens.every((tok) => sentence.includes(tok))) ||
    (tokens.length === 1 && sentence.includes(tokens[0]))
  );
}

/**
 * Extract founders — only explicit founder language.
 */
export function extractFoundersFromText(text, companyName = '', opts = {}) {
  const t = String(text || '');
  const out = [];
  const companyLower = String(companyName || '').toLowerCase();

  const patterns = [
    /(?:[Ff]ounded by|[Cc]o-founded by|[Ee]stablished by|[Ss]tarted by|[Ll]aunched by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,3}(?:\s+(?:and|&|,)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){0,3}){0,4})/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:and|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:co-)?founded\b/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s+(?:is|was)\s+(?:a\s+|the\s+)?(?:co-)?founder\b/g,
    /(?:[Ff]ounders?|[Cc]o-[Ff]ounders?)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}(?:\s*(?:,|;|and|&)\s*[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}){0,5})/g
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const idx = m.index;
      const window = t.slice(Math.max(0, idx - 50), idx + m[0].length + 80);
      // Reject "CEO John Smith" without founder language in window
      if (!/\b(founded|founder|co-founded|co-founder|established by|started by)\b/i.test(window)) continue;
      if (isForeignFounderAttribution(window, companyName)) continue;
      // Reject if the only role signal is executive without founder word nearby the name
      let rawNames = m[2] && m[1] && !/founded by|co-founded by/i.test(m[0])
        ? `${m[1]}; ${m[2]}`
        : m[1];

      const names = normalizeFounders(rawNames);
      if (isBlankOrUnknown(names)) continue;
      // Don't treat company name as person
      if (companyLower && names.toLowerCase().includes(companyLower)) continue;
      // Skip if capture looks like an executive title line without founder
      if (EXEC_NOT_FOUNDER.test(rawNames) && !/\bfounder\b/i.test(window)) continue;
      // Require company name in the same sentence (avoid unrelated bios on the page)
      if (companyLower && opts.requireCompanyNear !== false) {
        if (!companyInSentence(t, idx, m[0].length, companyName)) continue;
      }

      out.push({
        value: names,
        evidence: window.trim().slice(0, 240),
        source: opts.source || 'text',
        sourceUrl: opts.sourceUrl || null,
        authority: opts.authority || 1
      });
    }
  }

  // Explicit "Name, Co-Founder" / "Name – Founder" lines (team pages)
  // Reject customer quotes: "Dax Dasilva, Founder and CEO, Lightspeed"
  const lineRe =
    /(?:^|[\n.]\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,3})\s*[,;:\u2013\u2014\-]\s*((?:Co-)?Founder)\b/gi;
  let lm;
  while ((lm = lineRe.exec(t))) {
    const name = lm[1];
    if (/^(Our|The|Meet|Team|About|Leadership)\b/i.test(name)) continue;
    const window = t.slice(Math.max(0, lm.index - 20), lm.index + lm[0].length + 60);
    if (isForeignFounderAttribution(window, companyName)) continue;
    // Team labels: company may be in a prior sentence ("Meet the Acme team. Jane — Co-Founder.")
    const isTeamSource = /team/i.test(opts.source || '');
    if (companyLower && opts.requireCompanyNear !== false) {
      const nearWindow = t.slice(Math.max(0, lm.index - 160), lm.index + lm[0].length + 40).toLowerCase();
      const tokens = companyLower.split(/\s+/).filter((t0) => t0.length > 2);
      const near =
        nearWindow.includes(companyLower) ||
        (tokens.length > 0 && tokens.every((tok) => nearWindow.includes(tok))) ||
        (tokens.length === 1 && nearWindow.includes(tokens[0]));
      // Official team pages can label founders without repeating the company on every line
      if (!near && !isTeamSource) continue;
    }
    const names = normalizeFounders(name);
    if (isBlankOrUnknown(names)) continue;
    out.push({
      value: names,
      evidence: window.trim().slice(0, 200),
      source: opts.source || 'team_page',
      sourceUrl: opts.sourceUrl || null,
      authority: opts.authority || 2
    });
  }

  return out;
}

/**
 * Extract headcount — never from team-page headcount of listed people.
 */
export function extractHeadcountFromText(text, opts = {}) {
  const t = String(text || '');
  const out = [];
  if (opts.rejectTeamPage && /\b(our team|meet the team|leadership team)\b/i.test(t) && !/\b\d{2,}\s*employees\b/i.test(t)) {
    return out;
  }

  const patterns = [
    /\b(?:approximately|about|over|more than)?\s*(\d{1,3}(?:,\d{3})*)\s*[–-]\s*(\d{1,3}(?:,\d{3})*)\+?\s*(?:employees|people|team members|staff)\b/gi,
    /\b(?:company size|employees?|headcount|team size)\s*[:=]?\s*(\d{1,3}(?:,\d{3})*\s*[–-]\s*\d{1,3}(?:,\d{3})*\+?|\d{1,3}(?:,\d{3})*\+|more than\s+\d{1,3}(?:,\d{3})*)\b/gi,
    /\b(\d{1,3}(?:,\d{3})*)\+?\s*employees\b/gi,
    /\bemploys\s+(?:approximately\s+|about\s+|over\s+)?(\d{1,3}(?:,\d{3})*)\b/gi
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const idx = m.index;
      const window = t.slice(Math.max(0, idx - 40), idx + m[0].length + 30);
      // Skip LinkedIn follower traps / portfolio counts
      if (/\bfollowers|portfolio companies|customers|users\b/i.test(window)) continue;
      const raw = m[2] ? `${m[1]}–${m[2]}` : m[1];
      const value = normalizeHeadcount(raw);
      if (isBlankOrUnknown(value) || !HEADCOUNT_BUCKETS.includes(value) && !/^\d/.test(value)) {
        const bucketed = normalizeHeadcount(raw);
        if (isBlankOrUnknown(bucketed)) continue;
        out.push({
          value: bucketed,
          evidence: window.trim().slice(0, 200),
          source: opts.source || 'text',
          sourceUrl: opts.sourceUrl || null,
          authority: opts.authority || 1
        });
      } else {
        out.push({
          value: normalizeHeadcount(raw),
          evidence: window.trim().slice(0, 200),
          source: opts.source || 'text',
          sourceUrl: opts.sourceUrl || null,
          authority: opts.authority || 1
        });
      }
    }
  }
  return out.filter((c) => !isBlankOrUnknown(c.value));
}

function authorityRank(source) {
  const order = {
    official_about: 100,
    official_contact: 95,
    json_ld: 90,
    wikidata: 85,
    official_page: 80,
    structured_profile: 70,
    search_snippet: 50,
    press: 40,
    text: 30,
    none: 0
  };
  return order[source] || 20;
}

function pickConsensus(candidates, { requireExplicit = false } = {}) {
  if (!candidates.length) return null;
  const filtered = requireExplicit ? candidates.filter((c) => c.explicit !== false || c.source === 'wikidata' || c.source === 'json_ld') : candidates;
  const pool = filtered.length ? filtered : candidates;

  // Group by normalized value
  const byValue = new Map();
  for (const c of pool) {
    const key = String(c.value).toLowerCase();
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(c);
  }

  // Conflict if top two values both have strong authority
  const ranked = [...byValue.entries()]
    .map(([key, list]) => {
      const bestAuth = Math.max(...list.map((c) => (c.authority || 1) * 10 + authorityRank(c.source)));
      const sources = new Set(list.map((c) => c.source));
      return { key, list, bestAuth, sourceCount: sources.size, value: list[0].value };
    })
    .sort((a, b) => b.bestAuth - a.bestAuth || b.sourceCount - a.sourceCount);

  if (ranked.length >= 2) {
    const a = ranked[0];
    const b = ranked[1];
    const aOfficial = a.list.some((c) => /official|wikidata|json_ld/i.test(c.source));
    const bOfficial = b.list.some((c) => /official|wikidata|json_ld/i.test(c.source));
    if (aOfficial && bOfficial && Math.abs(a.bestAuth - b.bestAuth) < 25) {
      return { conflict: true, values: [a.value, b.value], candidates: pool };
    }
    // Prefer official over search when both present
    if (!aOfficial && bOfficial) {
      return { conflict: false, chosen: b.list.sort((x, y) => authorityRank(y.source) - authorityRank(x.source))[0] };
    }
  }

  const chosenGroup = ranked[0];
  const chosen = chosenGroup.list.sort((x, y) => authorityRank(y.source) - authorityRank(x.source))[0];
  return { conflict: false, chosen, candidates: pool };
}

function confidenceFor(source, explicit) {
  if (/official|json_ld|wikidata/i.test(source) && explicit !== false) return 'high';
  if (/official|wikidata|structured/i.test(source)) return 'high';
  if (/search|press/i.test(source)) return explicit === false ? 'low' : 'medium';
  return 'low';
}

/**
 * Resolve headquarters for a resolved company identity.
 * deps: { fetchHtml(url), searchSnippets(query), fetchWikidataHq(name) }
 */
export async function resolveHeadquarters(companyName, domain, deps = {}) {
  if (!domain) return emptyField('identity_not_resolved');

  const candidates = [];
  const paths = [
    { path: '/about', source: 'official_about', authority: 5 },
    { path: '/about-us', source: 'official_about', authority: 5 },
    { path: '/company', source: 'official_about', authority: 4 },
    { path: '/contact', source: 'official_contact', authority: 5 },
    { path: '/contact-us', source: 'official_contact', authority: 5 },
    { path: '/locations', source: 'official_contact', authority: 4 },
    { path: '/', source: 'official_page', authority: 3 }
  ];

  if (typeof deps.fetchHtml === 'function') {
    for (const { path, source, authority } of paths) {
      try {
        const url = `https://${domain}${path}`;
        const html = await deps.fetchHtml(url);
        if (!html) continue;
        const text = htmlToText(html);
        const org = extractJsonLdOrganization(html);
        if (org?.address) {
          const addr = org.address;
          const city = addr.addressLocality || '';
          const region = addr.addressRegion || '';
          const country = addr.addressCountry || '';
          let raw = '';
          if (city && region) raw = `${city}, ${region}`;
          else if (city && country) raw = `${city}, ${country}`;
          const value = normalizeHqCandidate(raw);
          if (value) {
            candidates.push({
              value,
              evidence: `JSON-LD address: ${raw}`,
              explicit: true,
              source: 'json_ld',
              sourceUrl: url,
              authority: authority + 2
            });
          }
        }
        for (const c of extractHqFromText(text, { source, sourceUrl: url, authority })) {
          candidates.push(c);
        }
      } catch {
        /* path best-effort */
      }
    }
  }

  if (typeof deps.fetchWikidataHq === 'function') {
    try {
      const wiki = await deps.fetchWikidataHq(companyName);
      if (wiki?.location) {
        const value = normalizeHqCandidate(wiki.location);
        if (value) {
          candidates.push({
            value,
            evidence: wiki.evidence || `Wikidata P159: ${wiki.location}`,
            explicit: true,
            source: 'wikidata',
            sourceUrl: wiki.url || null,
            authority: 4
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (typeof deps.searchSnippets === 'function') {
    const queries = [
      `"${companyName}" headquarters`,
      `"${companyName}" headquartered in`,
      `"${companyName}" based in`,
      `site:${domain} contact`,
      `site:${domain} about`
    ];
    for (const q of queries) {
      try {
        const hits = await deps.searchSnippets(q);
        for (const h of hits || []) {
          const blob = `${h.title || ''} ${h.snippet || ''}`;
          for (const c of extractHqFromText(blob, { source: 'search_snippet', authority: 2, sourceUrl: h.url || null })) {
            candidates.push(c);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof deps.fetchWikipediaSummary === 'function') {
    try {
      const wiki = await deps.fetchWikipediaSummary(companyName);
      if (wiki?.extract) {
        for (const c of extractHqFromText(wiki.extract, {
          source: 'structured_profile',
          authority: 3,
          sourceUrl: wiki.url || null
        })) {
          candidates.push(c);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const decision = pickConsensus(candidates, { requireExplicit: true });
  if (!decision || decision.conflict) {
    return emptyField(decision?.conflict ? 'conflicting_sources' : 'no_reliable_hq', {
      evidence: decision?.values || candidates.slice(0, 3)
    });
  }
  if (!decision.chosen) return emptyField('no_reliable_hq');

  const conf = confidenceFor(decision.chosen.source, decision.chosen.explicit);
  if (conf === 'low') return emptyField('low_confidence_only', { evidence: decision.chosen.evidence });

  return fieldRecord(decision.chosen.value, decision.chosen.source, conf, {
    sourceType: decision.chosen.source,
    sourceUrl: decision.chosen.sourceUrl,
    method: 'hq_resolver',
    evidence: decision.chosen.evidence
  });
}

/**
 * Resolve founders — explicit founder language only.
 */
export async function resolveFounders(companyName, domain, deps = {}) {
  if (!domain) return emptyField('identity_not_resolved');

  const candidates = [];
  const paths = [
    { path: '/about', source: 'official_about', authority: 5 },
    { path: '/about-us', source: 'official_about', authority: 5 },
    { path: '/company', source: 'official_about', authority: 4 },
    { path: '/team', source: 'official_team', authority: 4 },
    { path: '/people', source: 'official_team', authority: 3 },
    { path: '/history', source: 'official_about', authority: 4 },
    { path: '/', source: 'official_page', authority: 2 }
  ];

  if (typeof deps.fetchHtml === 'function') {
    for (const { path, source, authority } of paths) {
      try {
        const url = `https://${domain}${path}`;
        const html = await deps.fetchHtml(url);
        if (!html) continue;
        const text = htmlToText(html);
        // Team pages: only accept explicit Founder labels (extractFoundersFromText handles this)
        for (const c of extractFoundersFromText(text, companyName, { source, sourceUrl: url, authority })) {
          candidates.push(c);
        }
        const org = extractJsonLdOrganization(html);
        if (org?.founder) {
          const founders = Array.isArray(org.founder) ? org.founder : [org.founder];
          const names = founders.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
          const value = normalizeFounders(names.join('; '));
          if (!isBlankOrUnknown(value)) {
            candidates.push({
              value,
              evidence: `JSON-LD founder: ${value}`,
              source: 'json_ld',
              sourceUrl: url,
              authority: authority + 2
            });
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof deps.fetchWikidataFounders === 'function') {
    try {
      const wiki = await deps.fetchWikidataFounders(companyName);
      if (wiki?.founders) {
        const value = normalizeFounders(wiki.founders);
        if (!isBlankOrUnknown(value)) {
          candidates.push({
            value,
            evidence: wiki.evidence || `Wikidata P112: ${value}`,
            source: 'wikidata',
            sourceUrl: wiki.url || null,
            authority: 4
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (typeof deps.searchSnippets === 'function') {
    const queries = [
      `"${companyName}" founded by`,
      `"${companyName}" co-founded by`,
      `"${companyName}" founder`,
      `"${companyName}" co-founder`
    ];
    for (const q of queries) {
      try {
        const hits = await deps.searchSnippets(q);
        for (const h of hits || []) {
          const blob = `${h.title || ''} ${h.snippet || ''}`;
          if (EXEC_NOT_FOUNDER.test(blob) && !/\bfounder|founded|co-founded\b/i.test(blob)) continue;
          for (const c of extractFoundersFromText(blob, companyName, { source: 'search_snippet', authority: 2, sourceUrl: h.url || null })) {
            candidates.push(c);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof deps.fetchWikipediaSummary === 'function') {
    try {
      const wiki = await deps.fetchWikipediaSummary(companyName);
      if (wiki?.extract) {
        for (const c of extractFoundersFromText(wiki.extract, companyName, {
          source: 'structured_profile',
          authority: 3,
          sourceUrl: wiki.url || null
        })) {
          candidates.push(c);
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!candidates.length) return emptyField('no_explicit_founder_evidence');

  // Merge founder name sets from high-authority sources
  const bySourceTier = candidates.sort((a, b) => authorityRank(b.source) - authorityRank(a.source));
  const nameScores = new Map();
  for (const c of bySourceTier) {
    for (const name of String(c.value).split(/\s*;\s*/)) {
      const key = name.toLowerCase();
      if (!key || key.split(/\s+/).length < 2) continue;
      const prev = nameScores.get(key) || { name, score: 0, evidence: c.evidence, source: c.source, sourceUrl: c.sourceUrl };
      prev.score += authorityRank(c.source) + (c.authority || 1) * 5;
      if (authorityRank(c.source) >= authorityRank(prev.source)) {
        prev.source = c.source;
        prev.sourceUrl = c.sourceUrl;
        prev.evidence = c.evidence;
      }
      nameScores.set(key, prev);
    }
  }

  const topNames = [...nameScores.values()].filter((n) => n.score >= 50).sort((a, b) => b.score - a.score);
  if (!topNames.length) return emptyField('founder_evidence_too_weak');

  // If Wikidata and page sources disagree with zero name overlap, prefer Wikidata P112
  const wikiCand = candidates.filter((c) => c.source === 'wikidata');
  const pageCand = candidates.filter((c) => /official|json_ld/i.test(c.source));
  if (wikiCand.length && pageCand.length) {
    const wikiSet = new Set(
      wikiCand.flatMap((c) =>
        String(c.value)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/\s*;\s*/)
      )
    );
    const pageSet = new Set(
      pageCand.flatMap((c) =>
        String(c.value)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .split(/\s*;\s*/)
      )
    );
    const overlap = [...wikiSet].some((n) => [...pageSet].some((p) => p.includes(n) || n.includes(p)));
    if (!overlap) {
      const value = normalizeFounders(wikiCand.map((c) => c.value).join('; '));
      if (!isBlankOrUnknown(value)) {
        return fieldRecord(value, 'wikidata', 'high', {
          sourceType: 'wikidata',
          sourceUrl: wikiCand[0].sourceUrl,
          method: 'founder_resolver_wikidata_preferred_on_conflict',
          evidence: wikiCand[0].evidence
        });
      }
    }
  }

  const value = normalizeFounders(topNames.map((n) => n.name).join('; '));
  if (isBlankOrUnknown(value)) return emptyField('founder_normalize_failed');

  const best = topNames[0];
  const conf = confidenceFor(best.source, true);
  if (conf === 'low') return emptyField('low_confidence_only', { evidence: best.evidence });

  return fieldRecord(value, best.source, conf, {
    sourceType: best.source,
    sourceUrl: best.sourceUrl,
    method: 'founder_resolver',
    evidence: best.evidence
  });
}

/**
 * Resolve headcount as a bucket range.
 */
export async function resolveHeadcount(companyName, domain, deps = {}) {
  if (!domain) return emptyField('identity_not_resolved');

  const candidates = [];

  if (typeof deps.fetchHtml === 'function') {
    for (const path of ['/', '/about', '/about-us', '/company']) {
      try {
        const url = `https://${domain}${path}`;
        const html = await deps.fetchHtml(url);
        if (!html) continue;
        const text = htmlToText(html);
        for (const c of extractHeadcountFromText(text, { source: 'official_page', authority: 3, sourceUrl: url, rejectTeamPage: /\/team/i.test(path) })) {
          candidates.push(c);
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (typeof deps.fetchWikidataEmployees === 'function') {
    try {
      const wiki = await deps.fetchWikidataEmployees(companyName);
      if (wiki?.employees != null) {
        const value = normalizeHeadcount(String(wiki.employees));
        if (!isBlankOrUnknown(value)) {
          candidates.push({
            value,
            evidence: wiki.evidence || `Wikidata P1128: ${wiki.employees}`,
            source: 'wikidata',
            sourceUrl: wiki.url || null,
            authority: 4
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (typeof deps.searchSnippets === 'function') {
    const queries = [
      `"${companyName}" employees`,
      `"${companyName}" employee count`,
      `"${companyName}" company size`,
      `"${companyName}" LinkedIn employees`
    ];
    for (const q of queries) {
      try {
        const hits = await deps.searchSnippets(q);
        for (const h of hits || []) {
          const blob = `${h.title || ''} ${h.snippet || ''}`;
          for (const c of extractHeadcountFromText(blob, { source: 'search_snippet', authority: 2, sourceUrl: h.url || null })) {
            candidates.push(c);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  const decision = pickConsensus(candidates);
  if (!decision || decision.conflict) {
    return emptyField(decision?.conflict ? 'conflicting_ranges' : 'no_reliable_headcount', {
      evidence: decision?.values || candidates.slice(0, 3)
    });
  }
  if (!decision.chosen) return emptyField('no_reliable_headcount');

  const conf = confidenceFor(decision.chosen.source, true);
  // Search-only headcount stays medium; never emit low
  if (conf === 'low') return emptyField('low_confidence_only', { evidence: decision.chosen.evidence });

  const bucketed = normalizeHeadcount(decision.chosen.value);
  if (isBlankOrUnknown(bucketed) || !HEADCOUNT_BUCKETS.includes(bucketed)) {
    return emptyField('unbucketable_headcount', { evidence: decision.chosen.evidence });
  }

  return fieldRecord(bucketed, decision.chosen.source, conf, {
    sourceType: decision.chosen.source,
    sourceUrl: decision.chosen.sourceUrl,
    method: 'headcount_resolver',
    evidence: decision.chosen.evidence
  });
}

/**
 * Enrich all three fields for a resolved identity.
 * Optional deps.pdl / deps.enablePdl apply People Data Labs only for Unknown fields.
 */
export async function enrichResolvedFields(companyName, domain, deps = {}) {
  if (!domain) {
    return {
      location: emptyField('identity_not_resolved'),
      founders: emptyField('identity_not_resolved'),
      headcount: emptyField('identity_not_resolved')
    };
  }
  const [location, founders, headcount] = await Promise.all([
    resolveHeadquarters(companyName, domain, deps),
    resolveFounders(companyName, domain, deps),
    resolveHeadcount(companyName, domain, deps)
  ]);
  const publicFields = { location, founders, headcount };

  if (!deps.enablePdl && !deps.pdl) return publicFields;

  try {
    const { enrichWithPdlFallback } = await import('./pdl-fallback.mjs');
    const merged = await enrichWithPdlFallback(companyName, domain, publicFields, {
      ...(deps.pdl || {}),
      enableFounderSearch: deps.pdl?.enableFounderSearch !== false,
      stats: deps.pdlStats
    });
    return {
      location: merged.location,
      founders: merged.founders,
      headcount: merged.headcount,
      pdl: merged.pdl || null
    };
  } catch {
    // PDL outage must not break public enrichment
    return { ...publicFields, pdl: { pdlMatchStatus: 'error', reason: 'pdl_fallback_exception' } };
  }
}

/** Equivalence helpers for eval */
export function locationEquivalent(got, expected, alts = []) {
  if (isBlankOrUnknown(got)) return false;
  const targets = [expected, ...(alts || [])].filter(Boolean).map((t) => normalizeLocation(t).toLowerCase());
  const g = normalizeLocation(got).toLowerCase();
  return targets.some((t) => g === t || g.includes(t) || t.includes(g));
}

function foldPersonName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '');
}

/** First + last token — ignore middle names / initials */
export function personNameKey(s) {
  const parts = foldPersonName(s)
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

export function parseFounderNameKeys(s) {
  if (isBlankOrUnknown(s)) return [];
  return normalizeFounders(s)
    .split(/\s*;\s*/)
    .filter(Boolean)
    .map(personNameKey)
    .filter(Boolean);
}

function namesMatch(a, b) {
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Classify founder match against ground truth.
 * Outcomes: exact_complete | correct_partial | incorrect | unknown | not_applicable
 *
 * Completeness uses the longest expected/alt set as the canonical full roster when
 * alts are supersets; otherwise expectedFounders is the completeness target.
 */
export function classifyFounderMatch(got, expected, alts = [], { foundersApplicable = true } = {}) {
  if (foundersApplicable === false || expected == null) {
    if (isBlankOrUnknown(got)) {
      return {
        outcome: 'not_applicable',
        gotKeys: [],
        expectedKeys: [],
        matchedKeys: [],
        missingKeys: [],
        extraKeys: [],
        personPrecision: null,
        completeness: null
      };
    }
    return {
      outcome: 'incorrect',
      gotKeys: parseFounderNameKeys(got),
      expectedKeys: [],
      matchedKeys: [],
      missingKeys: [],
      extraKeys: parseFounderNameKeys(got),
      personPrecision: 0,
      completeness: null
    };
  }

  if (isBlankOrUnknown(got)) {
    const expectedKeys = parseFounderNameKeys(expected);
    return {
      outcome: 'unknown',
      gotKeys: [],
      expectedKeys,
      matchedKeys: [],
      missingKeys: expectedKeys,
      extraKeys: [],
      personPrecision: null,
      completeness: 0
    };
  }

  const gotKeys = parseFounderNameKeys(got);
  const optionSets = [expected, ...(alts || [])]
    .filter(Boolean)
    .map(parseFounderNameKeys)
    .filter((arr) => arr.length > 0);
  // Canonical completeness target: longest listed set (full roster)
  const completenessTarget = optionSets.reduce((best, cur) => (cur.length > best.length ? cur : best), optionSets[0] || []);

  // Exact only against the canonical full roster (or same-size alternate enumerations)
  const fullSets = optionSets.filter((s) => s.length === completenessTarget.length);
  const isExactAgainst = (exp) => {
    if (gotKeys.length !== exp.length) return false;
    const unused = [...exp];
    for (const g of gotKeys) {
      const idx = unused.findIndex((e) => namesMatch(g, e));
      if (idx < 0) return false;
      unused.splice(idx, 1);
    }
    return unused.length === 0;
  };
  const exact = fullSets.some(isExactAgainst);

  const matchedKeys = gotKeys.filter((g) => completenessTarget.some((e) => namesMatch(g, e)));
  const unionAllowed = [...new Set(optionSets.flat())];
  const validGot = gotKeys.filter((g) => unionAllowed.some((e) => namesMatch(g, e)));
  const invalidGot = gotKeys.filter((g) => !unionAllowed.some((e) => namesMatch(g, e)));

  const personPrecision = gotKeys.length ? Math.round((validGot.length / gotKeys.length) * 1000) / 10 : null;
  const completeness =
    completenessTarget.length > 0
      ? Math.round((matchedKeys.length / completenessTarget.length) * 1000) / 10
      : null;

  const missingKeys = completenessTarget.filter((e) => !gotKeys.some((g) => namesMatch(g, e)));

  if (invalidGot.length) {
    return {
      outcome: 'incorrect',
      gotKeys,
      expectedKeys: completenessTarget,
      matchedKeys: validGot,
      missingKeys,
      extraKeys: invalidGot,
      personPrecision,
      completeness
    };
  }

  if (exact) {
    return {
      outcome: 'exact_complete',
      gotKeys,
      expectedKeys: completenessTarget,
      matchedKeys: validGot,
      missingKeys: [],
      extraKeys: [],
      personPrecision: 100,
      completeness: 100
    };
  }

  // Partial: every returned name is valid, but set is incomplete vs canonical roster
  if (validGot.length && missingKeys.length) {
    return {
      outcome: 'correct_partial',
      gotKeys,
      expectedKeys: completenessTarget,
      matchedKeys: validGot,
      missingKeys,
      extraKeys: [],
      personPrecision,
      completeness
    };
  }

  if (validGot.length && !missingKeys.length) {
    return {
      outcome: 'exact_complete',
      gotKeys,
      expectedKeys: completenessTarget,
      matchedKeys: validGot,
      missingKeys: [],
      extraKeys: [],
      personPrecision: 100,
      completeness: 100
    };
  }

  return {
    outcome: 'incorrect',
    gotKeys,
    expectedKeys: completenessTarget,
    matchedKeys: validGot,
    missingKeys,
    extraKeys: invalidGot,
    personPrecision,
    completeness
  };
}

/** True if founder sets are exactly equivalent (order-insensitive). Partial subsets are false. */
export function foundersEquivalent(got, expected, alts = []) {
  const c = classifyFounderMatch(got, expected, alts);
  return c.outcome === 'exact_complete';
}

/** True if every returned name is valid (exact or partial). */
export function foundersPersonAccurate(got, expected, alts = []) {
  const c = classifyFounderMatch(got, expected, alts);
  return c.outcome === 'exact_complete' || c.outcome === 'correct_partial';
}

export function headcountEquivalent(got, expected, alts = []) {
  if (isBlankOrUnknown(got)) return false;
  const g = normalizeHeadcount(got);
  const targets = [expected, ...(alts || [])].filter(Boolean).map((t) => normalizeHeadcount(t));
  return targets.includes(g);
}

export { UNKNOWN, isBlankOrUnknown, normalizeLocation, normalizeHeadcount, normalizeFounders, fieldRecord };
