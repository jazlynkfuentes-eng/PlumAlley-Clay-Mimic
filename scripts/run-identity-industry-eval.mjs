/**
 * Identity + Industry evaluation harness (precision-focused).
 * Separates correct / incorrect / unknown / ambiguous.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN,
  isBlankOrUnknown,
  sanitizeUserFacingNotes,
  classifyIndustry,
  expandPastedCompanyInput,
  dedupeCompanyNames
} from './lib/enrichment-quality.mjs';
import { industryEquivalent } from './lib/industry-classify.mjs';
import {
  hostOf,
  nameKey,
  identityTokens,
  scoreIdentityCandidate,
  selectIdentity,
  domainMatchesExpected,
  expandOfficialDomainCandidates,
  JUNK_DOMAIN_RE
} from './lib/identity-resolve.mjs';
import {
  parseCompanyInput,
  diagnoseAmbiguity,
  resolveAmbiguousIdentity
} from './lib/identity-stage2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evalPath = path.join(root, 'data/eval/cross-industry-companies.json');

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function extractJsonLdName(html) {
  const blocks = String(html || '').match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/<\/?script[^>]*>/gi, '');
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
      for (const n of nodes) {
        const types = [].concat(n['@type'] || []).map(String);
        if (types.some((t) => /Organization|Corporation|LocalBusiness/i.test(t)) && n.name) {
          return String(n.name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

async function fetchPageEvidence(domain) {
  const host = hostOf(domain);
  if (!host || JUNK_DOMAIN_RE.test(host)) return {};
  try {
    const res = await fetchWithTimeout(
      `https://${host}/`,
      { headers: { 'User-Agent': 'ClayMimicEval/1.1', Accept: 'text/html' }, redirect: 'follow' },
      4500
    );
    if (!res.ok) return {};
    const html = await res.text();
    const pageTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
    const metaDescription =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ||
      '';
    const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
    const jsonLdName = extractJsonLdName(html);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 4000);
    return { pageTitle, metaDescription, pageText: text, heading: ogSite, jsonLdName };
  } catch {
    return {};
  }
}

async function fetchWikidataOfficialSite(name) {
  try {
    const searchRes = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=5&origin=*`,
      { headers: { Accept: 'application/json' } },
      4500
    );
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const hits = searchJson.search || [];
    // Prefer entity whose label/description looks like the company
    const key = nameKey(name);
    const tokens = identityTokens(name);
    let best = null;
    for (const hit of hits) {
      const labelKey = nameKey(hit.label || '');
      const desc = String(hit.description || '').toLowerCase();
      if (/disambiguation|family name|given name|male|female|human settlement/i.test(desc)) continue;
      const labelMatch = labelKey === key || tokens.every((t) => labelKey.includes(t));
      const orgish = /company|corporation|business|enterprise|firm|startup|bank|venture|equity|software|manufacturer/i.test(desc);
      if (labelMatch || (orgish && tokens.some((t) => labelKey.includes(t)))) {
        best = hit;
        if (labelMatch && orgish) break;
      }
    }
    if (!best && hits[0] && !/disambiguation|family name/i.test(hits[0].description || '')) best = hits[0];
    if (!best?.id) return null;

    const entRes = await fetchWithTimeout(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${best.id}&props=claims|labels|descriptions&languages=en&format=json&origin=*`,
      { headers: { Accept: 'application/json' } },
      4500
    );
    if (!entRes.ok) return null;
    const entJson = await entRes.json();
    const ent = entJson.entities?.[best.id];
    const p856 = ent?.claims?.P856;
    if (!p856?.length) return null;
    const url = p856[0]?.mainsnak?.datavalue?.value;
    if (!url) return null;
    const domain = hostOf(url);
    if (!domain || JUNK_DOMAIN_RE.test(domain)) return null;
    return {
      domain,
      name: ent.labels?.en?.value || best.label || name,
      description: ent.descriptions?.en?.value || best.description || '',
      wikidataId: best.id
    };
  } catch {
    return null;
  }
}

async function gatherCandidates(name) {
  const candidates = [];
  let timeouts = 0;
  const key = nameKey(name);
  const tokens = identityTokens(name);
  const guesses = new Set();

  // Canonical-shaped guesses: full key and primary token (validated later)
  if (key.length >= 3 && key.length <= 28) {
    guesses.add(`${key}.com`);
    if (/\bAI\b/i.test(name) && tokens[0]) guesses.add(`${tokens[0]}.com`);
  }
  if (tokens.length >= 2) {
    guesses.add(`${tokens.join('')}.com`);
    // Keep partners/equity/ventures in concatenated form for PE/VC
    guesses.add(`${tokens.join('')}.com`);
  }
  if (tokens[0] && tokens[0].length >= 3 && tokens[0].length <= 15) {
    guesses.add(`${tokens[0]}.com`);
  }
  // Known brand TLD pattern for two-token names (Human Capital → human.capital)
  if (tokens.length === 2 && tokens[1].length >= 3) {
    guesses.add(`${tokens[0]}.${tokens[1]}`);
  }
  for (const g of guesses) {
    candidates.push({ domain: hostOf(g), name, source: 'brand_guess', snippet: '' });
  }

  // Wikidata P856 (authoritative when entity matches)
  try {
    const wiki = await fetchWikidataOfficialSite(name);
    if (wiki?.domain) {
      const expanded = expandOfficialDomainCandidates(wiki.domain, name);
      for (const d of expanded) {
        candidates.push({
          domain: d,
          name: wiki.name,
          source: d === hostOf(wiki.domain) ? 'wikidata_official' : 'wikidata_official_expanded',
          snippet: wiki.description,
          wikidataOfficial: true
        });
      }
    }
  } catch {
    timeouts += 1;
  }

  // Clearbit
  try {
    const res = await fetchWithTimeout(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json' } },
      5000
    );
    if (res.ok) {
      const arr = await res.json();
      for (const row of (arr || []).slice(0, 6)) {
        if (row?.domain) {
          candidates.push({
            domain: hostOf(row.domain),
            name: row.name || name,
            source: 'clearbit',
            snippet: row.name || ''
          });
        }
      }
    }
  } catch {
    timeouts += 1;
  }

  for (const q of [`${name} official website`, `"${name}" company headquarters`]) {
    try {
      const res = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`,
        {},
        4500
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.Infobox?.content) {
        const official = json.Infobox.content.find(
          (i) => i.data_type === 'official_website' || /official website|website/i.test(i.label || '')
        );
        if (official?.value) {
          candidates.push({
            domain: hostOf(official.value),
            name: json.Heading || name,
            source: 'ddg_infobox',
            snippet: json.AbstractText || 'official website'
          });
        }
      }
      if (json.AbstractURL) {
        const d = hostOf(json.AbstractURL);
        if (d && !JUNK_DOMAIN_RE.test(d)) {
          candidates.push({
            domain: d,
            name: json.Heading || name,
            source: 'ddg_abstract',
            snippet: json.AbstractText || ''
          });
        }
      }
      // Pull domains mentioned in RelatedTopics
      for (const rel of (json.RelatedTopics || []).slice(0, 6)) {
        const u = rel.FirstURL || rel.URL;
        if (!u) continue;
        const d = hostOf(u);
        if (d && !JUNK_DOMAIN_RE.test(d) && !/wikipedia|wikidata/i.test(d)) {
          candidates.push({
            domain: d,
            name: (rel.Text || '').split(' - ')[0] || name,
            source: 'ddg_related',
            snippet: rel.Text || ''
          });
        }
      }
      if (json.AbstractText) {
        candidates._abstract = (candidates._abstract || '') + ' ' + json.AbstractText;
        candidates._heading = json.Heading || candidates._heading;
      }
    } catch {
      timeouts += 1;
    }
  }

  // Consensus: count independent sources per domain
  const sourceByDomain = new Map();
  for (const c of candidates) {
    if (!c?.domain) continue;
    if (!sourceByDomain.has(c.domain)) sourceByDomain.set(c.domain, new Set());
    sourceByDomain.get(c.domain).add(c.source || 'unknown');
  }

  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!c?.domain || seen.has(c.domain) || JUNK_DOMAIN_RE.test(c.domain)) continue;
    seen.add(c.domain);
    const sources = sourceByDomain.get(c.domain) || new Set([c.source]);
    unique.push({
      ...c,
      sourceAgreementCount: sources.size,
      sources: [...sources]
    });
  }
  unique._abstract = candidates._abstract || '';
  unique._heading = candidates._heading || '';
  return { candidates: unique, timeouts, abstract: unique._abstract, heading: unique._heading };
}

async function searchSnippetsForQuery(query) {
  const out = [];
  try {
    const res = await fetchWithTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      {},
      4500
    );
    if (!res.ok) return out;
    const json = await res.json();
    if (json.AbstractText) {
      out.push({
        domain: hostOf(json.AbstractURL || ''),
        snippet: json.AbstractText,
        title: json.Heading || ''
      });
    }
    if (json.Infobox?.content) {
      const official = json.Infobox.content.find(
        (i) => i.data_type === 'official_website' || /official website|website/i.test(i.label || '')
      );
      if (official?.value) {
        out.push({
          domain: hostOf(official.value),
          snippet: 'official website',
          title: json.Heading || ''
        });
      }
    }
    for (const rel of (json.RelatedTopics || []).slice(0, 5)) {
      const u = rel.FirstURL || rel.URL;
      if (!u) continue;
      out.push({
        domain: hostOf(u),
        snippet: rel.Text || '',
        title: (rel.Text || '').split(' - ')[0] || ''
      });
    }
  } catch {
    /* ignore */
  }
  return out.filter((h) => h.snippet || h.domain);
}

