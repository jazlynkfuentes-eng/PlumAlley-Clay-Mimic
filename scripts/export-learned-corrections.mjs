/**
 * Snapshots the shared learned-corrections store (Vercel KV) into
 * data/learned-corrections.json as a committed backup.
 *
 * KV is the source of truth at runtime; this file is only a periodic export and
 * the seed shipped to browsers before the first sync completes.
 *
 * Usage:
 *   node scripts/export-learned-corrections.mjs
 *   node scripts/export-learned-corrections.mjs https://your-deployment.vercel.app
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'learned-corrections.json');

const base = (process.argv[2] || process.env.PLUM_SITE_URL || 'https://plum-alley-clay-mimic.vercel.app')
  .replace(/\/$/, '');
const endpoint = `${base}/api/learned-corrections`;

console.log('[export] GET', endpoint);
const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
if (!res.ok) {
  console.error(`[export] failed: HTTP ${res.status}`);
  process.exit(1);
}
const json = await res.json();
if (!json || !Array.isArray(json.corrections)) {
  console.error('[export] unexpected payload:', JSON.stringify(json).slice(0, 300));
  process.exit(1);
}
if (json.kv === false) {
  console.warn('[export] warning: endpoint reports KV not configured —', json.reason || 'unknown');
}

// Tombstones ship alongside the corrections. This file is re-read by every
// browser on load, so without them a deleted correction would come back.
const store = {
  version: 1,
  updatedAt: json.updatedAt || new Date().toISOString(),
  corrections: json.corrections,
  deletions: Array.isArray(json.deletions) ? json.deletions : []
};
fs.writeFileSync(OUT, JSON.stringify(store, null, 2) + '\n', 'utf8');
console.log(`[export] wrote ${store.corrections.length} correction(s) and ${store.deletions.length} deletion(s) to data/learned-corrections.json`);

spawnSync(process.execPath, [path.join(__dirname, 'write-learned-corrections-config.mjs')], {
  cwd: ROOT,
  stdio: 'inherit'
});
console.log('[export] commit data/learned-corrections.json to refresh the shipped backup');
