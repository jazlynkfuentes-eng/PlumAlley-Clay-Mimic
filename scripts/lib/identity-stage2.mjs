/**
 * Stage-2 ambiguity resolver.
 * Runs ONLY when primary identityStatus === "ambiguous".
 * Collects deeper evidence; never lowers resolveMin / margin / junk checks.
 */

import {
  hostOf,
  nameKey,
  stripLegal,
  identityTokens,
  ambiguityRisk,
  scoreIdentityCandidate,
  selectIdentity,
  inferEntityType,
  JUNK_DOMAIN_RE,
  COMMON_BRAND_TOKENS
} from './identity-resolve.mjs';

/** Parse optional context: "Name | Industry" or { name, industry, location }. */
export function parseCompanyInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const name = String(raw.name || raw.company || '').trim();
    return {
      name,
      industry: raw.industry || raw.contextIndustry || raw.sector || null,
      location: raw.location || raw.hq || null,
      rawContext: raw
    };
  }
  const s = String(raw || '').trim();
  if (!s) return { name: '', industry: null, location: null };
  const pipe = s.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  if (pipe.length >= 2) {
    return {
      name: pipe[0],
      industry: pipe.slice(1).join(' | '),
      location: null
    };
  }
  return { name: s, industry: null, location: null };
}

const POSITIVE_SIGNAL_KEYS = new Set([
  'domainExactKey',
  'tokenCoverage',
  'distinctiveTokenHits',
  'candidateNameExact',
  'jsonLdMatch',
  'titleMentionsCompany',
  'aboutLanguage',
  'wikidataP856',
  'multiSourceConsensus',
  'strongConsensus',
  'entityTypeMatch',
  'tokenAsTldMatch',
  'homepageHeadMention',
  'copyrightMatch',
  'fullNameConfirmed',
  'descriptionFullName',
  'contextIndustryAlign',
  'deepAboutConfirm',
  'stage2Consensus'
]);

/**
 * Structured diagnosis for an ambiguous Stage-1 decision.
 */
export function diagnoseAmbiguity(companyName, stage1 = {}) {
  const candidates = stage1.candidates || stage1.allCandidates || [];
  const ranked = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = stage1.best || ranked[0] || null;
  const second = stage1.second || ranked.find((c) => c.domain !== best?.domain) || null;
  const margin = best && second ? Math.round((best.score - second.score) * 10) / 10 : null;

  const causeHints = [];
  const reason = stage1.reason || 'unknown';
  if (reason === 'insufficient_margin') causeHints.push('competing_real_companies_or_close_scores');
  if (reason === 'generic_name_com_lookalike') causeHints.push('generic_company_name');
  if (reason === 'high_ambiguity_weak_evidence') causeHints.push('weak_homepage_metadata');
  if (reason === 'below_resolve_threshold') causeHints.push('insufficient_search_results_or_weak_scores');
  if ((stage1.ambiguityRisk || 0) >= 50) causeHints.push('high_ambiguity_risk_short_or_common_name');
  if (!ranked.some((c) => c.signals?.wikidataP856)) causeHints.push('wikidata_gaps');
  if (ranked.every((c) => !c.pageEvidence?.pageText && !c.signals?.homepageHeadMention)) {
    causeHints.push('inaccessible_or_empty_pages');
  }

  return {
    normalizedName: stripLegal(companyName),
    nameKey: nameKey(companyName),
    reason,
    ambiguityRisk: stage1.ambiguityRisk ?? ambiguityRisk(companyName, ranked.length),
    resolveMin: stage1.resolveMin,
    scoreMargin: margin,
    causeHints,
    candidates: ranked.slice(0, 8).map((c) => {
      const signals = c.signals || {};
      const positive = {};
      const negative = {};
      for (const [k, v] of Object.entries(signals)) {
        if (typeof v !== 'number') continue;
        if (v > 0) positive[k] = v;
        if (v < 0) negative[k] = v;
      }
      return {
        domain: c.domain,
        score: c.score,
        source: c.source,
        sources: c.sources || (c.source ? [c.source] : []),
        sourceAgreementCount: c.sourceAgreementCount || (c.sources ? c.sources.length : 1),
        entityType: c.entityType || signals.entityType || null,
        positiveEvidence: positive,
        negativeEvidence: negative,
        hasPageEvidence: !!(c.pageEvidence?.pageTitle || c.pageEvidence?.pageText)
      };
    }),
    sourcesConsulted: [
      ...new Set(ranked.flatMap((c) => c.sources || (c.source ? [c.source] : [])))
    ]
  };
}

