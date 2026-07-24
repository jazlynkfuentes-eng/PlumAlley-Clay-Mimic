/**
 * Writes supabase-config.js from environment variables at deploy time.
 * Used by Vercel buildCommand so Production env vars land in the static site.
 *
 * Expected env (any of these name pairs):
 *   VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
 *   SUPABASE_URL + SUPABASE_ANON_KEY
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outFile = path.join(root, 'supabase-config.js');

const url = (
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ''
).trim();

const anonKey = (
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  ''
).trim();

const contents = `/**
 * AUTO-GENERATED at build time by scripts/write-supabase-config.mjs
 * Do not edit by hand on Vercel — set Project → Settings → Environment Variables:
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY
 * (Production environment), then Redeploy.
 *
 * Local: leave blank and use the in-app setup form, or set the same env vars
 * before running: node scripts/write-supabase-config.mjs
 */
window.PLUM_SUPABASE = {
  url: ${JSON.stringify(url)},
  anonKey: ${JSON.stringify(anonKey)}
};
`;

fs.writeFileSync(outFile, contents, 'utf8');

if (!url || !anonKey) {
  console.warn(
    '[write-supabase-config] WARNING: url or anon key is empty. ' +
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables (Production), then redeploy. ' +
      'Until then, visitors must paste keys in the in-app setup form.'
  );
} else {
  console.log('[write-supabase-config] Wrote supabase-config.js', {
    url,
    hasAnonKey: true,
    anonKeyLength: anonKey.length
  });
}