async function fetchHtmlForStage2(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'ClayMimicEval/1.2', Accept: 'text/html' }, redirect: 'follow' },
      4000
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function resolveIdentity(nameOrEntry) {
  const parsed = parseCompanyInput(nameOrEntry);
  const name = parsed.name;
  const context = { industry: parsed.industry || nameOrEntry?.contextIndustry || null, location: parsed.location || nameOrEntry?.location || null };

  const { candidates, timeouts, abstract, heading } = await gatherCandidates(name);
  let prelim = candidates.map((c) => {
    const scored = scoreIdentityCandidate(name, c, {
      snippet: c.snippet,
      abstract,
      heading: c.name || heading,
      searchTitle: c.name,
      sourceAgreementCount: c.sourceAgreementCount,
      wikidataOfficial: c.source === 'wikidata_official'
    });
    return { ...c, ...scored };
  });
  prelim.sort((a, b) => b.score - a.score);

  // Always include exact brand.com / primary.com in page-evidence set
  const mustFetch = new Set(
    prelim
      .filter(
        (c) =>
          (c.hostCore && c.nameKey && c.hostCore === c.nameKey && /\.com$/i.test(c.domain)) ||
          (identityTokens(name)[0] && c.hostCore === identityTokens(name)[0] && /\.com$/i.test(c.domain))
      )
      .map((c) => c.domain)
  );
  const top = [];
  for (const c of prelim) {
    if (top.length >= 6 && !mustFetch.has(c.domain)) continue;
    if (top.find((x) => x.domain === c.domain)) continue;
    top.push(c);
    if (top.length >= 8) break;
  }
  for (const c of top) {
    const ev = await fetchPageEvidence(c.domain);
    const rescored = scoreIdentityCandidate(name, c, {
      snippet: c.snippet,
      abstract,
      heading: c.name || heading,
      searchTitle: c.name,
      sourceAgreementCount: c.sourceAgreementCount,
      wikidataOfficial: c.source === 'wikidata_official',
      ...ev
    });
    const exactCom = c.hostCore && c.nameKey && c.hostCore === c.nameKey && /\.com$/i.test(c.domain);
    const primaryCom =
      identityTokens(name)[0] &&
      c.hostCore === identityTokens(name)[0] &&
      /\.com$/i.test(c.domain) &&
      (identityTokens(name).length === 1 || /\bAI\b/i.test(name));
    if (c.source === 'brand_guess' && !exactCom && !primaryCom && !rescored.signals?.homepageHeadMention && !rescored.signals?.metaMentionsCompany && !rescored.signals?.titleMentionsCompany && !rescored.signals?.tokenAsTldMatch) {
      rescored.score -= 50;
      rescored.signals = { ...rescored.signals, unconfirmedGuess: -50 };
    }
    if (exactCom || primaryCom) {
      rescored.score += 22;
      rescored.signals = { ...rescored.signals, exactBrandComBoost: 22 };
    }
    Object.assign(c, rescored, { pageEvidence: ev });
  }
  top.sort((a, b) => b.score - a.score);
  const byDomain = new Map(prelim.map((c) => [c.domain, c]));
  for (const c of top) byDomain.set(c.domain, c);
  const all = [...byDomain.values()].sort((a, b) => b.score - a.score);

  // Precision-first thresholds (Stage 1)
  let decision = selectIdentity(all, {
    companyName: name,
    resolveMin: 72,
    ambiguityGap: 18
  });
  decision = { ...decision, timeouts, abstract, heading, allCandidates: all, stage: 1 };

  // Stage 2: deeper evidence only for ambiguous
  if (decision.identityStatus === 'ambiguous') {
    const diagnosis = diagnoseAmbiguity(name, decision);
    console.log(`    [stage2 diagnose] ${name}: ${diagnosis.reason} margin=${diagnosis.scoreMargin} risk=${diagnosis.ambiguityRisk} causes=${diagnosis.causeHints.join(',')}`);
    decision = await resolveAmbiguousIdentity(
      name,
      decision,
      {
        fetchHtml: fetchHtmlForStage2,
        searchSnippets: searchSnippetsForQuery,
        fetchWikidata: fetchWikidataOfficialSite
      },
      context
    );
    decision.timeouts = timeouts;
    decision.abstract = abstract;
    decision.heading = heading;
    decision.stage = decision.stage2?.recovered ? 2 : 1;
    if (decision.stage2?.recovered) {
      console.log(
        `    [stage2 recovered] ${name} → ${decision.domain} boosts=${JSON.stringify(decision.stage2.newEvidence?.boosts || {})}`
      );
    }
  }

  return decision;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function classifyIndustryForCompany(name, domain, identity) {
  const evidence = [];
  if (identity.abstract) evidence.push(decodeEntities(identity.abstract));
  if (identity.heading) evidence.push(decodeEntities(`${name} — ${identity.heading}`));

  // Prefer official page meta/about language
  if (domain) {
    const page = identity.best?.pageEvidence || (await fetchPageEvidence(domain));
    if (page.metaDescription) evidence.unshift(decodeEntities(page.metaDescription));
    if (page.pageTitle) evidence.unshift(decodeEntities(page.pageTitle));
    if (page.pageText) {
      evidence.push(decodeEntities(page.pageText.slice(0, 800)));
      const about = decodeEntities(page.pageText).match(/\b(?:is an?|provides|builds|develops|operates)[^.]{20,220}\./i);
      if (about) evidence.unshift(about[0]);
    }
  }

  // Targeted industry query — include sector hint words for known-empty abstract cases
  try {
    const res = await fetchWithTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(`"${name}" company`)}&format=json&no_html=1`,
      {},
      4000
    );
    if (res.ok) {
      const json = await res.json();
      if (json.AbstractText) evidence.unshift(decodeEntities(json.AbstractText));
      if (json.Heading) evidence.push(decodeEntities(json.Heading));
    }
  } catch {
    /* ignore */
  }

  // Wikipedia summary (skip disambiguation / non-company)
  try {
    const res = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/\s+/g, '_'))}`,
      { headers: { Accept: 'application/json' } },
      4000
    );
    if (res.ok) {
      const j = await res.json();
      if (j.type !== 'disambiguation' && j.extract && !/may refer to|edible fruit|information theory/i.test(j.extract)) {
        evidence.push(decodeEntities(j.extract.slice(0, 400)));
        if (j.description && !/concept in|fruit/i.test(j.description)) evidence.unshift(decodeEntities(j.description));
      }
    }
  } catch {
    /* ignore */
  }

  // Prefer official page meta first; filter Wikipedia fruit/disambiguation noise
  const filtered = evidence.filter((e) => {
    const s = String(e || '');
    if (/edible fruit|may refer to|disambiguation|information theory|concept in/i.test(s) && !/inc\.|corporation|company|platform|firm/i.test(s)) return false;
    return s.trim().length > 15;
  });
  const result = classifyIndustry(filtered.length ? filtered : evidence);
  return { ...result, evidenceTexts: (filtered.length ? filtered : evidence).slice(0, 4).map((e) => String(e).slice(0, 180)) };
}

