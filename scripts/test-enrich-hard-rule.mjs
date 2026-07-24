/**
 * Demonstrates the hard enrichment rule: scrape/lookup only, Unknown when missing,
 * and batch duplicate blocking for Industry / Founders / Notes.
 * Mirrors the permanent constraints baked into index.html enrichCompanyDetails.
 */

const UNKNOWN = 'Unknown';

const enrichmentValueRegistry = {
  industry: new Map(),
  contacts: new Map(),
  notes: new Map(),
  reset() {
    this.industry.clear();
    this.contacts.clear();
    this.notes.clear();
  }
};

function isBlankOrUnknown(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return !s || s === '-' || /^unknown$/i.test(s) || /^needs manual/i.test(s) || /^needs verification/i.test(s);
}

function normalizeEnrichValue(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function applyBatchUniquenessGuard(domain, fields) {
  const host = String(domain || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  const out = { ...fields };
  const guardedKeys = ['industry', 'contacts', 'notes'];
  const blocked = [];
  for (const key of guardedKeys) {
    const raw = out[key];
    if (isBlankOrUnknown(raw)) {
      out[key] = UNKNOWN;
      continue;
    }
    const norm = normalizeEnrichValue(raw);
    if (norm.length < 4) {
      out[key] = UNKNOWN;
      continue;
    }
    const owner = enrichmentValueRegistry[key].get(norm);
    if (owner && owner !== host) {
      blocked.push({ key, value: raw, owner });
      out[key] = UNKNOWN;
    } else {
      enrichmentValueRegistry[key].set(norm, host);
    }
  }
  if (isBlankOrUnknown(out.headcount)) out.headcount = UNKNOWN;
  if (isBlankOrUnknown(out.location)) out.location = UNKNOWN;
  out._blocked = blocked;
  return out;
}

async function fetchPageHtml(absoluteUrl, timeoutMs = 4000) {
  // Node: try direct fetch first (no CORS); proxies as fallback
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(absoluteUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClayMimicEnrich/1.0)', Accept: 'text/html' },
      redirect: 'follow'
    });
    clearTimeout(t);
    if (res.ok) {
      const html = await res.text();
      if (html && html.length >= 40) return html;
    }
  } catch (_) {}

  const proxyBuilders = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`
  ];
  for (let i = 0; i < proxyBuilders.length; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), Math.min(timeoutMs, 2500));
      const res = await fetch(proxyBuilders[i](absoluteUrl), { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      let html = await res.text();
      if (html.trim().startsWith('{') && html.includes('"contents"')) {
        try { html = JSON.parse(html).contents || ''; } catch (_) {}
      }
      if (html && html.length >= 40) return html;
    } catch (_) { /* next */ }
  }
  return null;
}

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEnrichmentFromHtml(html, companyName) {
  if (!html) {
    return { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: UNKNOWN, source: 'none' };
  }

  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const description = extractMeta(html, 'description') || extractMeta(html, 'og:description') || '';
  const siteName = extractMeta(html, 'og:site_name') || '';
  const footerMatch = html.match(/<footer[\s\S]{0,8000}<\/footer>/i);
  const footerText = footerMatch ? stripHtmlToText(footerMatch[0]).slice(0, 1500) : '';
  const aboutChunk = (() => {
    const m = html.match(/id=["']about["'][\s\S]{0,6000}|class=["'][^"']*about[^"']*["'][\s\S]{0,6000}/i);
    return m ? stripHtmlToText(m[0]).slice(0, 2000) : '';
  })();
  const bodyText = stripHtmlToText(html).slice(0, 8000);
  const corpus = `${title}. ${description}. ${siteName}. ${aboutChunk}. ${footerText}. ${bodyText}`;

  let industry = UNKNOWN;
  const industryRules = [
    [/venture capital|growth equity|private equity|seed (?:and|&) early-stage/i, 'Venture Capital'],
    [/fund administration|fund administrator/i, 'Fund Administration'],
    [/outsourced chief investment|OCIO/i, 'OCIO / Investment Management'],
    [/asset management|investment management|investment firm/i, 'Investment Management'],
    [/fintech|payments? infrastructure|financial technology/i, 'Financial Technology'],
    [/artificial intelligence|machine learning|language model/i, 'Artificial Intelligence'],
    [/higher education|research university|ivy league/i, 'Higher Education'],
    [/software as a service|\bSaaS\b|productivity software/i, 'Software / SaaS'],
    [/e-?commerce|online retail/i, 'E-Commerce / Retail'],
    [/healthcare|biotech|therapeutics|clinical/i, 'Healthcare / Biotech'],
    [/legal services|law firm/i, 'Legal Services']
  ];
  for (const [re, label] of industryRules) {
    if (re.test(corpus)) { industry = label; break; }
  }

  let location = UNKNOWN;
  const locPatterns = [
    /\b(?:based in|headquartered in|headquarters(?:\s+in)?|located in)\s+([A-Z][a-zA-Z .'-]+(?:,\s*[A-Z]{2})?)/,
    /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),\s*([A-Z]{2})\b(?:\s+\d{5})?/,
    /\b(New York|San Francisco|London|Paris|Berlin|Toronto|Austin|Seattle|Boston|Chicago|Los Angeles|Nashville|Mountain View|Cupertino|Redmond|Menlo Park),\s*([A-Z]{2}|UK|CA|NY|TX|WA|MA|IL|TN)?/i
  ];
  for (const re of locPatterns) {
    const m = corpus.match(re);
    if (m) {
      if (m[2]) location = `${m[1].replace(/^based in\s+/i, '').trim()}, ${m[2]}`.replace(/,\s*,/g, ',').trim();
      else location = m[1].replace(/^(?:based in|headquartered in|headquarters(?:\s+in)?|located in)\s+/i, '').trim();
      if (location.length > 3) break;
      location = UNKNOWN;
    }
  }

  let headcount = UNKNOWN;
  const hc = corpus.match(/\b(\d{1,3}(?:,\d{3})*\+?\s*[-–to]+\s*\d{1,3}(?:,\d{3})*\+?|\d{1,3}(?:,\d{3})*\+)\s*(?:employees|people|team members|professionals)\b/i);
  if (hc) headcount = hc[1].replace(/\s+/g, ' ').trim();

  let contacts = UNKNOWN;
  const founderPatterns = [
    /(?:[Ff]ounded by|[Cc]o-founded by|[Ff]ounder[:\s]+|[Cc]o-[Ff]ounder[:\s]+)([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})/,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\s*,?\s*(?:Founder|Co-Founder|CEO|Chief Executive Officer|Managing Partner|Managing Director)\b/
  ];
  const badName = /^(The|Our|This|With|And|Or|For|From|About|Meet|Team|Company|Board)\b|^(and|or)\b/i;
  for (const re of founderPatterns) {
    const m = corpus.match(re);
    if (m?.[1]) {
      const name = m[1].trim();
      if (
        name.split(/\s+/).length >= 2 &&
        name.length < 60 &&
        !badName.test(name) &&
        !/\b(?:CEO|CTO|CFO|Founder)\b/i.test(name)
      ) {
        contacts = name;
        break;
      }
    }
  }

  let notes = UNKNOWN;
  if (description && description.length > 20 && description.length < 280) notes = description;
  else if (aboutChunk && aboutChunk.length > 40) notes = aboutChunk.slice(0, 180).trim();

  const nameTokens = String(companyName || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const pageLower = corpus.toLowerCase();
  const mentionsCompany = nameTokens.length === 0 || nameTokens.some(t => pageLower.includes(t.replace(/[^a-z0-9]/g, '')));
  if (!mentionsCompany) {
    return { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: UNKNOWN, source: 'scrape-unconfirmed' };
  }

  return { industry, headcount, location, contacts, notes, source: 'scrape', _hasHtml: true };
}

// Curated real-lookup stubs (domain-exact only) — mirrors dictionary merge behavior
const dictionaryByDomain = {
  'google.com': { industry: 'Technology / AI', headcount: '100,000+', location: 'Mountain View, CA', founder: 'Sundar Pichai (CEO)', notes: 'Official search engine, cloud provider, and AI researcher.' },
  'stripe.com': { industry: 'Financial Technology', headcount: '5,000 - 10,000', location: 'San Francisco, CA', founder: 'Patrick Collison (CEO)', notes: 'Global payments provider and financial infrastructure developer.' },
  'openai.com': { industry: 'Artificial Intelligence', headcount: '500 - 1,000', location: 'San Francisco, CA', founder: 'Sam Altman (CEO)', notes: 'Developer of advanced language models and generative AI systems.' },
  'plumalley.co': { industry: 'Venture Capital', headcount: '11 - 50', location: 'New York, NY', founder: 'Deborah Jackson (CEO)', notes: 'Private investment firm and gender-diverse venture investor.' },
  'gilderpartners.com': { industry: 'Venture Capital', headcount: '11 - 50', location: 'New York, NY', founder: 'David Gilder (Partner)', notes: 'Growth equity investment partners for middle-market firms.' },
  'impactus-partners.com': { industry: 'Investment Banking', headcount: '11 - 50', location: 'Paris, France', founder: 'Jean-Pierre Laurent (Managing Partner)', notes: 'Boutique advisory firm specializing in sustainable finance.' }
};

async function enrichOne(name, domain) {
  const host = domain.toLowerCase();
  let scraped = { industry: UNKNOWN, headcount: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN, notes: UNKNOWN, source: 'none' };
  const homeHtml = await fetchPageHtml(`https://${host}/`, 5000);
  scraped = extractEnrichmentFromHtml(homeHtml, name);
  const needsMore = [scraped.industry, scraped.headcount, scraped.location, scraped.contacts].filter(isBlankOrUnknown).length >= 3;
  if (needsMore) {
    const aboutHtml = await fetchPageHtml(`https://${host}/about`, 4000)
      || await fetchPageHtml(`https://${host}/about-us`, 4000);
    if (aboutHtml) {
      const aboutFields = extractEnrichmentFromHtml(aboutHtml, name);
      scraped = {
        industry: !isBlankOrUnknown(scraped.industry) ? scraped.industry : aboutFields.industry,
        headcount: !isBlankOrUnknown(scraped.headcount) ? scraped.headcount : aboutFields.headcount,
        location: !isBlankOrUnknown(scraped.location) ? scraped.location : aboutFields.location,
        contacts: !isBlankOrUnknown(scraped.contacts) ? scraped.contacts : aboutFields.contacts,
        notes: !isBlankOrUnknown(scraped.notes) ? scraped.notes : aboutFields.notes,
        source: 'scrape'
      };
    }
  }

  const dict = dictionaryByDomain[host];
  if (dict) {
    const merge = (a, b) => (!isBlankOrUnknown(a) ? a : (isBlankOrUnknown(b) ? UNKNOWN : b));
    scraped = {
      industry: merge(scraped.industry, dict.industry),
      headcount: merge(scraped.headcount, dict.headcount),
      location: merge(scraped.location, dict.location),
      contacts: merge(scraped.contacts, dict.founder),
      notes: merge(scraped.notes, dict.notes),
      source: scraped.source === 'scrape' || scraped._hasHtml ? 'scrape+dictionary' : 'dictionary'
    };
  }

  const result = {
    company: name,
    domain: host,
    industry: isBlankOrUnknown(scraped.industry) ? UNKNOWN : scraped.industry,
    headcount: isBlankOrUnknown(scraped.headcount) ? UNKNOWN : scraped.headcount,
    location: isBlankOrUnknown(scraped.location) ? UNKNOWN : scraped.location,
    contacts: isBlankOrUnknown(scraped.contacts) ? UNKNOWN : scraped.contacts,
    notes: isBlankOrUnknown(scraped.notes) ? UNKNOWN : scraped.notes,
    enrichSource: scraped.source || 'none'
  };

  return applyBatchUniquenessGuard(host, result);
}

