/**
 * Shared learned-corrections store backed by Vercel KV (Upstash Redis).
 *
 *   GET  /api/learned-corrections  -> { version, updatedAt, corrections[], kv }
 *   POST /api/learned-corrections  -> merges and returns the updated store
 *
 * POST accepts either shape:
 *   { companyName, domain, source }        a single correction
 *   { corrections: [...], updatedAt }      a whole store (client push / migration)
 *
 * Merging happens server-side, keyed by companyKey with newest updatedAt winning,
 * so two browsers writing at once can't clobber each other's entries.
 *
 * Intentionally dependency-free: the project builds with a no-op install step,
 * so this talks to the Upstash REST API with plain fetch.
 */

const KV_KEY = 'plum:learned-corrections:v1';

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
  return { version: 1, updatedAt: null, corrections: [] };
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
  return [...byKey.values()].sort((a, b) =>
    String(a.companyName).localeCompare(String(b.companyName))
  );
}

async function readStore(cfg) {
  const raw = await kvCommand(cfg, ['GET', KV_KEY]);
  if (!raw) return emptyStore();
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && Array.isArray(parsed.corrections)) {
      return {
        version: 1,
        updatedAt: parsed.updatedAt || null,
        corrections: parsed.corrections.map(sanitizeCorrection).filter(Boolean)
      };
    }
  } catch (_) { /* corrupt value — start clean rather than 500 */ }
  return emptyStore();
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    if (!incoming.length) {
      res.status(400).json({ ok: false, reason: 'No valid corrections in request' });
      return;
    }

    try {
      const existing = await readStore(cfg);
      const merged = mergeCorrections(existing.corrections, incoming);
      const store = {
        version: 1,
        updatedAt: new Date().toISOString(),
        corrections: merged
      };
      await kvCommand(cfg, ['SET', KV_KEY, JSON.stringify(store)]);
      res.status(200).json({ ok: true, kv: true, count: merged.length, ...store });
    } catch (err) {
      console.error('[learned-corrections] POST failed', err);
      res.status(500).json({ ok: false, kv: true, reason: err.message || 'KV write failed' });
    }
    return;
  }

  res.status(405).json({ ok: false, reason: 'Method not allowed' });
}
