/**
 * Pipeline-level entity-type guard for company resolution.
 *
 * Reject-first: only drop a Wikidata candidate when P31 positively identifies a
 * non-organization class (person, place, phenomenon, creative work, event, or
 * media/broadcast without media context). Empty P31 and unlisted legal-form
 * classes are allowed so thin Wikidata company entries are not discarded.
 *
 * Keep the QID sets in sync with the copy in index.html.
 */
export const ENTITY_TYPE_GUARD_VERSION = 'entity-type-v2';
export const WIKI_FETCH_ATTEMPTS = 3;

/** Organization-like P31 classes. Any hit → accept, even if a reject class is also present. */
export const ACCEPT_ORG_P31 = new Set([
  // Generic org / company / legal form
  'Q43229', // organization
  'Q4830453', // business
  'Q6881511', // enterprise
  'Q783794', // company
  'Q167037', // corporation
  'Q891723', // public company
  'Q1589009', // privately held company
  'Q134161', // joint-stock company
  'Q219577', // holding company
  'Q15042660', // limited liability company
  'Q18624259', // limited company
  'Q6832945', // private company limited by shares
  'Q42262', // Gesellschaft mit beschränkter Haftung (GmbH)
  'Q1542714', // Aktiengesellschaft
  'Q166280', // limited partnership
  'Q15850065', // limited liability partnership
  'Q117351609', // limited liability company (United States)
  'Q728425', // partnership
  'Q1341618', // professional partnership
  'Q57653825', // private limited company
  'Q16726425', // S.A. (corporation)
  // Financial services
  'Q22687', // bank
  'Q56859', // commercial bank
  'Q730038', // financial institution
  'Q2481236', // investment company
  'Q161718', // investment management company
  'Q1947591', // asset management
  'Q536518', // investment fund
  'Q6502418', // investment fund
  'Q1236912', // hedge fund
  'Q12319666', // hedge fund
  'Q778575', // hedge fund
  'Q15980864', // venture capital firm
  'Q1687336', // venture capital
  'Q1236839', // venture capital company
  'Q592888', // private equity firm
  'Q5152546', // private equity
  'Q2143354', // insurance company
  'Q1637408', // credit union
  'Q613142', // law firm
  'Q181289', // law firm
  // Government / public
  'Q327333', // government agency
  'Q2659904', // government organization
  'Q35798', // government
  'Q7188', // government
  'Q417662', // government agency
  'Q16334295', // government body
  'Q11204', // ministry
  'Q760074', // municipal corporation
  'Q3567216', // local government
  'Q1419105', // municipal government
  // Nonprofit / foundation / institution
  'Q163740', // nonprofit organization
  'Q157031', // foundation
  'Q79913', // non-governmental organization
  'Q708676', // charitable organization
  'Q4466083', // charitable organization
  'Q48204', // voluntary association
  'Q31855', // research institute
  'Q1664720', // institute
  'Q780597', // church congregation
  'Q210167', // religious organization
  'Q33506', // museum
  'Q16917', // hospital
  // Education
  'Q3918', // university
  'Q38723', // higher education institution
  'Q875538', // public university
  'Q23002054', // private university
  'Q2385804', // educational institution
  'Q4671277', // academic institution
  'Q9826', // high school
  'Q189004', // college
  'Q15936437', // research university
  'Q1371037', // vocational school
  'Q1321960', // school
  'Q118865' // faculty
]);

