// Website resolution + enrichment with search-backed verification.
// Prefer real search candidates + confidence checks over blind LLM-style guesses.

const companyDictionary = {
  google: {
    domain: "google.com",
    industry: "Technology / AI",
    headcount: "100,000+",
    location: "Mountain View, CA",
    notes: "Official search engine, cloud provider, and AI researcher."
  },
  apple: {
    domain: "apple.com",
    industry: "Consumer Electronics",
    headcount: "100,000+",
    location: "Cupertino, CA",
    notes: "Designer and manufacturer of consumer hardware and software."
  },
  microsoft: {
    domain: "microsoft.com",
    industry: "Software & Cloud",
    headcount: "100,000+",
    location: "Redmond, WA",
    notes: "Global provider of operating systems, productivity software, and cloud."
  },
  notion: {
    domain: "notion.so",
    industry: "Software / Productivity",
    headcount: "500 - 1,000",
    location: "San Francisco, CA",
    notes: "Serene workspace and documentation utility."
  },
  stripe: {
    domain: "stripe.com",
    industry: "Financial Technology",
    headcount: "5,000 - 10,000",
    location: "San Francisco, CA",
    notes: "Global payments provider and financial infrastructure developer."
  },
  openai: {
    domain: "openai.com",
    industry: "Artificial Intelligence",
    headcount: "500 - 1,000",
    location: "San Francisco, CA",
    notes: "Developer of advanced language models and generative AI systems."
  },
  linkedin: {
    domain: "linkedin.com",
    industry: "Professional Networks",
    headcount: "10,000+",
    location: "Sunnyvale, CA",
    notes: "World's largest professional networking platform."
  },
  cornell: {
    domain: "cornell.edu",
    industry: "Higher Education",
    headcount: "10,000+",
    location: "Ithaca, NY",
    notes: "Ivy League research university and educational center."
  },
  "cornell university": {
    domain: "cornell.edu",
    industry: "Higher Education",
    headcount: "10,000+",
    location: "Ithaca, NY",
    notes: "Ivy League research university and educational center."
  },
  "impactus partners": {
    domain: "impactus-partners.com",
    industry: "Investment Banking",
    headcount: "11 - 50",
    location: "Paris, France",
    notes: "Boutique advisory firm specializing in sustainable finance."
  },
  "gilder partners": {
    domain: "gilderpartners.com",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Growth equity investment partners for middle-market firms."
  },
  "gilder partners for growth": {
    domain: "gilderpartners.com",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Growth equity investment partners for middle-market firms."
  },
  "plum alley": {
    domain: "plumalley.co",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Private investment firm and gender-diverse venture investor."
  },
  "plum alley ventures": {
    domain: "plumalley.co",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Private investment firm and gender-diverse venture investor."
  },
  clay: {
    domain: "clay.com",
    industry: "SaaS / Lead Gen",
    headcount: "100 - 250",
    location: "New York, NY",
    notes: "Data enrichment and outbound orchestration software."
  },
  amazon: {
    domain: "amazon.com",
    industry: "E-Commerce / Cloud",
    headcount: "1,000,000+",
    location: "Seattle, WA",
    notes: "Global online retail platform and cloud infrastructure provider."
  },
  meta: {
    domain: "meta.com",
    industry: "Social Media / VR",
    headcount: "50,000+",
    location: "Menlo Park, CA",
    notes: "Developer of social networking apps and metaverse technologies."
  },
  netflix: {
    domain: "netflix.com",
    industry: "Entertainment",
    headcount: "10,000+",
    location: "Los Gatos, CA",
    notes: "Global media-streaming and video production company."
  },
  tesla: {
    domain: "tesla.com",
    industry: "Automotive / Energy",
    headcount: "100,000+",
    location: "Austin, TX",
    notes: "Manufacturer of electric vehicles and clean energy products."
  }
};