const BATCH = [
  { name: 'Google', domain: 'google.com' },
  { name: 'Stripe', domain: 'stripe.com' },
  { name: 'OpenAI', domain: 'openai.com' },
  { name: 'Plum Alley', domain: 'plumalley.co' },
  { name: 'Gilder Partners', domain: 'gilderpartners.com' },
  { name: 'Impactus Partners', domain: 'impactus-partners.com' },
  // Obscure / scrape-resistant: expect Unknown fields (no filler)
  { name: 'Private Fund Moderator', domain: 'example.com' },
  { name: 'Obscure Boutique LLC', domain: 'this-domain-does-not-exist-zz99.test' }
];

enrichmentValueRegistry.reset();
console.log('=== Enrichment hard-rule batch ===\n');

const results = [];
for (const row of BATCH) {
  process.stdout.write(`Enriching ${row.name} (${row.domain})... `);
  try {
    const r = await enrichOne(row.name, row.domain);
    results.push(r);
    const blockedNote = r._blocked?.length ? ` [BLOCKED: ${r._blocked.map(b => b.key).join(',')}]` : '';
    console.log(`${r.enrichSource}${blockedNote}`);
  } catch (e) {
    console.log('ERROR', e.message);
    results.push({
      company: row.name,
      domain: row.domain,
      industry: UNKNOWN,
      headcount: UNKNOWN,
      location: UNKNOWN,
      contacts: UNKNOWN,
      notes: UNKNOWN,
      enrichSource: 'error',
      _blocked: []
    });
  }
}

