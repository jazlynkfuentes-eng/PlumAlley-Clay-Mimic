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
 *   Redirect URLs (add ALL of these):
 *                  https://plum-alley-clay-mimic.vercel.app
 *                  https://plum-alley-clay-mimic.vercel.app/**
 *                  http://localhost:5173
 *                  http://localhost:5173/**
 *                  http://localhost:3000
 *                  http://localhost:3000/**
 *
 * Magic-link emails use emailRedirectTo = window.location.origin from the app.
 * If that origin is NOT in Redirect URLs, Supabase falls back to Site URL
 * (which used to be localhost:3000 — that is why old links opened localhost).
 * Always request a NEW link after changing these settings.
 * LOCAL: paste once in the in-app setup form (localStorage), or put values below.
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