function fullNamePresent(companyName, text) {
  const nk = stripLegal(companyName);
  if (!nk || nk.length < 3) return false;
  const blob = String(text || '').toLowerCase();
  if (blob.includes(nk)) return true;
  // Allow flexible whitespace / punctuation between tokens
  const tokens = identityTokens(companyName);
  if (tokens.length < 2) return blob.includes(tokens[0] || '');
  const flex = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-.,&]*');
  return new RegExp(flex, 'i').test(blob);
}

function contextAligns(contextIndustry, evidenceBlob, entityType) {
  if (!contextIndustry) return false;
  const ctx = String(contextIndustry).toLowerCase();
  const blob = String(evidenceBlob || '').toLowerCase();
  const type = String(entityType || '').toLowerCase();

  const checks = [
    { re: /private equity|\bpe\b|buyout/i, types: /investment_firm|private_equity/i },
    { re: /venture capital|\bvc\b|seed fund/i, types: /investment_firm|venture/i },
    { re: /fintech|payments|neobank/i, types: /company|fintech/i },
    { re: /software|saas|enterprise/i, types: /company/i },
    { re: /biotech|biotechnology|pharma/i, types: /company/i },
    { re: /consumer|retail|apparel/i, types: /company|store|retail/i }
  ];
  for (const { re, types } of checks) {
    if (re.test(ctx) && (re.test(blob) || types.test(type))) return true;
  }
  // Generic: context words appear in evidence
  const words = ctx.split(/\s+/).filter((w) => w.length > 3);
  const hits = words.filter((w) => blob.includes(w)).length;
  return words.length > 0 && hits / words.length >= 0.5;
}

/**
 * Apply Stage-2 evidence boosts. Additive only; does not remove primary penalties.
 */
export function applyStage2Boosts(companyName, scored, deep = {}, context = {}) {
  const boosts = {};
  let add = 0;
  const blob = [
    deep.pageTitle,
    deep.metaDescription,
    deep.pageText,
    deep.aboutText,
    deep.companyText,
    deep.teamText,
    deep.contactText,
    deep.jsonLdName,
    deep.copyright,
    deep.canonicalUrl,
    deep.searchSnippets,
    scored.snippet,
    scored.pageEvidence?.pageText
  ]
    .filter(Boolean)
    .join(' \n ');

  if (fullNamePresent(companyName, blob)) {
    add += 40;
    boosts.fullNameConfirmed = 40;
  }

  const descBlob = [deep.metaDescription, deep.searchSnippets, scored.snippet].filter(Boolean).join(' ');
  if (fullNamePresent(companyName, descBlob) && /is an?|private equity|venture capital|company that|headquartered/i.test(descBlob)) {
    add += 28;
    boosts.descriptionFullName = 28;
  }

  if (deep.aboutText && fullNamePresent(companyName, deep.aboutText)) {
    add += 22;
    boosts.deepAboutConfirm = 22;
  }

  if (deep.jsonLdName && nameKey(deep.jsonLdName) === nameKey(companyName)) {
    add += 20;
    boosts.stage2JsonLdExact = 20;
  }

  const entity = inferEntityType({
    pageTitle: deep.pageTitle,
    metaDescription: deep.metaDescription,
    pageText: blob.slice(0, 2500),
    snippet: deep.searchSnippets
  });
  const wantsInvest = /\b(capital|ventures?|partners|equity|private equity|venture)\b/i.test(companyName);
  if (wantsInvest && entity.type === 'investment_firm') {
    add += 30;
    boosts.stage2EntityTypeMatch = 30;
  } else if (wantsInvest && (entity.type === 'print_services' || entity.type === 'store' || entity.type === 'product')) {
    add -= 40;
    boosts.stage2EntityTypeMismatch = -40;
  }

  if (context.industry && contextAligns(context.industry, blob, entity.type)) {
    add += 35;
    boosts.contextIndustryAlign = 35;
  }

  const sources = new Set([
    ...(scored.sources || []),
    scored.source,
    ...(deep.supportingSources || [])
  ].filter(Boolean));
  // Collapse wiki variants
  const independent = new Set(
    [...sources].map((s) => {
      if (/wikidata/i.test(s)) return 'wikidata';
      if (/ddg|duck/i.test(s)) return 'search';
      if (/clearbit/i.test(s)) return 'clearbit';
      if (/brand_guess/i.test(s)) return 'guess';
      if (/page|about|deep/i.test(s)) return 'homepage';
      return s;
    })
  );
  independent.delete('guess');
  if (independent.size >= 3) {
    add += 30;
    boosts.stage2Consensus = 30;
  } else if (independent.size >= 2 && boosts.fullNameConfirmed) {
    add += 18;
    boosts.stage2DualSourceFullName = 18;
  }

  const newScore = scored.score + add;
  return {
    ...scored,
    score: newScore,
    entityType: entity.type,
    stage2Boosts: boosts,
    stage2Add: add,
    signals: { ...scored.signals, ...boosts, entityType: entity.type },
    authoritativeCount: (scored.authoritativeCount || 0) + (boosts.stage2Consensus ? 1 : 0) + (boosts.fullNameConfirmed && boosts.deepAboutConfirm ? 1 : 0),
    deepEvidence: deep
  };
}

