/**
 * Canonical company identity / domain resolution.
 * Goal: when status=resolved, the domain must be trustworthy (precision > coverage).
 */

export const JUNK_DOMAIN_RE =
  /(^|\.)(linkedin\.com|crunchbase\.com|pitchbook\.com|bloomberg\.com|reuters\.com|wikipedia\.org|wikidata\.org|facebook\.com|twitter\.com|x\.com|youtube\.com|instagram\.com|glassdoor\.com|indeed\.com|levels\.fyi|wellfound\.com|angel\.co|medium\.com|substack\.com|msn\.com|mercurynews\.com|forbes\.com|techcrunch\.com|businessinsider\.com|nytimes\.com|wsj\.com|ft\.com|yahoo\.com|bing\.com|google\.com|zoominfo\.com|apollo\.io|rocketreach\.com|owler\.com|tracxn\.com|cbinsights\.com|mediafire\.com|hci\.org)(\/|$)/i;

/** Common single-token brand words that alone are weak identity evidence. */
const COMMON_BRAND_TOKENS = new Set([
  'vista', 'mercury', 'scale', 'ramp', 'insight', 'apex', 'summit', 'horizon', 'pulse',
  'human', 'capital', 'chapter', 'one', 'next', 'first', 'prime', 'alpha', 'meta',
  'unity', 'vertex', 'nexus', 'orbit', 'forge', 'spark', 'bolt', 'wave', 'core'
]);

const GENERIC_NAME_TOKENS = new Set([
  'the', 'and', 'of', 'for', 'global', 'management', 'company', 'group', 'inc', 'llc',
  'corp', 'corporation', 'holdings', 'international', 'technologies', 'technology'
]);

export function hostOf(domain) {
  return String(domain || '')
    .toLowerCase()
    .replace(/[\[\]]/g, '')
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
}

export function apexDomain(domain) {
  const host = hostOf(domain);
  const labels = host.split('.');
  if (labels.length >= 3 && /^(ir|investors?|www|shop|store|careers|jobs|support|help|community|developers?|docs|blog|news|press|events|games|merch)$/i.test(labels[0])) {
    return labels.slice(1).join('.');
  }
  return host;
}

/** Expand an official-site hit into apex + brand.com companions (eval/production candidate building). */
export function expandOfficialDomainCandidates(domain, companyName) {
  const out = [];
  const host = hostOf(domain);
  if (!host) return out;
  out.push(host);
  const apex = apexDomain(host);
  if (apex && apex !== host) out.push(apex);
  const key = nameKey(companyName);
  const tokens = identityTokens(companyName);
  if (key && key.length >= 3) out.push(`${key}.com`);
  if (tokens[0] && tokens.length >= 1) out.push(`${tokens[0]}.com`);
  if (tokens.length === 2) out.push(`${tokens[0]}.${tokens[1]}`);
  return [...new Set(out.map(hostOf).filter(Boolean))];
}