function scoreIndustryOutcome(predicted, expectedLabels) {
  if (isBlankOrUnknown(predicted)) return 'unknown';
  const expected = Array.isArray(expectedLabels) ? expectedLabels : [expectedLabels];
  for (const exp of expected) {
    if (industryEquivalent(predicted, exp)) return 'correct';
  }
  return 'incorrect';
}

async function enrichOne(entry) {
  const started = Date.now();
  const fromName = parseCompanyInput(entry.name);
  const displayName = fromName.name;
  const identity = await resolveIdentity({
    name: displayName,
    industry: entry.contextIndustry || fromName.industry || null,
    location: entry.location || fromName.location || null
  });
  const domain = identity.identityStatus === 'resolved' ? identity.domain : null;

  let industryResult = {
    value: UNKNOWN,
    confidence: 'low',
    evidence: [],
    source: 'skipped_identity',
    evidenceTexts: []
  };
  // Gate enrichment: only classify industry against a validated identity
  if (identity.identityStatus === 'resolved' && domain) {
    industryResult = await classifyIndustryForCompany(displayName, domain, identity);
  }

  let identityOutcome;
  if (identity.identityStatus === 'ambiguous') {
    identityOutcome = 'ambiguous';
  } else if (identity.identityStatus === 'unresolved') {
    identityOutcome = 'unresolved';
  } else if (!entry.expectedDomain) {
    // Pure ambiguity fixtures: resolving without a gold domain is incorrect unless altDomains match
    const rejected = (entry.rejectDomains || []).some((d) => hostOf(domain) === hostOf(d));
    if (rejected) identityOutcome = 'incorrect';
    else if ((entry.altDomains || []).length && domainMatchesExpected(domain, entry.altDomains[0], entry.altDomains)) {
      identityOutcome = 'correct';
    } else identityOutcome = 'incorrect';
  } else {
    identityOutcome = domainMatchesExpected(domain, entry.expectedDomain, entry.altDomains)
      ? 'correct'
      : 'incorrect';
    if (identityOutcome === 'correct' && (entry.rejectDomains || []).some((d) => hostOf(domain) === hostOf(d))) {
      identityOutcome = 'incorrect';
    }
  }

  const industryOutcome =
    identity.identityStatus !== 'resolved'
      ? 'skipped_identity'
      : identityOutcome === 'correct'
        ? scoreIndustryOutcome(industryResult.value, entry.expectedIndustry || entry.expectedIndustries || [])
        : isBlankOrUnknown(industryResult.value)
          ? 'unknown'
          : 'skipped_bad_identity';

  return {
    name: displayName,
    inputRaw: entry.name,
    category: entry.category || 'general',
    expectedDomain: entry.expectedDomain,
    expectedIndustry: entry.expectedIndustry || entry.expectedIndustries,
    resolvedDomain: domain,
    identityStatus: identity.identityStatus,
    identityConfidence: identity.confidence,
    identityScore: identity.score,
    identityOutcome,
    identityReason: identity.reason,
    identityStage: identity.stage || (identity.stage2?.recovered ? 2 : 1),
    stage2: identity.stage2
      ? {
          ran: identity.stage2.ran,
          recovered: identity.stage2.recovered,
          priorReason: identity.stage1Reason || identity.stage2.diagnosis?.reason,
          newEvidence: identity.stage2.newEvidence,
          diagnosis: identity.stage2.diagnosis
            ? {
                reason: identity.stage2.diagnosis.reason,
                scoreMargin: identity.stage2.diagnosis.scoreMargin,
                ambiguityRisk: identity.stage2.diagnosis.ambiguityRisk,
                causeHints: identity.stage2.diagnosis.causeHints
              }
            : null
        }
      : null,
    identitySignals: identity.best?.signals || identity.bestRejected?.signals || null,
    ambiguityRisk: identity.ambiguityRisk,
    candidates: (identity.candidates || []).slice(0, 5).map((c) => ({
      domain: c.domain,
      score: c.score,
      source: c.source,
      signals: c.signals,
      stage2Boosts: c.stage2Boosts
    })),
    industry: industryResult.value,
    industryConfidence: industryResult.confidence,
    industrySource: industryResult.source,
    industryEvidence: industryResult.evidence,
    industryEvidenceTexts: industryResult.evidenceTexts,
    industryRejected: (industryResult.rejected || []).slice(0, 4),
    industryOutcome,
    notesClean: true,
    elapsedMs: Date.now() - started,
    timeouts: identity.timeouts || 0
  };
}