const JUNK_NAMES = new Set(["test", "asdf", "company", "xyz", "hello", "unknown", "n/a", "na", "none"]);
const COMMON_TLDS = new Set(["com", "co", "io", "net", "org", "edu", "gov", "ai", "me", "us", "ca", "uk", "so", "app", "dev"]);
const AMBIGUOUS_NAMES = new Set([
  "unity", "oracle", "pulse", "apex", "summit", "vertex", "nova", "atlas", "pioneer",
  "horizon", "beacon", "spark", "forge", "harbor", "bridge", "delta", "alpha", "prime"
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[,.]?\s*\b(inc|llc|co|corp|corporation|ltd|limited|gmbh|sa|plc|pvt)\b\.?/gi, "")
    .replace(/^the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(name) {
  return cleanName(name).replace(/[^a-z0-9]/g, "");
}

function normalizeDomain(domain) {
  if (!domain) return "";
  return String(domain)
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, "")
    .split("/")[0]
    .split("?")[0];
}

function domainBase(domain) {
  const host = normalizeDomain(domain);
  const parts = host.split(".");
  if (parts.length < 2) return host.replace(/[^a-z0-9]/g, "");
  // e.g. plumalley.co → plumalley; news.ycombinator.com → ycombinator (best-effort)
  if (parts.length > 2 && !COMMON_TLDS.has(parts[parts.length - 2])) {
    return parts[parts.length - 2].replace(/[^a-z0-9]/g, "");
  }
  return parts[0].replace(/[^a-z0-9]/g, "");
}

function isPlaceholder(value) {
  if (value == null) return true;
  const v = String(value).trim();
  return !v || v === "-" || /^unknown$/i.test(v);
}

function buildSearchQueries(companyName, context = {}) {
  const cleaned = cleanName(companyName);
  const queries = [];
  const pushUnique = (q) => {
    const trimmed = String(q || "").trim();
    if (!trimmed) return;
    if (!queries.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      queries.push(trimmed);
    }
  };

  pushUnique(cleaned);
  pushUnique(companyName);
  pushUnique(`${cleaned} official website`);

  const industry = !isPlaceholder(context.industry) ? String(context.industry).trim() : "";
  const location = !isPlaceholder(context.location) ? String(context.location).trim() : "";

  if (industry) pushUnique(`${cleaned} ${industry}`);
  if (location) pushUnique(`${cleaned} ${location}`);
  if (industry && location) pushUnique(`${cleaned} ${industry} ${location}`);

  return queries;
}

function isAmbiguousCompanyName(companyName) {
  const cleaned = cleanName(companyName);
  const key = normalizeKey(companyName);
  if (!key || key.length <= 3) return true;
  if (AMBIGUOUS_NAMES.has(cleaned) || AMBIGUOUS_NAMES.has(key)) return true;
  // Single common word with no distinguishing tokens
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  return tokens.length === 1 && tokens[0].length <= 6;
}

function scoreDomainAgainstCompany(domain, companyName, suggestionName = "") {
  const query = normalizeKey(companyName);
  const base = domainBase(domain);
  const host = normalizeDomain(domain);
  const tld = host.split(".").pop() || "";
  const suggested = normalizeKey(suggestionName);

  if (!query || !base) return 0;

  let score = 0;

  if (base === query) score += 100;
  else if (query.includes(base) || base.includes(query)) {
    score += 50;
    score -= Math.min(30, Math.abs(base.length - query.length) * 2);
  } else if (suggested && (suggested.includes(query) || query.includes(suggested))) {
    score += 40;
  } else {
    // Token overlap (e.g. "plum alley" vs plumalley)
    const tokens = cleanName(companyName).split(/\s+/).filter((t) => t.length > 2);
    const matchedTokens = tokens.filter((t) => base.includes(t.replace(/[^a-z0-9]/g, "")));
    if (matchedTokens.length > 0 && matchedTokens.length === tokens.length) score += 70;
    else if (matchedTokens.length > 0) score += 25;
    else return 0;
  }

  if (COMMON_TLDS.has(tld)) score += 15;
  else score -= 40;

  if (suggested) {
    if (suggested === query) score += 30;
    else if (suggested.includes(query) || query.includes(suggested)) score += 15;
  }

  return score;
}

function lookupDictionary(companyName) {
  const cleaned = cleanName(companyName);
  const key = normalizeKey(companyName);

  if (companyDictionary[cleaned]) {
    return { key: cleaned, entry: companyDictionary[cleaned] };
  }
  if (companyDictionary[key]) {
    return { key, entry: companyDictionary[key] };
  }

  for (const dictKey of Object.keys(companyDictionary)) {
    const dictNorm = normalizeKey(dictKey);
    if (key === dictNorm || key.includes(dictNorm) || dictNorm.includes(key)) {
      // Avoid weak partials for very short keys
      if (Math.min(key.length, dictNorm.length) < 4 && key !== dictNorm) continue;
      return { key: dictKey, entry: companyDictionary[dictKey] };
    }
  }
  return null;
}

function extractUrlDomain(str) {
  if (!str) return "";
  const bracketMatch = String(str).match(/\[\s*(https?:\/\/[^\s\]]+)/i);
  let url = bracketMatch ? bracketMatch[1] : String(str);
  const urlMatch = url.match(/(https?:\/\/[^\s\/]+)/i);
  if (urlMatch) url = urlMatch[1];
  return normalizeDomain(url);
}

async function fetchClearbitCandidates(query) {
  const response = await fetch(
    `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(query)}`
  );
  if (!response.ok) return [];
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((item) => item?.domain)
    .map((item) => ({
      domain: normalizeDomain(item.domain),
      name: item.name || "",
      source: "clearbit"
    }));
}

async function fetchDuckDuckGoOfficialSite(query) {
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
  );
  if (!response.ok) return null;
  const json = await response.json();
  if (!json?.Infobox?.content) return null;

  let item = json.Infobox.content.find(
    (i) => i.data_type === "official_website" || i.label === "Official Website"
  );
  if (!item) item = json.Infobox.content.find((i) => i.label === "Website");
  if (!item?.value) return null;

  const domain = extractUrlDomain(item.value);
  if (!domain || !domain.includes(".")) return null;

  return {
    domain,
    name: json.Heading || query,
    source: "duckduckgo",
    abstract: json.AbstractText || ""
  };
}