/** Non-organization P31 classes. Reject unless an accept-org class is also present. */
export const REJECT_NON_ORG_P31 = new Set([
  // Human / person
  'Q5', // human
  'Q215627', // person
  'Q95074', // fictional character
  'Q15632617', // fictional human
  'Q22808320', // Wikimedia human name disambiguation page
  // Geographic
  'Q532', // village
  'Q3957', // town
  'Q515', // city
  'Q486972', // human settlement
  'Q56061', // administrative territorial entity
  'Q82794', // geographic region
  'Q3624078', // sovereign state
  'Q6256', // country
  'Q23442', // island
  'Q4022', // river
  'Q8502', // mountain
  'Q23397', // lake
  'Q34763', // peninsula
  'Q123705', // neighborhood
  'Q5084', // hamlet
  'Q7930989', // city/town
  'Q2221906', // geographic location
  'Q618123', // geographical object
  'Q27096213', // geographic entity
  'Q5107', // continent
  'Q15642541', // human-geographic territorial entity
  // Physical / natural / abstract concept
  'Q1293220', // physical phenomenon
  'Q28732711', // physical process
  'Q937228', // phenomenon
  'Q3695082', // tropical cyclone
  'Q318', // astronomical object
  'Q3863', // asteroid
  'Q523', // star
  'Q11276', // globular cluster
  'Q24676', // globular cluster
  'Q11862829', // academic discipline
  'Q21201', // physics
  'Q29028649', // economic concept
  'Q151885', // concept
  'Q331042', // scientific theory
  'Q427581', // intangible asset
  'Q23958852', // knowledge
  // Creative work
  'Q17537576', // creative work
  'Q11424', // film
  'Q24856', // film series
  'Q5398426', // television series
  'Q15416', // television program
  'Q482994', // album
  'Q7366', // song
  'Q2188189', // musical work
  'Q7725634', // literary work
  'Q47461344', // written work
  'Q571', // book
  'Q49032', // chapter
  'Q1980247', // chapter
  'Q7725310', // encyclopedic article
  'Q13442814', // scholarly article
  'Q191067', // article
  'Q838948', // work of art
  // Historical / legal event
  'Q1190554', // occurrence
  'Q1656682', // event
  'Q186165', // event
  'Q198', // war
  'Q2334719', // legal case
  'Q107597582', // legal proceeding
  'Q4504495', // historical event
  'Q483247', // sports competition
  // Wiki meta pages (not companies)
  'Q4167410', // Wikimedia disambiguation page
  'Q13406463', // Wikimedia list article
  'Q19389637', // Wikimedia list
  'Q4167836', // Wikimedia category
  'Q14204246', // Wikimedia project page
  'Q11266439' // Wikimedia template
]);

/**
 * Media / broadcast P31. Reject unless the row's contact-title context indicates
 * a media company, or an accept-org class is also present.
 */
export const REJECT_MEDIA_P31 = new Set([
  'Q11032', // newspaper
  'Q41298', // magazine
  'Q1616075', // radio station
  'Q2001305', // television channel
  'Q15242410', // television network
  'Q15265344', // radio network
  'Q4438141', // radio program
  'Q16145126', // broadcasting
  'Q2085381', // publisher
  'Q11033', // mass media
  'Q98924065' // media company
]);

/**
 * Media carve-out is an explicit keyword check against Contact / Source title
 * (`personTitle`) only — not company name and not Industry (Industry is often
 * blank at resolve time). Logged on resolutionDebug.mediaContext.
 */
export const MEDIA_CONTEXT_FIELD = 'personTitle';
export const MEDIA_CONTEXT_KEYWORDS = [
  'media', 'news', 'broadcast', 'publisher', 'publishing', 'press', 'editorial'
];

const NAME_STOP = new Set([
  'the', 'and', 'of', 'a', 'an', 'for', 'in', 'on', 'at', 'to',
  'inc', 'llc', 'ltd', 'corp', 'co', 'plc', 'gmbh', 'lp', 'llp'
]);

export function qidFrom(value) {
  const s = String(value || '').trim();
  const m = s.match(/Q(\d+)/i);
  return m ? `Q${m[1]}` : '';
}

export function inspectMediaCompanyContext(personTitle) {
  const haystack = String(personTitle || '');
  const lower = haystack.toLowerCase();
  const matchedKeyword = MEDIA_CONTEXT_KEYWORDS.find((keyword) => {
    if (keyword === 'press') return /\bpress\b/i.test(lower);
    return new RegExp(`\\b${keyword}`, 'i').test(lower);
  }) || null;
  return {
    field: MEDIA_CONTEXT_FIELD,
    haystack,
    matchedKeyword: matchedKeyword || 'no match',
    matched: !!matchedKeyword
  };
}

/** Boolean wrapper: Contact/Source title only. Extra args are ignored. */
export function isMediaCompanyContext(personTitle) {
  return inspectMediaCompanyContext(personTitle).matched;
}

/**
 * Human-readable resolutionDebug line. Does not change accept/reject logic.
 * Three outcomes are always distinct strings: accept / allow_unknown / reject.
 */