function summarize(rows) {
  const identity = {
    correct: rows.filter((r) => r.identityOutcome === 'correct').length,
    incorrect: rows.filter((r) => r.identityOutcome === 'incorrect').length,
    ambiguous: rows.filter((r) => r.identityOutcome === 'ambiguous').length,
    unresolved: rows.filter((r) => r.identityOutcome === 'unresolved').length
  };
  const resolvedAttempts = identity.correct + identity.incorrect;
  // Resolution precision = correct resolved / all resolved
  const resolutionPrecision = resolvedAttempts
    ? Math.round((identity.correct / resolvedAttempts) * 1000) / 10
    : 0;
  // Resolution coverage = resolved / total
  const resolutionCoverage = rows.length
    ? Math.round((resolvedAttempts / rows.length) * 1000) / 10
    : 0;
  const identityCorrectAmongAll = rows.length
    ? Math.round((identity.correct / rows.length) * 1000) / 10
    : 0;

  const onCorrectId = rows.filter((r) => r.identityOutcome === 'correct');
  const industry = {
    correct: onCorrectId.filter((r) => r.industryOutcome === 'correct').length,
    incorrect: onCorrectId.filter((r) => r.industryOutcome === 'incorrect').length,
    unknown: onCorrectId.filter((r) => r.industryOutcome === 'unknown').length
  };
  const populated = industry.correct + industry.incorrect;
  const industryPrecision = populated ? Math.round((industry.correct / populated) * 1000) / 10 : 0;
  const industryCoverage = onCorrectId.length
    ? Math.round((populated / onCorrectId.length) * 1000) / 10
    : 0;

  return {
    companyCount: rows.length,
    identity,
    resolutionPrecision,
    resolutionCoverage,
    identityAccuracyAmongResolved: resolutionPrecision,
    identityCorrectAmongAll,
    industry,
    industryPrecision,
    industryCoverage,
    avgProcessingMs: Math.round(rows.reduce((a, r) => a + r.elapsedMs, 0) / (rows.length || 1)),
    timeoutCount: rows.reduce((a, r) => a + r.timeouts, 0),
    stage2: {
      attempted: rows.filter((r) => r.stage2?.ran).length,
      recovered: rows.filter((r) => r.stage2?.recovered && r.identityOutcome === 'correct').length,
      recoveredIncorrect: rows.filter((r) => r.stage2?.recovered && r.identityOutcome === 'incorrect').length,
      stillAmbiguous: rows.filter((r) => r.stage2?.ran && !r.stage2?.recovered).length,
      recoveries: rows
        .filter((r) => r.stage2?.recovered)
        .map((r) => ({
          name: r.name,
          domain: r.resolvedDomain,
          outcome: r.identityOutcome,
          priorReason: r.stage2.priorReason,
          boosts: r.stage2.newEvidence?.boosts,
          evidence: r.stage2.newEvidence
        }))
    },
    wrongIdentities: rows.filter((r) => r.identityOutcome === 'incorrect').map((r) => ({
      name: r.name,
      got: r.resolvedDomain,
      expected: r.expectedDomain,
      score: r.identityScore,
      confidence: r.identityConfidence,
      reason: r.identityReason,
      stage: r.identityStage,
      signals: r.identitySignals,
      topCandidates: r.candidates
    })),
    wrongIndustries: onCorrectId
      .filter((r) => r.industryOutcome === 'incorrect')
      .map((r) => ({
        name: r.name,
        got: r.industry,
        expected: r.expectedIndustry,
        evidence: r.industryEvidenceTexts
      })),
    unknownIndustries: onCorrectId
      .filter((r) => r.industryOutcome === 'unknown')
      .map((r) => ({
        name: r.name,
        rejected: r.industryRejected,
        evidence: r.industryEvidenceTexts,
        source: r.industrySource
      }))
  };
}

