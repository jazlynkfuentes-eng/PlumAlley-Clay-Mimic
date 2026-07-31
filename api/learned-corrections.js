/**
 * Shared learned-corrections store backed by Vercel KV (Upstash Redis).
 *
 *   GET    /api/learned-corrections  -> { version, updatedAt, corrections[], deletions[], kv }
 *   POST   /api/learned-corrections  -> merges and returns the updated store
 *   DELETE /api/learned-corrections?companyKey=acme  -> tombstones and returns the store
 *
 * POST accepts either shape:
 *   { companyName, domain, source }        a single correction
 *   { corrections: [...], updatedAt }      a whole store (client push / migration)
 *
 * Merging happens server-side, keyed by companyKey with newest write winning,
 * so two browsers writing at once can't clobber each other's entries.
 *
 * Deletes are tombstones, not plain removals. Every browser keeps its own
 * localStorage copy and pushes anything the shared store is missing, so a
 * removed row would otherwise be resurrected by the next device to load. A
 * tombstone records *when* the delete happened, which lets a later re-teach of
 * the same company win on timestamp and revive the entry.
 *
 * Intentionally dependency-free: the project builds with a no-op install step,
 * so this talks to the Upstash REST API with plain fetch.
 */

const KV_KEY = 'plum:learned-corrections:v1';

