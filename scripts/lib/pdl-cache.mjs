/**
 * Disk cache for PDL company enrich responses.
 * Keyed by canonical domain. Default TTL: 30 days.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomainHost } from './pdl-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '../../data/cache/pdl');
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function pdlCachePath(domain, cacheDir = DEFAULT_CACHE_DIR) {
  const host = normalizeDomainHost(domain).replace(/[^a-z0-9.-]/g, '_') || 'unknown';
  return path.join(cacheDir, `${host}.json`);
}

export function readPdlCache(domain, { cacheDir = DEFAULT_CACHE_DIR, ttlMs = DEFAULT_TTL_MS } = {}) {
  try {
    const file = pdlCachePath(domain, cacheDir);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fetchedAt = Date.parse(raw.fetchedAt || 0);
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePdlCache(domain, payload, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = pdlCachePath(domain, cacheDir);
    const record = {
      domain: normalizeDomainHost(domain),
      fetchedAt: new Date().toISOString(),
      source: 'peopledatalabs',
      ...payload
    };
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return record;
  } catch {
    return null;
  }
}

export { DEFAULT_CACHE_DIR, DEFAULT_TTL_MS };