/**
 * Build targeted identity search queries for ambiguous names (no industry assumption).
 */
export function stage2SearchQueries(companyName, context = {}) {
  const name = String(companyName || '').trim();
  const q = [
    `"${name}" official website`,
    `"${name}" company`,
    `"${name}" venture capital`,
    `"${name}" private equity`,
    `"${name}" startup`,
    `"${name}" headquarters`
  ];
  if (context.industry) {
    q.unshift(`"${name}" ${context.industry}`);
  }
  if (context.location) {
    q.push(`"${name}" ${context.location}`);
  }
  return [...new Set(q)].slice(0, 8);
}

const DEEP_PATHS = ['/', '/about', '/about-us', '/company', '/team', '/contact'];

/**
 * Fetch deeper site evidence for one domain.
 * deps.fetchHtml(url) => Promise<string|null>
 */
export async function fetchDeepSiteEvidence(domain, deps = {}) {
  const host = hostOf(domain);
  if (!host || JUNK_DOMAIN_RE.test(host)) return {};
  const fetchHtml = deps.fetchHtml;
  if (!fetchHtml) return {};

  const out = {
    pageTitle: '',
    metaDescription: '',
    pageText: '',
    aboutText: '',
    companyText: '',
    teamText: '',
    contactText: '',
    jsonLdName: '',
    copyright: '',
    canonicalUrl: '',
    supportingSources: ['deep_homepage']
  };

  for (const path of DEEP_PATHS) {
    try {
      const html = await fetchHtml(`https://${host}${path === '/' ? '/' : path}`);
      if (!html) continue;
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
      const meta =
        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ||
        '';
      const canonical =
        html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1] ||
        '';
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 5000);
      const copyright = text.match(/©\s*\d{4}[^.]{0,80}/i)?.[0] || '';

      if (path === '/') {
        out.pageTitle = title;
        out.metaDescription = meta;
        out.pageText = text;
        out.canonicalUrl = canonical;
        out.copyright = copyright;
        // JSON-LD
        const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of blocks) {
          try {
            const raw = block.replace(/<\/?script[^>]*>/gi, '');
            const data = JSON.parse(raw);
            const nodes = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
            for (const n of nodes) {
              const types = [].concat(n['@type'] || []).map(String);
              if (types.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) && n.name) {
                out.jsonLdName = String(n.name);
              }
            }
          } catch {
            /* ignore */
          }
        }
      } else if (/about/i.test(path)) {
        out.aboutText = `${title} ${meta} ${text}`.slice(0, 4000);
        out.supportingSources.push('deep_about');
      } else if (/company/i.test(path)) {
        out.companyText = `${title} ${meta} ${text}`.slice(0, 3000);
        out.supportingSources.push('deep_company');
      } else if (/team/i.test(path)) {
        out.teamText = `${title} ${meta} ${text}`.slice(0, 2000);
        out.supportingSources.push('deep_team');
      } else if (/contact/i.test(path)) {
        out.contactText = `${title} ${meta} ${text}`.slice(0, 2000);
        out.supportingSources.push('deep_contact');
      }
    } catch {
      /* path best-effort */
    }
  }
  return out;
}

/**
 * Stage-2 resolve: only upgrades ambiguous → resolved when SAME primary thresholds clear.
 *
 * deps: {
 *   fetchHtml(url),
 *   searchSnippets(query) => Promise<{domain?, snippet, title}[]>,
 *   fetchWikidata?(name) => Promise<{domain, name, description}|null>
 * }
 */