export function formatEntityTypeDebug(type, extra = {}) {
  const p31 = (type?.matched || type?.p31 || []).filter(Boolean);
  const p31Label = p31.length ? p31.join(', ') : '';
  if (!type) {
    return { outcome: 'allow_unknown', summary: 'allow_unknown — missing classification' };
  }
  if (type.decision === 'retry_needed') {
    if (type.reason === 'rate_limited' || extra.rateLimited) {
      return { outcome: 'retry_needed', summary: 'retry_needed — rate limited' };
    }
    return { outcome: 'retry_needed', summary: `retry_needed — ${type.reason || extra.transientReason || 'transient error'}` };
  }
  if (type.decision === 'accept') {
    if (type.reason === 'p31_organization' || type.reason === 'p31_org_subclass') {
      const via = type.via === 'subclass' ? ' (via subclass)' : '';
      return { outcome: 'accept', summary: `accept — org class matched: ${p31Label}${via}` };
    }
    if (type.reason === 'p31_media_with_context') {
      const kw = extra.mediaKeyword && extra.mediaKeyword !== 'no match' ? extra.mediaKeyword : 'matched';
      return { outcome: 'accept', summary: `accept — media class with contact-title keyword: ${kw}` };
    }
    return { outcome: 'accept', summary: `accept — org class matched: ${p31Label || type.reason}` };
  }
  if (type.decision === 'allow_unknown') {
    if (type.reason === 'no_p31') {
      return { outcome: 'allow_unknown', summary: 'allow_unknown — empty P31' };
    }
    if (type.reason === 'p31_unlisted') {
      return { outcome: 'allow_unknown', summary: `allow_unknown — unlisted legal form: ${type.p31.join(', ')}` };
    }
    return { outcome: 'allow_unknown', summary: `allow_unknown — ${type.reason}` };
  }
  const rejectIds = (type.matched || type.p31 || []).join(', ');
  const via = type.via === 'subclass' ? ' (via subclass)' : '';
  return { outcome: 'reject', summary: `reject — ${rejectIds} is a reject class${via}` };
}

/**
 * @param {string[]} instanceIds P31 QIDs
 * @param {{ mediaContext?: boolean }} [opts]
 * @returns {{ decision: 'accept'|'reject'|'allow_unknown', reason: string, p31: string[], matched: string[]|null }}
 */
export function classifyEntityTypeFromP31(instanceIds, opts = {}) {
  const p31 = [...new Set((instanceIds || []).map(qidFrom).filter(Boolean))];
  if (!p31.length) {
    return { decision: 'allow_unknown', reason: 'no_p31', p31, matched: null };
  }

  const orgHits = p31.filter((id) => ACCEPT_ORG_P31.has(id));
  if (orgHits.length) {
    return { decision: 'accept', reason: 'p31_organization', p31, matched: orgHits };
  }

  const mediaHits = p31.filter((id) => REJECT_MEDIA_P31.has(id));
  const rejectHits = p31.filter((id) => REJECT_NON_ORG_P31.has(id));

  if (mediaHits.length && !rejectHits.length) {
    if (opts.mediaContext) {
      return { decision: 'accept', reason: 'p31_media_with_context', p31, matched: mediaHits };
    }
    return { decision: 'reject', reason: 'p31_media', p31, matched: mediaHits };
  }

  if (rejectHits.length) {
    return { decision: 'reject', reason: 'p31_non_organization', p31, matched: rejectHits };
  }

  if (mediaHits.length) {
    if (opts.mediaContext) {
      return { decision: 'accept', reason: 'p31_media_with_context', p31, matched: mediaHits };
    }
    return { decision: 'reject', reason: 'p31_media', p31, matched: mediaHits };
  }

  return { decision: 'allow_unknown', reason: 'p31_unlisted', p31, matched: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function wikiBackoffMs(attemptIndex) {
  return Math.round(350 * (3 ** attemptIndex) + Math.random() * 250);
}

/**
 * Fetch JSON with 3 attempts and exponential backoff on 429 / 5xx / network errors.
 * Never conflates a rate-limit with an empty-P31 allow_unknown.
 */
export async function fetchWithBackoff(url, { label = 'wiki', attempts = WIKI_FETCH_ATTEMPTS, fetchImpl, backoffMs } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const wait = backoffMs || wikiBackoffMs;
  let last = { json: null, error: 'transient', status: 0 };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch(url);
      if (res.status === 429) {
        last = { json: null, error: 'rate_limited', status: 429 };
        console.warn(`[wiki] 429 on ${label}, retry ${i + 1}/${attempts}`);
        if (i < attempts - 1) await sleep(wait(i));
        continue;
      }
      if (res.status >= 500) {
        last = { json: null, error: 'transient', status: res.status };
        console.warn(`[wiki] HTTP ${res.status} on ${label}, retry ${i + 1}/${attempts}`);
        if (i < attempts - 1) await sleep(wait(i));
        continue;
      }
      if (!res.ok) {
        return { json: null, error: 'http', status: res.status };
      }
      return { json: await res.json(), error: null, status: res.status };
    } catch (e) {
      last = { json: null, error: 'transient', status: 0, message: String(e?.message || e) };
      console.warn(`[wiki] ${label} failed:`, last.message);
      if (i < attempts - 1) await sleep(wait(i));
    }
  }
  return last;
}