// Tombstones are tiny, but keeping them forever grows the payload every browser
// downloads on load. A year is far longer than any realistic gap between a
// device's last sync and its next one.
const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function kvCommand(cfg, command) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!res.ok) {
    throw new Error(`KV ${command[0]} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const json = await res.json();
  if (json && json.error) throw new Error(`KV ${command[0]} failed: ${json.error}`);
  return json ? json.result : null;
}

function emptyStore() {
  return { version: 1, updatedAt: null, corrections: [], deletions: [] };
}

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .split('/')[0]
    .replace(/[^a-z0-9.-]/g, '');
}

function sanitizeCorrection(raw) {
  const companyName = String(raw?.companyName || '').trim();
  const companyKey = companyKeyNorm(raw?.companyKey || companyName);
  const domain = normalizeDomain(raw?.domain);
  if (!companyName || !companyKey || !domain || !domain.includes('.')) return null;
  const now = new Date().toISOString();
  return {
    companyName,
    companyKey,
    domain,
    source: String(raw?.source || 'manual').slice(0, 40),
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || now
  };
}

function sanitizeDeletion(raw) {
  const companyKey = companyKeyNorm(raw?.companyKey || raw?.companyName);
  if (!companyKey) return null;
  return { companyKey, deletedAt: raw?.deletedAt || new Date().toISOString() };
}

function mergeCorrections(base, incoming) {
  const byKey = new Map();
  for (const c of base) byKey.set(c.companyKey, c);
  for (const c of incoming) {
    const prev = byKey.get(c.companyKey);
    if (!prev) {
      byKey.set(c.companyKey, c);
      continue;
    }
    const prevTs = Date.parse(prev.updatedAt || prev.createdAt || 0) || 0;
    const nextTs = Date.parse(c.updatedAt || c.createdAt || 0) || 0;
    if (nextTs >= prevTs) byKey.set(c.companyKey, { ...c, createdAt: prev.createdAt || c.createdAt });
  }
  return [...byKey.values()];
}

function mergeDeletions(base, incoming) {
  const byKey = new Map();
  for (const d of [...base, ...incoming]) {
    const prev = byKey.get(d.companyKey);
    const prevTs = Date.parse(prev?.deletedAt || 0) || 0;
    const nextTs = Date.parse(d.deletedAt || 0) || 0;
    if (!prev || nextTs > prevTs) byKey.set(d.companyKey, d);
  }
  return [...byKey.values()];
}

/**
 * Settle corrections against tombstones. Newest write wins per company, so
 * re-teaching a company after someone deleted it revives the entry and clears
 * the tombstone, while deleting after a teach keeps it gone.
 */
function reconcile(corrections, deletions) {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const tombs = new Map(
    deletions
      .filter(d => (Date.parse(d.deletedAt || 0) || 0) >= cutoff)
      .map(d => [d.companyKey, d])
  );
  const kept = [];
  for (const c of corrections) {
    const tomb = tombs.get(c.companyKey);
    if (!tomb) {
      kept.push(c);
      continue;
    }
    const cTs = Date.parse(c.updatedAt || c.createdAt || 0) || 0;
    const dTs = Date.parse(tomb.deletedAt || 0) || 0;
    if (cTs > dTs) {
      tombs.delete(c.companyKey);
      kept.push(c);
    }
  }
  kept.sort((a, b) => String(a.companyName).localeCompare(String(b.companyName)));
  return { corrections: kept, deletions: [...tombs.values()] };
}

async function readStore(cfg) {
  const raw = await kvCommand(cfg, ['GET', KV_KEY]);
  if (!raw) return emptyStore();
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && Array.isArray(parsed.corrections)) {
      const settled = reconcile(
        parsed.corrections.map(sanitizeCorrection).filter(Boolean),
        (Array.isArray(parsed.deletions) ? parsed.deletions : []).map(sanitizeDeletion).filter(Boolean)
      );
      return { version: 1, updatedAt: parsed.updatedAt || null, ...settled };
    }
  } catch (_) { /* corrupt value — start clean rather than 500 */ }
  return emptyStore();
}

async function writeStore(cfg, { corrections, deletions }) {
  const store = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...reconcile(corrections, deletions)
  };
  await kvCommand(cfg, ['SET', KV_KEY, JSON.stringify(store)]);
  return store;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const cfg = kvConfig();

  if (req.method === 'GET') {
    // Without KV configured, behave like an empty shared store so the app still
    // runs on localStorage instead of erroring on every page load.
    if (!cfg) {
      res.status(200).json({ ...emptyStore(), kv: false, reason: 'KV not configured' });
      return;
    }
    try {
      const store = await readStore(cfg);
      res.status(200).json({ ...store, kv: true, count: store.corrections.length });
    } catch (err) {
      console.error('[learned-corrections] GET failed', err);
      res.status(200).json({ ...emptyStore(), kv: false, reason: err.message || 'KV read failed' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (!cfg) {
      res.status(503).json({ ok: false, kv: false, reason: 'KV not configured for this deployment' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body) {
      res.status(400).json({ ok: false, reason: 'Invalid JSON body' });
      return;
    }

    const incoming = (Array.isArray(body.corrections) ? body.corrections : [body])
      .map(sanitizeCorrection)
      .filter(Boolean);
    // A client pushing its whole store also forwards tombstones it knows about,
    // so a delete made while offline still propagates on the next sync.
    const incomingDeletions = (Array.isArray(body.deletions) ? body.deletions : [])
      .map(sanitizeDeletion)
      .filter(Boolean);
    if (!incoming.length && !incomingDeletions.length) {
      res.status(400).json({ ok: false, reason: 'No valid corrections in request' });
      return;
    }

    try {
      const existing = await readStore(cfg);
      const store = await writeStore(cfg, {
        corrections: mergeCorrections(existing.corrections, incoming),
        deletions: mergeDeletions(existing.deletions, incomingDeletions)
      });
      res.status(200).json({ ok: true, kv: true, count: store.corrections.length, ...store });
    } catch (err) {
      console.error('[learned-corrections] POST failed', err);
      res.status(500).json({ ok: false, kv: true, reason: err.message || 'KV write failed' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    if (!cfg) {
      res.status(503).json({ ok: false, kv: false, reason: 'KV not configured for this deployment' });
      return;
    }

    // Accept the key from the query string or a JSON body — DELETE bodies are
    // awkward enough that callers reasonably reach for either.
    const body = await readJsonBody(req).catch(() => null);
    const fromQuery = (() => {
      try {
        const url = new URL(req.url, 'http://localhost');
        return url.searchParams.get('companyKey') || url.searchParams.get('companyName') || '';
      } catch (_) {
        return '';
      }
    })();
    const keys = [
      ...(Array.isArray(body?.companyKeys) ? body.companyKeys : []),
      body?.companyKey,
      body?.companyName,
      fromQuery
    ]
      .map(companyKeyNorm)
      .filter(Boolean);

    if (!keys.length) {
      res.status(400).json({ ok: false, reason: 'Missing companyKey' });
      return;
    }

    try {
      const existing = await readStore(cfg);
      const now = new Date().toISOString();
      const removed = existing.corrections.filter(c => keys.includes(c.companyKey)).length;
      const store = await writeStore(cfg, {
        corrections: existing.corrections.filter(c => !keys.includes(c.companyKey)),
        deletions: mergeDeletions(existing.deletions, keys.map(companyKey => ({ companyKey, deletedAt: now })))
      });
      res.status(200).json({ ok: true, kv: true, removed, count: store.corrections.length, ...store });
    } catch (err) {
      console.error('[learned-corrections] DELETE failed', err);
      res.status(500).json({ ok: false, kv: true, reason: err.message || 'KV delete failed' });
    }
    return;
  }

  res.status(405).json({ ok: false, reason: 'Method not allowed' });
}
