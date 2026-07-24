/**
 * Supabase config for Plum Alley Clay Mimic.
 *
 * PRODUCTION (Vercel): set these Environment Variables for Production, then Redeploy:
 *   VITE_SUPABASE_URL      = https://xxxx.supabase.co
 *   VITE_SUPABASE_ANON_KEY = eyJhbGciOi... (anon public key)
 * Build runs scripts/write-supabase-config.mjs and overwrites this file on deploy.
 *
 * Live Site URL for Supabase Auth (Authentication → URL Configuration):
 *   Site URL:      https://plum-alley-clay-mimic.vercel.app
 *   Redirect URLs: https://plum-alley-clay-mimic.vercel.app
 *                  http://localhost:5173
 *                  http://127.0.0.1:5173
 *
 * LOCAL: paste once in the in-app setup form (localStorage), or put values below.
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