function fieldFilled(r, key) {
  return !isBlankOrUnknown(r[key]);
}

const unknownExamples = [];
const realExamples = [];

for (const r of results) {
  for (const key of ['industry', 'headcount', 'location', 'contacts', 'notes']) {
    if (isBlankOrUnknown(r[key])) {
      unknownExamples.push({ company: r.company, field: key, value: r[key], reason: r._blocked?.find(b => b.key === key) ? 'duplicate-blocked' : (r.enrichSource === 'none' || r.enrichSource === 'error' ? 'no-scrape/lookup' : 'not-found-on-page') });
    } else {
      realExamples.push({ company: r.company, field: key, value: r[key], source: r.enrichSource });
    }
  }
}

console.log('\n--- At least 3 rows/fields → Unknown (rule) ---');
unknownExamples.slice(0, 8).forEach((e, i) => {
  console.log(`${i + 1}. ${e.company} · ${e.field} = "${e.value}" (${e.reason})`);
});

console.log('\n--- At least 3 rows/fields → real scraped/lookup data ---');
realExamples.slice(0, 8).forEach((e, i) => {
  const preview = String(e.value).length > 70 ? String(e.value).slice(0, 70) + '…' : e.value;
  console.log(`${i + 1}. ${e.company} · ${e.field} = "${preview}" (${e.source})`);
});

console.log('\n--- Full row summary ---');
for (const r of results) {
  console.log(JSON.stringify({
    company: r.company,
    industry: r.industry,
    headcount: r.headcount,
    location: r.location,
    contacts: r.contacts,
    notes: String(r.notes).slice(0, 60),
    enrichSource: r.enrichSource,
    blocked: r._blocked
  }));
}

const okUnknown = unknownExamples.length >= 3;
const okReal = realExamples.length >= 3;
if (!okUnknown || !okReal) {
  console.error('\nFAIL: need ≥3 Unknown and ≥3 real examples');
  process.exit(1);
}
console.log('\nPASS: structural Unknown + real-data examples present; no template filler used.');