export async function resolveAmbiguousIdentity(companyName, stage1, deps = {}, context = {}) {
  if (!stage1 || stage1.identityStatus !== 'ambiguous') {
    return { ...stage1, stage2: { ran: false, reason: 'not_ambiguous' } };
  }

  const diagnosis = diagnoseAmbiguity(companyName, stage1);
  const tokens = identityTokens(companyName);
  const risk = diagnosis.ambiguityRisk;

  // Short/common names without context: still investigate, but require stronger Stage-2 proof
  const shortAmbiguous =
    risk >= 50 &&
    tokens.length <= 2 &&
    tokens.every((t) => COMMON_BRAND_TOKENS.has(t) || t.length <= 5) &&
    !context.industry;

  const pool = [...(stage1.allCandidates || stage1.candidates || [])]
    .filter((c) => c?.domain && !JUNK_DOMAIN_RE.test(c.domain))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Additional search snippets
  let searchHits = [];
  const queries = stage2SearchQueries(companyName, context);
  if (typeof deps.searchSnippets === 'function') {
    for (const q of queries.slice(0, 5)) {
      try {
        const hits = await deps.searchSnippets(q);
        for (const h of hits || []) {
          searchHits.push({ ...h, query: q });
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Wikidata refresh
  let wiki = null;
  if (typeof deps.fetchWikidata === 'function') {
    try {
      wiki = await deps.fetchWikidata(companyName);
    } catch {
      /* ignore */
    }
  }

  const rescored = [];
  for (const c of pool) {
    let deep = {};
    if (typeof deps.fetchHtml === 'function') {
      deep = await fetchDeepSiteEvidence(c.domain, deps);
    }
    // Attach search snippets mentioning this domain or full name
    const relatedSnips = searchHits
      .filter((h) => {
        const d = hostOf(h.domain || '');
        return (d && (d === c.domain || c.domain.endsWith(d) || d.endsWith(c.domain))) ||
          fullNamePresent(companyName, `${h.title || ''} ${h.snippet || ''}`);
      })
      .map((h) => h.snippet || h.title || '')
      .filter(Boolean);
    deep.searchSnippets = relatedSnips.join(' · ').slice(0, 1500);

    if (wiki?.domain && hostOf(wiki.domain) === hostOf(c.domain)) {
      deep.supportingSources = [...(deep.supportingSources || []), 'wikidata'];
      deep.wikidataDescription = wiki.description || '';
      if (wiki.description) deep.searchSnippets = `${wiki.description} ${deep.searchSnippets || ''}`;
    }

    // Merge domain mentions from search into source counts
    const domainHits = searchHits.filter((h) => hostOf(h.domain || '') === c.domain);
    if (domainHits.length) {
      deep.supportingSources = [...(deep.supportingSources || []), 'search'];
    }

    // Re-score with primary scorer using deeper page fields first
    const primaryRescore = scoreIdentityCandidate(
      companyName,
      {
        ...c,
        source: c.source,
        sourceAgreementCount: Math.max(c.sourceAgreementCount || 1, new Set([...(c.sources || []), ...(deep.supportingSources || [])]).size)
      },
      {
        snippet: c.snippet,
        pageTitle: deep.pageTitle || c.pageEvidence?.pageTitle,
        metaDescription: deep.metaDescription || c.pageEvidence?.metaDescription,
        pageText: [deep.pageText, deep.aboutText, deep.companyText].filter(Boolean).join(' ').slice(0, 5000),
        jsonLdName: deep.jsonLdName || c.pageEvidence?.jsonLdName,
        wikidataOfficial: !!(c.signals?.wikidataP856 || wiki?.domain === c.domain),
        sourceAgreementCount: Math.max(c.sourceAgreementCount || 1, (deep.supportingSources || []).length)
      }
    );

    const withBoosts = applyStage2Boosts(
      companyName,
      { ...c, ...primaryRescore, sources: [...new Set([...(c.sources || []), c.source, ...(deep.supportingSources || [])].filter(Boolean))] },
      deep,
      context
    );
    rescored.push(withBoosts);
  }

  // Ensure wikidata domain is in pool if missing
  if (wiki?.domain && !rescored.find((c) => c.domain === hostOf(wiki.domain))) {
    const d = hostOf(wiki.domain);
    if (d && !JUNK_DOMAIN_RE.test(d)) {
      const deep = typeof deps.fetchHtml === 'function' ? await fetchDeepSiteEvidence(d, deps) : {};
      deep.supportingSources = ['wikidata', ...(deep.supportingSources || [])];
      deep.searchSnippets = wiki.description || '';
      const base = scoreIdentityCandidate(
        companyName,
        { domain: d, name: wiki.name || companyName, source: 'wikidata_official', sourceAgreementCount: 2 },
        {
          pageTitle: deep.pageTitle,
          metaDescription: deep.metaDescription,
          pageText: deep.pageText,
          jsonLdName: deep.jsonLdName,
          wikidataOfficial: true,
          snippet: wiki.description
        }
      );
      rescored.push(
        applyStage2Boosts(
          companyName,
          { ...base, domain: d, source: 'wikidata_official', sources: ['wikidata'] },
          deep,
          context
        )
      );
    }
  }

  rescored.sort((a, b) => b.score - a.score);

  // SAME primary thresholds — never lower (base resolveMin 72; selectIdentity adds risk again)
  const decision = selectIdentity(rescored, {
    companyName,
    resolveMin: 72,
    ambiguityGap: 18
  });

  // Extra guard for short ambiguous names without context: require Stage-2 full-name + consensus
  if (decision.identityStatus === 'resolved' && shortAmbiguous) {
    const best = decision.best || rescored[0];
    const hasFull = best?.stage2Boosts?.fullNameConfirmed || best?.signals?.fullNameConfirmed;
    const hasConsensus = best?.stage2Boosts?.stage2Consensus || best?.signals?.strongConsensus || best?.signals?.wikidataP856;
    if (!(hasFull && hasConsensus)) {
      return {
        ...stage1,
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        reason: 'stage2_short_name_still_ambiguous',
        stage2: {
          ran: true,
          recovered: false,
          diagnosis,
          queries,
          topAfter: rescored.slice(0, 4).map((c) => ({
            domain: c.domain,
            score: c.score,
            boosts: c.stage2Boosts
          })),
          blockReason: 'short_common_name_needs_full_name_and_consensus'
        },
        candidates: rescored.slice(0, 6),
        allCandidates: rescored
      };
    }
  }

  const recovered = decision.identityStatus === 'resolved';

  // Require meaningful NEW Stage-2 evidence — never promote on score jitter alone
  if (recovered) {
    const best = decision.best || rescored.find((c) => c.domain === decision.domain) || rescored[0];
    const b = best?.stage2Boosts || {};
    const meaningful =
      b.fullNameConfirmed ||
      b.deepAboutConfirm ||
      b.descriptionFullName ||
      b.stage2Consensus ||
      b.stage2DualSourceFullName ||
      b.stage2EntityTypeMatch ||
      b.contextIndustryAlign ||
      b.stage2JsonLdExact;
    if (!meaningful) {
      return {
        ...stage1,
        identityStatus: 'ambiguous',
        domain: null,
        confidence: 'low',
        reason: 'stage2_no_new_evidence',
        stage1Reason: stage1.reason,
        stage2: {
          ran: true,
          recovered: false,
          diagnosis,
          queries,
          topAfter: rescored.slice(0, 4).map((c) => ({
            domain: c.domain,
            score: c.score,
            boosts: c.stage2Boosts
          })),
          blockReason: 'resolved_without_stage2_evidence_boosts'
        },
        candidates: rescored.slice(0, 6),
        allCandidates: rescored
      };
    }
  }

  return {
    ...decision,
    timeouts: stage1.timeouts || 0,
    abstract: stage1.abstract,
    heading: stage1.heading,
    stage1Reason: stage1.reason,
    stage2: {
      ran: true,
      recovered,
      diagnosis,
      queries,
      newEvidence: recovered
        ? {
            domain: decision.domain,
            boosts: decision.best?.stage2Boosts || rescored.find((c) => c.domain === decision.domain)?.stage2Boosts || {},
            score: decision.score,
            confidence: decision.confidence,
            priorReason: stage1.reason,
            priorBest: stage1.best?.domain || stage1.candidates?.[0]?.domain,
            priorSecond: stage1.second?.domain || stage1.candidates?.[1]?.domain
          }
        : null,
      topAfter: rescored.slice(0, 4).map((c) => ({
        domain: c.domain,
        score: c.score,
        boosts: c.stage2Boosts
      }))
    },
    allCandidates: rescored
  };
}

export { POSITIVE_SIGNAL_KEYS, fullNamePresent };