const subclassLevelCache = new Map();

export function clearEntityTypeSubclassCache() {
  subclassLevelCache.clear();
}

function parentsFromEntityClaims(entity) {
  return (entity?.claims?.P279 || [])
    .map((c) => qidFrom(c?.mainsnak?.datavalue?.value?.id))
    .filter(Boolean);
}

async function fetchDirectParents(ids, opts = {}) {
  const unique = [...new Set(ids.map(qidFrom).filter(Boolean))];
  if (!unique.length) return {};
  if (typeof opts.fetchDirectParents === 'function') {
    return opts.fetchDirectParents(unique);
  }
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${unique.join('|')}&props=claims&format=json&origin=*`;
  const result = await fetchWithBackoff(url, { label: `p279:${unique.slice(0, 3).join(',')}`, fetchImpl: opts.fetchImpl });
  if (result.error) {
    const err = new Error(result.error);
    err.code = result.error;
    err.status = result.status;
    throw err;
  }
  const out = {};
  for (const id of unique) {
    out[id] = parentsFromEntityClaims(result.json?.entities?.[id]);
  }
  return out;
}

/**
 * BFS P279 levels for a QID. levels[0] = direct parents.
 * Cached per QID. Stops early once a known accept/reject/media root appears.
 */
export async function getSubclassLevels(qid, opts = {}) {
  const id = qidFrom(qid);
  if (!id) return [];
  if (!opts.forceFresh && subclassLevelCache.has(id)) return subclassLevelCache.get(id);
  if (opts.subclassLevels && opts.subclassLevels[id]) {
    const injected = opts.subclassLevels[id];
    subclassLevelCache.set(id, injected);
    return injected;
  }
  const levels = [];
  let frontier = [id];
  const seen = new Set([id]);
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    let parentsById;
    try {
      parentsById = await fetchDirectParents(frontier, opts);
    } catch (e) {
      e.partialLevels = levels;
      throw e;
    }
    const level = [];
    const next = [];
    for (const fid of frontier) {
      for (const parent of parentsById[fid] || []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        level.push(parent);
        next.push(parent);
      }
    }
    if (!level.length) break;
    levels.push(level);
    if (level.some((sid) => ACCEPT_ORG_P31.has(sid) || REJECT_MEDIA_P31.has(sid) || REJECT_NON_ORG_P31.has(sid))) {
      break;
    }
    frontier = next;
  }
  subclassLevelCache.set(id, levels);
  return levels;
}

function decisionFromNearestHits(hits, p31, opts = {}) {
  if (!hits.length) {
    return { decision: 'allow_unknown', reason: 'p31_unlisted', p31, matched: null, via: 'subclass' };
  }
  const minD = Math.min(...hits.map((h) => h.depth));
  const at = hits.filter((h) => h.depth === minD);
  const org = at.filter((h) => h.kind === 'org').map((h) => h.matched);
  if (org.length) {
    return {
      decision: 'accept',
      reason: 'p31_org_subclass',
      p31,
      matched: [...new Set(org)],
      via: 'subclass',
      subclassDepth: minD
    };
  }
  const media = at.filter((h) => h.kind === 'media').map((h) => h.matched);
  const reject = at.filter((h) => h.kind === 'reject').map((h) => h.matched);
  if (media.length && !reject.length) {
    if (opts.mediaContext) {
      return {
        decision: 'accept',
        reason: 'p31_media_with_context',
        p31,
        matched: [...new Set(media)],
        via: 'subclass',
        subclassDepth: minD
      };
    }
    return {
      decision: 'reject',
      reason: 'p31_media',
      p31,
      matched: [...new Set(media)],
      via: 'subclass',
      subclassDepth: minD
    };
  }
  if (reject.length) {
    return {
      decision: 'reject',
      reason: 'p31_non_organization',
      p31,
      matched: [...new Set(reject)],
      via: 'subclass',
      subclassDepth: minD
    };
  }
  if (media.length) {
    if (opts.mediaContext) {
      return {
        decision: 'accept',
        reason: 'p31_media_with_context',
        p31,
        matched: [...new Set(media)],
        via: 'subclass',
        subclassDepth: minD
      };
    }
    return {
      decision: 'reject',
      reason: 'p31_media',
      p31,
      matched: [...new Set(media)],
      via: 'subclass',
      subclassDepth: minD
    };
  }
  return { decision: 'allow_unknown', reason: 'p31_unlisted', p31, matched: null, via: 'subclass' };
}

/**
 * Exact-match fast path, then nearest-ancestor P279 walk for unlisted P31s.
 * Does not change classifyEntityTypeFromP31 semantics for exact hits.
 */
export async function classifyEntityTypeWithSubclassWalk(instanceIds, opts = {}) {
  const exact = classifyEntityTypeFromP31(instanceIds, opts);
  if (exact.decision !== 'allow_unknown' || exact.reason !== 'p31_unlisted') {
    return { ...exact, via: exact.reason === 'no_p31' ? 'empty_p31' : 'exact' };
  }
  const hits = [];
  try {
    for (const id of exact.p31) {
      const levels = await getSubclassLevels(id, opts);
      for (let d = 0; d < levels.length; d++) {
        for (const sid of levels[d]) {
          if (ACCEPT_ORG_P31.has(sid)) hits.push({ depth: d + 1, kind: 'org', matched: sid, from: id });
          if (REJECT_MEDIA_P31.has(sid)) hits.push({ depth: d + 1, kind: 'media', matched: sid, from: id });
          if (REJECT_NON_ORG_P31.has(sid)) hits.push({ depth: d + 1, kind: 'reject', matched: sid, from: id });
        }
      }
    }
  } catch (e) {
    const code = e?.code === 'rate_limited' ? 'rate_limited' : 'transient';
    return {
      decision: 'retry_needed',
      reason: code,
      p31: exact.p31,
      matched: null,
      via: 'subclass'
    };
  }
  return decisionFromNearestHits(hits, exact.p31, opts);
}

export function distinctiveNameTokens(name, extra = []) {
  const blob = [name, ...(extra || [])].filter(Boolean).join(' ').toLowerCase();
  const parts = blob.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = parts.filter((t) => t.length > 2 && !NAME_STOP.has(t));
  if (!tokens.length) {
    const collapsed = parts.join('');
    if (collapsed.length >= 2) tokens.push(collapsed);
  }
  return [...new Set(tokens)];
}

/**
 * Token overlap between a company name (plus optional contact/title context)
 * and a resolved page's title / meta description / H1.
 */
export function namePageTokenOverlap(companyName, page = {}, extraContext = []) {
  const tokens = distinctiveNameTokens(companyName, extraContext);
  const blob = [page.title, page.meta, page.description, page.h1]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const hits = tokens.filter((t) => blob.includes(t));
  return {
    tokens,
    hits,
    overlap: hits.length,
    zero: tokens.length > 0 && hits.length === 0,
    checked: tokens.length > 0 && blob.trim().length > 0
  };
}

export function parsePageIdentityFields(html) {
  const text = String(html || '');
  const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const meta = (
    text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ||
    ''
  ).trim();
  const og = (
    text.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    ''
  ).trim();
  const h1 = (text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, meta: meta || og, h1 };
}