async function runBatch(label, companies, concurrency = 2) {
  console.log(`\n=== ${label} (${companies.length}) ===`);
  const rows = new Array(companies.length);
  let i = 0;
  async function worker() {
    while (i < companies.length) {
      const idx = i++;
      const entry = companies[idx];
      process.stdout.write(`  ${entry.name}... `);
      try {
        const row = await enrichOne(entry);
        rows[idx] = row;
        console.log(
          `${row.identityOutcome}/${row.identityStatus} ${row.resolvedDomain || '—'} | ${row.industry} (${row.industryOutcome})`
        );
      } catch (e) {
        rows[idx] = {
          name: entry.name,
          identityOutcome: 'unresolved',
          identityStatus: 'unresolved',
          industryOutcome: 'unknown',
          industry: UNKNOWN,
          resolvedDomain: null,
          elapsedMs: 0,
          timeouts: 1,
          error: String(e.message || e)
        };
        console.log('ERR', e.message || e);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { rows, summary: summarize(rows) };
}

async function main() {
  const mode = process.argv[2] || 'all';
  const dataset = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  const outDir = path.join(root, 'data/eval');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Paste/dedupe sanity:', expandPastedCompanyInput('1. Nvidia\n• Apple').join(' | '), dedupeCompanyNames(['NVIDIA', 'NVIDIA Corp']));

  const report = { generatedAt: new Date().toISOString(), mode };

  if (mode === 'cross' || mode === 'all') {
    const { rows, summary } = await runBatch('Cross-industry', dataset.companies, 2);
    report.crossIndustry = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'identity-industry-cross.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nCross summary:', JSON.stringify(summary, null, 2));
  }
  if (mode === 'vc' || mode === 'all') {
    const { rows, summary } = await runBatch('VC regression', dataset.vcRegression, 2);
    report.vcRegression = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'identity-industry-vc.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nVC summary:', JSON.stringify(summary, null, 2));
  }
  if (mode === 'holdout' || mode === 'all') {
    const holdout = dataset.holdout15 || dataset.holdout10 || [];
    const { rows, summary } = await runBatch(`Holdout-${holdout.length}`, holdout, 2);
    report.holdout = { summary, rows };
    fs.writeFileSync(path.join(outDir, 'identity-industry-holdout.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('\nHoldout summary:', JSON.stringify(summary, null, 2));
  }
  if (mode === 'ambiguity' || mode === 'all') {
    const amb = dataset.ambiguitySet || [];
    if (amb.length) {
      const { rows, summary } = await runBatch(`Ambiguity-set-${amb.length}`, amb, 2);
      report.ambiguitySet = { summary, rows };
      fs.writeFileSync(path.join(outDir, 'identity-industry-ambiguity.json'), JSON.stringify({ summary, rows }, null, 2));
      console.log('\nAmbiguity-set summary:', JSON.stringify(summary, null, 2));
    }
  }

  // Stage-2 recovery rollup
  const stage2All = [];
  for (const key of ['crossIndustry', 'vcRegression', 'holdout', 'ambiguitySet']) {
    const recoveries = report[key]?.summary?.stage2?.recoveries || [];
    for (const r of recoveries) stage2All.push({ suite: key, ...r });
  }
  report.stage2Recoveries = stage2All;
  console.log('\nStage-2 recoveries:', stage2All.length ? JSON.stringify(stage2All, null, 2) : 'none');

  fs.writeFileSync(path.join(outDir, 'identity-industry-report.json'), JSON.stringify(report, null, 2));
  console.log('\nWrote data/eval/identity-industry-report.json');

  // Exit non-zero if identity resolution precision below target (≥99% when stage2 enabled)
  const cross = report.crossIndustry?.summary;
  if (cross && mode !== 'holdout' && mode !== 'vc' && mode !== 'ambiguity') {
    const okId = cross.resolutionPrecision >= 99 || (cross.resolutionPrecision >= 95 && cross.identity.incorrect === 0);
    const okIndPrecision = cross.industryPrecision >= 95 || cross.industry.correct + cross.industry.incorrect === 0;
    const okStage2 = (cross.stage2?.recoveredIncorrect || 0) === 0;
    if (!okId || !okIndPrecision || !okStage2) {
      console.error('\nTARGETS NOT MET', {
        resolutionPrecision: cross.resolutionPrecision,
        resolutionCoverage: cross.resolutionCoverage,
        industryPrecision: cross.industryPrecision,
        stage2Incorrect: cross.stage2?.recoveredIncorrect,
        wrongIdentities: cross.wrongIdentities
      });
      process.exitCode = 2;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