export function stripLegal(name) {
  return String(name || '')
    .replace(/\b(inc\.?|incorporated|llc|l\.l\.c\.?|llp|lp|plc|ltd\.?|limited|corp\.?|corporation|co\.?|company|holdings?|gmbh)\b/gi, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function nameKey(name) {
  return stripLegal(name).replace(/[^a-z0-9]+/g, '');
}

/** All meaningful tokens including partners/equity/ventures (needed for PE/VC names). */
export function identityTokens(name) {
  return stripLegal(name)
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 1 && !GENERIC_NAME_TOKENS.has(t));
}

/** Distinctive tokens: longer / non-common brand words. */
export function distinctiveTokens(name) {
  return identityTokens(name).filter((t) => t.length >= 4 && !COMMON_BRAND_TOKENS.has(t));
}

export function ambiguityRisk(name, candidateCount = 0) {
  const tokens = identityTokens(name);
  const key = nameKey(name);
  let risk = 0;
  if (tokens.length <= 1) risk += 35;
  if (tokens.length === 2) risk += 15;
  if (tokens.every((t) => COMMON_BRAND_TOKENS.has(t) || t.length <= 4)) risk += 25;
  if (key.length <= 6) risk += 15;
  if (candidateCount >= 4) risk += 10;
  if (candidateCount >= 6) risk += 10;
  return Math.min(100, risk);
}

/**
 * Infer coarse entity type from page/snippet evidence.
 */
export function inferEntityType(evidence = {}) {
  const blob = [
    evidence.pageTitle,
    evidence.metaDescription,
    evidence.snippet,
    evidence.abstract,
    evidence.pageText?.slice(0, 2000)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!blob) return { type: 'unknown', confidence: 'low' };

  if (/\b(private equity|venture capital|venture firm|buyout|growth equity|investment firm)\b/.test(blob)) {
    return { type: 'investment_firm', confidence: 'medium' };
  }
  if (/\b(official merchandise|online store|shop now|add to cart|checkout)\b/.test(blob) || /\.shop\b/.test(blob)) {
    return { type: 'store', confidence: 'medium' };
  }
  if (/\b(game|gaming|xbox|playstation|casual games)\b/.test(blob) && !/\b(company|corporation|headquartered)\b/.test(blob)) {
    return { type: 'product', confidence: 'low' };
  }
  if (/\b(careers|we.?re hiring|job openings)\b/.test(blob) && blob.length < 400) {
    return { type: 'careers', confidence: 'low' };
  }
  if (/\b(printing|business cards|vista ?print)\b/.test(blob)) {
    return { type: 'print_services', confidence: 'medium' };
  }
  if (/\b(nonprofit|foundation|charity)\b/.test(blob)) {
    return { type: 'nonprofit', confidence: 'medium' };
  }
  if (/\b(is an?|corporation|headquartered|multinational|company that)\b/.test(blob)) {
    return { type: 'company', confidence: 'medium' };
  }
  return { type: 'unknown', confidence: 'low' };
}

function detectAffiliatePurpose(domain, evidence = {}) {
  const host = hostOf(domain);
  const title = String(evidence.pageTitle || '').toLowerCase();
  const meta = String(evidence.metaDescription || '').toLowerCase();
  const text = String(evidence.pageText || '').slice(0, 1500).toLowerCase();
  const blob = `${title} ${meta} ${text}`;
  const penalties = [];

  // Non-apex / property subdomains of a brand (ir.netflix.net, shop.example.com)
  const labels = host.split('.');
  if (labels.length >= 3) {
    const sub = labels[0];
    if (/^(ir|investors?|shop|store|careers|jobs|support|help|community|developer|developers|docs|blog|news|press|events|games|casualgames|merch|marketplace)$/i.test(sub)) {
      penalties.push({ reason: 'property_subdomain', points: -55 });
    }
  }
  // Multi-label hosts that aren't www (e.g. ir.netflix.net)
  if (labels.length >= 3 && !/^www$/i.test(labels[0])) {
    penalties.push({ reason: 'non_apex_host', points: -25 });
  }

  // TLD / hostname purpose
  if (/\.shop$|\.store$/i.test(host) || /(^|\.)shop\.|(^|\.)store\./i.test(host)) {
    penalties.push({ reason: 'commerce_tld', points: -60 });
  }
  if (/(casualgames|merchandise|merch|fanclub|community|support|careers|jobs|developers?|devportal|events)/i.test(host.replace(/\./g, ''))) {
    penalties.push({ reason: 'affiliate_host_token', points: -50 });
  }

  // Site-purpose evidence (title/meta preferred)
  const purposeChecks = [
    { re: /\b(official\s+)?(merchandise|merch store|online store|gift shop)\b/i, reason: 'store_purpose', points: -55 },
    { re: /\b(add to cart|shop all|buy now)\b/i, reason: 'ecommerce_cta', points: -40 },
    { re: /\b(investor relations|shareholder|stock information)\b/i, reason: 'investor_relations', points: -45 },
    { re: /\b(careers at|we.?re hiring|open roles)\b/i, reason: 'careers_site', points: -35 },
    { re: /\b(developer portal|api documentation|docs for developers)\b/i, reason: 'developer_portal', points: -30 },
    { re: /\b(casual games|xbox games|game studio microsite)\b/i, reason: 'games_property', points: -55 },
    { re: /\b(vistaprint|online printing|business cards|custom printing)\b/i, reason: 'print_brand', points: -50 }
  ];
  for (const { re, reason, points } of purposeChecks) {
    if (re.test(title) || re.test(meta) || (re.test(text) && /store|shop|careers|games|printing|investor/i.test(title + meta))) {
      penalties.push({ reason, points });
    }
  }

  // Regional / country commercial mirrors
  if (/\.(co\.[a-z]{2}|com\.[a-z]{2}|com\.br|com\.co|com\.mx|com\.au)$/i.test(host)) {
    penalties.push({ reason: 'regional_ccTLD', points: -45 });
  }

  return penalties;
}

/**
 * Score one candidate as a possible canonical corporate identity.
 */
export function scoreIdentityCandidate(companyName, candidate, evidence = {}) {
  const domain = hostOf(candidate.domain);
  const signals = {};
  let score = 0;
  const name = String(companyName || '').trim();
  const key = nameKey(name);
  const tokens = identityTokens(name);
  const distinctive = distinctiveTokens(name);
  const label = String(candidate.name || evidence.heading || '').trim();
  const title = String(evidence.pageTitle || evidence.searchTitle || '').trim();
  const snippet = String(evidence.snippet || evidence.abstract || '').trim();
  const pageText = String(evidence.pageText || '').slice(0, 5000);
  const metaDesc = String(evidence.metaDescription || '').trim();
  const jsonLd = String(evidence.jsonLdName || '').trim();
  const sourcesAgree = Number(evidence.sourceAgreementCount || candidate.sourceAgreementCount || 0);

  if (!domain || !domain.includes('.')) {
    return { domain, score: 0, signals: { invalid: true }, penalized: true, authoritativeCount: 0 };
  }

  if (JUNK_DOMAIN_RE.test(domain)) {
    score -= 120;
    signals.junkDomain = -120;
  }

  const labels = domain.split('.');
  // Strip common / brand TLDs (incl. .capital, .ai) and multi-part ccTLDs (com.co)
  const SPECIAL_TLDS = new Set([
    'com', 'net', 'org', 'io', 'ai', 'co', 'app', 'dev', 'xyz', 'info', 'biz',
    'us', 'uk', 'de', 'fr', 'vc', 'capital', 'shop', 'store', 'tech', 'so'
  ]);
  let nameLabels = labels;
  if (labels.length >= 3 && /^(co|com|net|org|gov|ac)$/i.test(labels[labels.length - 2])) {
    nameLabels = labels.slice(0, -2);
  } else if (labels.length >= 2 && SPECIAL_TLDS.has(labels[labels.length - 1].toLowerCase())) {
    nameLabels = labels.slice(0, -1);
  } else {
    nameLabels = labels.slice(0, -1);
  }
  const core = nameLabels.join('').replace(/\./g, '') || labels[0];
  const primaryToken = tokens[0] || '';

  // human.capital style: second name token is the TLD
  if (
    tokens.length === 2 &&
    labels.length === 2 &&
    labels[0] === tokens[0] &&
    labels[1] === tokens[1]
  ) {
    // Modest base; stronger only with investment-firm evidence (avoids lux.capital beating luxcapital.com)
    const investEv = /venture|private equity|investment firm|capital firm|early-stage|seed fund/i.test(
      `${title} ${metaDesc} ${snippet} ${pageText.slice(0, 800)}`
    );
    const pts = investEv ? 50 : 18;
    score += pts;
    signals.tokenAsTldMatch = pts;
    if (investEv) signals.tokenAsTldInvestEvidence = 1;
  }

  // --- Domain ↔ full legal/canonical name ---
  if (core === key) {
    score += 40;
    signals.domainExactKey = 40;
  } else if (primaryToken && core === primaryToken && tokens.length >= 2) {
    // microsoft.com for Microsoft; scale.com for Scale AI; vista.com for Vista Equity (weak alone)
    score += tokens.length === 2 && tokens[1] === 'ai' ? 38 : 10;
    signals.primaryTokenDomain = tokens.length === 2 && tokens[1] === 'ai' ? 38 : 10;
  } else if (key.length >= 4 && core.startsWith(key) && core.length > key.length + 2) {
    // microsoftcasualgames, brextom
    const suffix = core.slice(key.length);
    if (!/^(hq|inc|corp|app)$/i.test(suffix)) {
      score -= 55;
      signals.brandSuffixNoise = -55;
    }
  } else if (key.length >= 4 && core.includes(key)) {
    score += 12;
    signals.domainContainsKey = 12;
  }

  // "* AI" companies: prefer brand.com over brandai.com when both are candidates
  if (tokens.length === 2 && tokens[1] === 'ai' && primaryToken) {
    if (core === `${primaryToken}ai` || (core === key && key.endsWith('ai') && core !== primaryToken)) {
      score -= 45;
      signals.concatAiDomainPenalty = -45;
    }
    if (core === primaryToken && /\.com$/i.test(domain)) {
      score += 35;
      signals.aiBrandComPreferred = 35;
    }
  }

  // brand + noise suffix glued on (microsoftcasualgames, brextom) even when key is shorter
  if (primaryToken && primaryToken.length >= 4 && core.startsWith(primaryToken) && core.length >= primaryToken.length + 3) {
    const glued = core.slice(primaryToken.length);
    if (!/^(ai|hq|inc|corp|app|io)$/i.test(glued) && !tokens.some((t) => t !== primaryToken && glued.includes(t))) {
      score -= 50;
      signals.brandSuffixNoise = (signals.brandSuffixNoise || 0) - 50;
    }
  }

  // Token coverage — critical for multiword entities (Vista Equity Partners)
  // For "X AI" brands, "ai" need not appear in the domain (scale.com is correct).
  const coverageTokens = tokens.filter((t) => !(tokens.length === 2 && tokens[1] === 'ai' && t === 'ai'));
  let tokenHits = 0;
  for (const tok of coverageTokens) {
    if (core.includes(tok) || domain.includes(tok)) tokenHits += 1;
  }
  const coverage = coverageTokens.length ? tokenHits / coverageTokens.length : 0;
  const covPts = Math.round(coverage * 40);
  score += covPts;
  signals.tokenCoverage = covPts;

  if (coverageTokens.length >= 2 && coverage < 0.6) {
    score -= 40;
    signals.incompleteEntityName = -40;
  }
  if (distinctive.length) {
    const distHits = distinctive.filter((t) => core.includes(t) || domain.includes(t)).length;
    if (distHits === 0) {
      score -= 50;
      signals.missingDistinctiveTokens = -50;
    } else {
      const dpts = Math.round((distHits / distinctive.length) * 35);
      score += dpts;
      signals.distinctiveTokenHits = dpts;
    }
  }

  // Single common-token domain for multiword query (vista.com for Vista Equity Partners)
  if (tokens.length >= 2 && tokenHits <= 1 && COMMON_BRAND_TOKENS.has(tokens[0]) && core === tokens[0] && !(tokens.length === 2 && tokens[1] === 'ai')) {
    score -= 45;
    signals.genericBrandOnlyDomain = -45;
  }

  // Candidate display name / Clearbit name
  if (label) {
    const lk = nameKey(label);
    if (lk === key) {
      score += 28;
      signals.candidateNameExact = 28;
    } else {
      const labelTok = identityTokens(label);
      const overlap = tokens.filter((t) => labelTok.includes(t)).length;
      if (tokens.length && overlap / tokens.length >= 0.7) {
        score += 18;
        signals.candidateNameOverlap = 18;
      }
    }
  }

  // JSON-LD Organization name
  if (jsonLd) {
    if (nameKey(jsonLd) === key || identityTokens(jsonLd).filter((t) => tokens.includes(t)).length >= Math.max(1, tokens.length - 1)) {
      score += 30;
      signals.jsonLdMatch = 30;
    }
  }

  // Page title / About language
  const nk = stripLegal(name);
  if (title) {
    const tl = title.toLowerCase();
    if (tl.includes(nk) || nameKey(title) === key) {
      score += 18;
      signals.titleMentionsCompany = 18;
    }
    if (/\bofficial (website|site)\b/i.test(title)) {
      score += 12;
      signals.titleOfficial = 12;
    }
  }

  if (metaDesc) {
    const ml = metaDesc.toLowerCase();
    if (new RegExp(`\\b${nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*(is an?|is a|provides|builds)`, 'i').test(ml) ||
        new RegExp(`(is an?|is a)\\b.*\\b${nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(ml)) {
      score += 22;
      signals.aboutLanguage = 22;
    } else if (ml.includes(nk)) {
      score += 8;
      signals.metaMentionsCompany = 8;
    }
  }

  if (snippet) {
    const sl = snippet.toLowerCase();
    if (/\bofficial website\b/i.test(sl) && sl.includes(nk)) {
      score += 20;
      signals.snippetOfficialWebsite = 20;
    } else if (sl.includes(nk)) {
      score += 8;
      signals.snippetMentionsCompany = 8;
    }
  }

  if (pageText) {
    const head = pageText.slice(0, 1200).toLowerCase();
    if (head.includes(nk)) {
      score += 12;
      signals.homepageHeadMention = 12;
    }
    const copyright = pageText.match(/©\s*\d{4}[^.\n]{0,60}/i)?.[0] || '';
    if (copyright && (nameKey(copyright).includes(key.slice(0, 8)) || tokens.some((t) => t.length > 3 && copyright.toLowerCase().includes(t)))) {
      score += 15;
      signals.copyrightMatch = 15;
    }
  }

  // Affiliate / microsite penalties
  const affiliate = detectAffiliatePurpose(domain, evidence);
  for (const p of affiliate) {
    score += p.points;
    signals[p.reason] = (signals[p.reason] || 0) + p.points;
  }

  // TLD secondary signal (not a hard rule)
  const tld = labels.slice(labels.length >= 3 && labels[labels.length - 2].length <= 3 ? -2 : -1).join('.');
  if (/^(com)$/i.test(tld)) {
    score += 8;
    signals.tldCom = 8;
  } else if (/^(ai|io|co|capital|vc)$/i.test(tld) || /\.(ai|io)$/i.test(domain)) {
    score += 4;
    signals.tldAltOk = 4;
  } else if (/^(shop|store)$/i.test(tld)) {
    score -= 70;
    signals.tldShop = -70;
  } else if (/^(cz|ru|cn|tk|ml|ga|cf|gq|pw|cc|biz|info)$/i.test(tld)) {
    score -= 35;
    signals.tldObscureCc = -35;
  } else if (!/^(net|org|edu|gov|us|uk|de|fr|so|app|dev)$/i.test(tld)) {
    score -= 12;
    signals.tldUncommon = -12;
  }

  // Entity-type alignment
  const entity = inferEntityType(evidence);
  signals.entityType = entity.type;
  const wantsInvestment = /\b(capital|ventures?|partners|equity|private equity|venture)\b/i.test(name);
  if (wantsInvestment && entity.type === 'investment_firm') {
    score += 35;
    signals.entityTypeMatch = 35;
  } else if (wantsInvestment && (entity.type === 'print_services' || entity.type === 'store' || entity.type === 'product')) {
    score -= 55;
    signals.entityTypeMismatch = -55;
  } else if (!wantsInvestment && entity.type === 'store' && !/\b(shop|store|retail)\b/i.test(name)) {
    score -= 40;
    signals.entityTypeStorePenalty = -40;
  }

  // Source authority + cross-source consensus
  const src = String(candidate.source || '');
  let authoritativeCount = 0;
  if (src === 'wikidata_official' || src === 'wikidata_official_expanded' || evidence.wikidataOfficial) {
    // Raw IR/shop Wikidata URLs should not get full authority; apex expansions can
    const isProperty = !!(signals.property_subdomain || signals.non_apex_host || signals.tldShop || signals.commerce_tld);
    if (!isProperty) {
      score += 45;
      signals.wikidataP856 = 45;
      authoritativeCount += 1;
    } else {
      score += 5;
      signals.wikidataPropertySite = 5;
    }
  }
  if (src === 'ddg_infobox') {
    score += 25;
    signals.sourceInfobox = 25;
    authoritativeCount += 1;
  }
  if (src === 'clearbit') {
    score += 18;
    signals.sourceClearbit = 18;
  }
  if (src === 'brand_guess') {
    score += 1;
    signals.sourceGuess = 1;
  }
  if (sourcesAgree >= 2) {
    score += 20;
    signals.multiSourceConsensus = 20;
    authoritativeCount += 1;
  }
  if (sourcesAgree >= 3) {
    score += 25;
    signals.strongConsensus = 25;
    authoritativeCount += 1;
  }

  // PE/VC-style names: lightly prefer validated token-as-TLD; do not punish exact .com by default
  const isInvestName = /\b(capital|ventures?|partners|equity)\b/i.test(name);
  if (isInvestName && signals.tokenAsTldInvestEvidence) {
    score += 25;
    signals.investTokenTldBoost = 25;
  }

  // Ambiguity risk soft penalty on weak candidates
  const risk = ambiguityRisk(name);
  if (risk >= 40 && authoritativeCount === 0 && !(signals.domainExactKey && signals.aboutLanguage)) {
    score -= Math.round(risk / 4);
    signals.ambiguityRiskPenalty = -Math.round(risk / 4);
  }

  return {
    domain,
    score,
    signals,
    penalized: score < 20 || !!signals.junkDomain,
    hostCore: core,
    nameKey: key,
    tokenCoverage: coverage,
    authoritativeCount,
    entityType: entity.type,
    ambiguityRisk: risk
  };
}

/**
 * Select identity with precision-first thresholds and margin-of-victory.
 */
export function selectIdentity(scoredCandidates, opts = {}) {
  const ambiguityGap = opts.ambiguityGap ?? 18;
  const companyName = opts.companyName || '';
  const risk = ambiguityRisk(companyName, (scoredCandidates || []).length);
  // Higher ambiguity → harder to resolve
  const resolveMin = (opts.resolveMin ?? 70) + Math.round(risk / 5);

  const ranked = [...(scoredCandidates || [])]
    .filter((c) => c && c.domain && !JUNK_DOMAIN_RE.test(c.domain))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      identityStatus: 'unresolved',
      domain: null,
      confidence: 'low',
      score: 0,
      candidates: [],
      reason: 'no_candidates',
      resolveMin,
      ambiguityRisk: risk
    };
  }

  // Prefer exact full-key domain when competitive (microsoft.com over microsoftcasualgames.com)
  const key = nameKey(companyName);
  let chosen = ranked[0];
  const exact = ranked.find((c) => c.hostCore === key || c.signals?.domainExactKey);
  if (exact && exact.domain !== chosen.domain) {
    const noisy =
      chosen.signals?.brandSuffixNoise ||
      chosen.signals?.commerce_tld ||
      chosen.signals?.tldShop ||
      chosen.signals?.affiliate_host_token ||
      chosen.signals?.property_subdomain ||
      chosen.signals?.non_apex_host ||
      chosen.signals?.investor_relations;
    if (noisy || chosen.score - exact.score <= 35) {
      chosen = exact;
    }
  }

  // Prefer apex brand.com over ir./shop. subdomains of same brand
  const apexPrefer = ranked.find((c) => {
    if (!chosen.domain || c.domain === chosen.domain) return false;
    const ch = hostOf(chosen.domain);
    const ah = hostOf(c.domain);
    return ch.endsWith(`.${ah}`) || (c.signals?.domainExactKey && (chosen.signals?.property_subdomain || chosen.signals?.non_apex_host));
  });
  if (apexPrefer && (chosen.signals?.property_subdomain || chosen.signals?.non_apex_host || chosen.score - apexPrefer.score <= 40)) {
    chosen = apexPrefer;
  }

  // Prefer exact-key .com over .net/.org/.cz/etc. when cores match (netflix.com > netflix.net, brex.com > brex.cz)
  const TRUSTED_TLDS = new Set(['com', 'org', 'net', 'io', 'ai', 'co', 'app', 'dev', 'so', 'capital', 'vc', 'edu', 'gov']);
  if (key && chosen.hostCore === key) {
    const comExact = ranked.find((c) => c.hostCore === key && /\.com$/i.test(c.domain));
    if (comExact && comExact.domain !== chosen.domain) {
      const chosenTld = hostOf(chosen.domain).split('.').pop();
      // Always prefer .com when the .com candidate is remotely viable
      if (chosenTld !== 'com' && comExact.score >= Math.min(resolveMin - 25, 40)) {
        chosen = comExact;
      }
    }
  }
  // Reject obscure ccTLDs when a trusted-TLD same-core rival exists
  {
    const chosenTld = hostOf(chosen.domain || '').split('.').pop();
    if (chosenTld && !TRUSTED_TLDS.has(chosenTld)) {
      const trusted = ranked.find(
        (c) =>
          c.domain !== chosen.domain &&
          (c.hostCore === chosen.hostCore || c.hostCore === key) &&
          TRUSTED_TLDS.has(hostOf(c.domain).split('.').pop()) &&
          c.score >= Math.min(resolveMin - 25, 40)
      );
      if (trusted) chosen = trusted;
    }
  }

  // Prefer higher token coverage for multiword names
  const tokens = identityTokens(companyName);
  if (tokens.length >= 2) {
    const betterCoverage = ranked.find(
      (c) => (c.tokenCoverage || 0) >= 0.75 && (chosen.tokenCoverage || 0) < 0.6 && chosen.score - c.score <= 40
    );
    if (betterCoverage) chosen = betterCoverage;
  }

  // Human Capital-style: prefer token-as-TLD only when it has invest evidence and .com lacks it
  if (/\b(capital|ventures?|partners|equity)\b/i.test(companyName)) {
    const tldStyle = ranked.find((c) => c.signals?.tokenAsTldInvestEvidence);
    const comStyle = ranked.find((c) => c.hostCore === key && /\.com$/i.test(c.domain));
    if (
      tldStyle &&
      comStyle &&
      !comStyle.signals?.entityTypeMatch &&
      !/venture|private equity|investment firm/i.test(
        JSON.stringify(comStyle.pageEvidence || comStyle.signals || {})
      ) &&
      tldStyle.signals?.entityTypeMatch
    ) {
      chosen = tldStyle;
    } else if (comStyle && tldStyle && !tldStyle.signals?.tokenAsTldInvestEvidence && chosen.domain === tldStyle.domain) {
      chosen = comStyle;
    }
  }

  const rival = ranked.find((c) => c.domain !== chosen.domain) || null;

  if (chosen.score < resolveMin) {
    return {
      identityStatus: chosen.score >= resolveMin - 25 ? 'ambiguous' : 'unresolved',
      domain: null,
      confidence: 'low',
      score: chosen.score,
      candidates: ranked.slice(0, 6),
      reason: 'below_resolve_threshold',
      bestRejected: chosen,
      resolveMin,
      ambiguityRisk: risk
    };
  }

  // Margin of victory
  if (rival && chosen.score - rival.score < ambiguityGap) {
    // Allow resolve only if chosen has clear authoritative edge
    const chosenAuth = (chosen.authoritativeCount || 0) >= 1 || chosen.signals?.wikidataP856 || chosen.signals?.strongConsensus;
    const rivalNoisy =
      rival.signals?.brandSuffixNoise ||
      rival.signals?.tldShop ||
      rival.signals?.commerce_tld ||
      rival.signals?.genericBrandOnlyDomain ||
      rival.signals?.entityTypeMismatch ||
      rival.signals?.incompleteEntityName;
    if (!(chosenAuth && rivalNoisy) && !(chosen.signals?.domainExactKey && rivalNoisy)) {
      return {
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        score: chosen.score,
        candidates: ranked.slice(0, 6),
        reason: 'insufficient_margin',
        best: chosen,
        second: rival,
        resolveMin,
        ambiguityRisk: risk
      };
    }
  }

  // High confidence only with multiple strong signals
  const strong = [
    chosen.signals?.wikidataP856,
    chosen.signals?.strongConsensus,
    chosen.signals?.multiSourceConsensus,
    chosen.signals?.jsonLdMatch,
    chosen.signals?.aboutLanguage,
    chosen.signals?.domainExactKey && chosen.signals?.titleMentionsCompany,
    chosen.authoritativeCount >= 2
  ].filter(Boolean).length;

  let confidence = 'low';
  if (strong >= 2 || (chosen.signals?.wikidataP856 && chosen.signals?.homepageHeadMention)) {
    confidence = 'high';
  } else if (chosen.score >= resolveMin + 15 && (chosen.authoritativeCount >= 1 || chosen.signals?.domainExactKey)) {
    confidence = 'medium';
  } else {
    // Single weak resemblance → do not resolve as high; prefer ambiguous if risk high
    if (risk >= 50 && strong === 0 && !chosen.signals?.domainExactKey) {
      return {
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        score: chosen.score,
        candidates: ranked.slice(0, 6),
        reason: 'high_ambiguity_weak_evidence',
        best: chosen,
        resolveMin,
        ambiguityRisk: risk
      };
    }
    confidence = 'medium';
  }

  // Never emit high if affiliate penalties present
  if (confidence === 'high' && (chosen.signals?.tldShop || chosen.signals?.store_purpose || chosen.signals?.brandSuffixNoise)) {
    confidence = 'low';
    return {
      identityStatus: 'ambiguous',
      domain: null,
      confidence: 'low',
      score: chosen.score,
      candidates: ranked.slice(0, 6),
      reason: 'affiliate_conflict',
      best: chosen,
      resolveMin,
      ambiguityRisk: risk
    };
  }

  // Single common brand token (Vista, Mercury, Scale): abstain unless authoritative,
  // and never accept clear lookalike entity types (print shop, store, product microsite).
  if (tokens.length === 1 && COMMON_BRAND_TOKENS.has(tokens[0])) {
    const lookalikeType =
      chosen.signals?.print_brand ||
      chosen.signals?.store_purpose ||
      chosen.entityType === 'print_services' ||
      chosen.entityType === 'store' ||
      chosen.entityType === 'product';
    const authoritative =
      chosen.signals?.wikidataP856 ||
      (chosen.authoritativeCount || 0) >= 2 ||
      chosen.signals?.strongConsensus;
    if (lookalikeType || !authoritative) {
      return {
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        score: chosen.score,
        candidates: ranked.slice(0, 6),
        reason: 'short_common_name_ambiguous',
        best: chosen,
        second: rival,
        resolveMin,
        ambiguityRisk: risk
      };
    }
  }

  // Generic two-token brands (Human Capital, Chapter One): concatenated .com without
  // investment-firm evidence is too often a lookalike — abstain when a token-TLD rival exists.
  if (
    risk >= 40 &&
    tokens.length === 2 &&
    tokens.every((t) => COMMON_BRAND_TOKENS.has(t)) &&
    chosen.hostCore === key &&
    /\.com$/i.test(chosen.domain || '') &&
    !chosen.signals?.entityTypeMatch &&
    !chosen.signals?.wikidataP856
  ) {
    const tldRival = ranked.find((c) => c.domain !== chosen.domain && c.signals?.tokenAsTldMatch);
    if (tldRival || !chosen.signals?.aboutLanguage) {
      return {
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        score: chosen.score,
        candidates: ranked.slice(0, 6),
        reason: 'generic_name_com_lookalike',
        best: chosen,
        second: tldRival || rival,
        resolveMin,
        ambiguityRisk: risk
      };
    }
  }

  return {
    identityStatus: 'resolved',
    domain: chosen.domain,
    confidence,
    score: chosen.score,
    candidates: ranked.slice(0, 6),
    reason: 'selected',
    best: chosen,
    resolveMin,
    ambiguityRisk: risk
  };
}

export function domainMatchesExpected(got, expected, altDomains = []) {
  const g = hostOf(got);
  const targets = [expected, ...(altDomains || [])].map(hostOf).filter(Boolean);
  return targets.some((t) => g === t || g.endsWith(`.${t}`) || t.endsWith(`.${g}`));
}

export { COMMON_BRAND_TOKENS };