/**
 * Resolve an official website via real search candidates + confidence gating.
 * @param {string} companyName
 * @param {{ industry?: string, location?: string }} [context]
 * @returns {Promise<{
 *   domain: string|null,
 *   verification: 'verified'|'unverified'|'not_found',
 *   reason: string,
 *   matchedName?: string,
 *   fastPath?: boolean
 * }>}
 */
export async function resolveDomain(companyName, context = {}) {
  await delay(Math.floor(Math.random() * 250) + 200);

  if (!companyName || companyName.trim().length < 2) {
    return {
      domain: null,
      verification: "not_found",
      reason: "No company name provided"
    };
  }

  const cleaned = cleanName(companyName);
  const key = normalizeKey(companyName);

  if (JUNK_NAMES.has(cleaned) || JUNK_NAMES.has(key)) {
    return {
      domain: null,
      verification: "not_found",
      reason: "Name looks like a placeholder; skipped search"
    };
  }

  // Fast path: well-known companies in the local catalogue
  const dictHit = lookupDictionary(companyName);
  if (dictHit) {
    const domain = normalizeDomain(dictHit.entry.domain);
    // Still confirm the domain looks legitimate
    if (domain.includes(".") && scoreDomainAgainstCompany(domain, companyName, dictHit.key) >= 40) {
      return {
        domain,
        verification: "verified",
        reason: "Matched known company catalogue (fast path)",
        matchedName: dictHit.key,
        fastPath: true
      };
    }
  }

  const ambiguous = isAmbiguousCompanyName(companyName);
  const hasContext =
    !isPlaceholder(context.industry) || !isPlaceholder(context.location);
  const queries = buildSearchQueries(companyName, context);

  // Prefer context-augmented queries when the name is ambiguous
  const orderedQueries =
    ambiguous && hasContext
      ? [...queries.slice(2), ...queries.slice(0, 2)]
      : queries;

  const candidates = [];
  const seen = new Set();

  const addCandidate = (candidate, scoreBoost = 0) => {
    if (!candidate?.domain) return;
    const domain = normalizeDomain(candidate.domain);
    if (!domain.includes(".") || seen.has(domain)) return;
    seen.add(domain);
    const score =
      scoreDomainAgainstCompany(domain, companyName, candidate.name) + scoreBoost;
    candidates.push({ ...candidate, domain, score });
  };

  // Real web search: Clearbit company suggest
  for (const query of orderedQueries.slice(0, 4)) {
    try {
      const results = await fetchClearbitCandidates(query);
      results.forEach((item) => addCandidate(item));
      if (candidates.some((c) => c.score >= 80)) break;
    } catch (err) {
      console.warn("Clearbit search failed:", err);
    }
  }

  // DuckDuckGo Instant Answer (official website when available)
  for (const query of orderedQueries.slice(0, 2)) {
    try {
      const ddg = await fetchDuckDuckGoOfficialSite(query);
      if (ddg) addCandidate(ddg, 10);
    } catch (err) {
      console.warn("DuckDuckGo Instant Answer failed:", err);
    }
  }

  if (candidates.length === 0) {
    return {
      domain: null,
      verification: "not_found",
      reason: ambiguous && !hasContext
        ? "Ambiguous company name and no industry/location context to disambiguate"
        : "No search candidates found for this company"
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  const closeRace =
    second && best.score - second.score < 15 && second.score >= 40;

  // Ambiguous / common names: never silently "verify" — show candidate as Unverified at most
  if (ambiguous) {
    if (best.score >= 45) {
      return {
        domain: best.domain,
        verification: "unverified",
        reason: hasContext
          ? "Ambiguous name even with industry/location context; confirm manually"
          : "Ambiguous company name; search hit needs manual confirmation",
        matchedName: best.name || undefined
      };
    }

    return {
      domain: null,
      verification: "not_found",
      reason: "Ambiguous company name; could not confirm an official site"
    };
  }

  // Strong confirmation: domain/name closely matches
  if (best.score >= 75 && !closeRace) {
    return {
      domain: best.domain,
      verification: "verified",
      reason: `Verified via ${best.source} (score ${best.score})`,
      matchedName: best.name || undefined
    };
  }

  // Moderate match → return candidate but mark unverified (never pretend it's confirmed)
  if (best.score >= 45) {
    return {
      domain: best.domain,
      verification: "unverified",
      reason: closeRace
        ? "Multiple close search matches; needs manual verification"
        : "Search found a possible site but confidence is below verification threshold",
      matchedName: best.name || undefined
    };
  }

  return {
    domain: null,
    verification: "not_found",
    reason: "Search results did not confidently match this company"
  };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function inferIndustryFromText(text) {
  const t = text.toLowerCase();
  const rules = [
    [/venture capital|growth equity|seed fund|early-stage/, "Venture Capital"],
    [/investment bank|advisory firm|mergers and acquisitions/, "Investment Banking"],
    [/payments?|fintech|financial infrastructure/, "Financial Technology"],
    [/artificial intelligence|machine learning|language model/, "Artificial Intelligence"],
    [/higher education|university|ivy league/, "Higher Education"],
    [/e-?commerce|online retail/, "E-Commerce / Retail"],
    [/saas|software|productivity|workspace/, "Software / SaaS"],
    [/healthcare|biotech|therapeutics|clinical/, "Healthcare / Biotech"],
    [/legal services|law firm|attorneys?/, "Legal Services"],
    [/marketing agency|creative studio|brand campaigns/, "Marketing & Creative"]
  ];
  for (const [pattern, industry] of rules) {
    if (pattern.test(t)) return industry;
  }
  return "Unknown";
}

function inferLocationFromText(text) {
  const patterns = [
    /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),\s*([A-Z]{2})\b/,
    /\b(San Francisco|New York|London|Paris|Berlin|Toronto|Austin|Seattle|Boston|Chicago|Los Angeles|Mountain View|Cupertino|Redmond|Menlo Park)\b[, ]+([A-Z]{2}|CA|NY|TX|WA|MA|IL|UK|France)?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const city = match[1];
      const region = match[2] ? `, ${match[2]}` : "";
      return `${city}${region}`.replace(/,\s*,/g, ",").trim();
    }
  }
  return "Unknown";
}

async function fetchSiteText(domain) {
  const target = `https://${normalizeDomain(domain)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    // Browser CORS workaround for public homepage text
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
    const response = await fetch(proxyUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html || html.length < 40) return null;

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";
    const description =
      extractMeta(html, "description") ||
      extractMeta(html, "og:description") ||
      "";
    const siteName = extractMeta(html, "og:site_name") || "";
    const bodyText = stripHtml(html).slice(0, 4000);

    return { title, description, siteName, bodyText, html };
  } catch (err) {
    console.warn("Homepage fetch failed:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function pageConfirmsCompany(site, companyName) {
  if (!site) return false;
  const blob = `${site.title} ${site.siteName} ${site.description} ${site.bodyText}`.toLowerCase();
  const cleaned = cleanName(companyName);
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return blob.includes(cleaned);
  const hits = tokens.filter((t) => blob.includes(t));
  return hits.length >= Math.ceil(tokens.length * 0.6);
}

/**
 * Batch uniqueness registry — same Industry / notes text cannot be written
 * to two different domains in one batch (bug signal → Unknown).
 */
const enrichmentValueRegistry = {
  industry: new Map(),
  notes: new Map(),
  reset() {
    this.industry.clear();
    this.notes.clear();
  }
};

export function resetEnrichmentBatchGuards() {
  enrichmentValueRegistry.reset();
}

function applyBatchUniquenessGuard(domain, fields) {
  const host = normalizeDomain(domain);
  const out = { ...fields };
  for (const key of ["industry", "notes"]) {
    const raw = out[key];
    const norm = String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!norm || norm === "unknown" || norm.length < 4) {
      if (key === "industry") out[key] = "Unknown";
      continue;
    }
    const owner = enrichmentValueRegistry[key].get(norm);
    if (owner && owner !== host) {
      console.warn(`[enrich] BLOCK duplicate ${key} for ${host} (already used by ${owner})`);
      out[key] = "Unknown";
    } else {
      enrichmentValueRegistry[key].set(norm, host);
    }
  }
  return out;
}

/**
 * Enrich fields from verified website content. Never fabricates values.
 * @param {string} domain
 * @param {string} originalName
 * @returns {Promise<{ industry: string, headcount: string, location: string, notes: string }>}
 */
export async function enrichCompanyDetails(domain, originalName) {
  await delay(Math.floor(Math.random() * 300) + 300);

  let base = null;

  const dictHit = lookupDictionary(originalName);
  if (dictHit && normalizeDomain(dictHit.entry.domain) === normalizeDomain(domain)) {
    base = {
      industry: dictHit.entry.industry,
      headcount: dictHit.entry.headcount,
      location: dictHit.entry.location,
      notes: dictHit.entry.notes
    };
  }

  if (!base) {
    for (const entry of Object.values(companyDictionary)) {
      if (normalizeDomain(entry.domain) === normalizeDomain(domain)) {
        base = {
          industry: entry.industry,
          headcount: entry.headcount,
          location: entry.location,
          notes: entry.notes
        };
        break;
      }
    }
  }

  if (!base) {
    const site = await fetchSiteText(domain);
    if (!site || !pageConfirmsCompany(site, originalName)) {
      return applyBatchUniquenessGuard(domain, {
        industry: "Unknown",
        headcount: "Unknown",
        location: "Unknown",
        notes: "Unknown"
      });
    }

    const corpus = `${site.title}. ${site.description}. ${site.bodyText}`;
    const industry = inferIndustryFromText(corpus);
    const location = inferLocationFromText(corpus);

    let headcount = "Unknown";
    const headcountMatch = corpus.match(
      /\b(\d{1,3}(?:,\d{3})*\+?\s*[-–to]+\s*\d{1,3}(?:,\d{3})*\+?|\d{1,3}(?:,\d{3})*\+)\s*(?:employees|people|team members)\b/i
    );
    if (headcountMatch) {
      headcount = headcountMatch[1].replace(/\s+/g, " ").trim();
    }

    const notes =
      site.description && site.description.length > 20
        ? site.description.slice(0, 160)
        : "Unknown";

    base = { industry, headcount, location, notes };
  }

  return applyBatchUniquenessGuard(domain, base);
}
