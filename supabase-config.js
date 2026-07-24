/**
 * Supabase config for Plum Alley Clay Mimic.
 *
 * PRODUCTION (Vercel): set these Environment Variables for Production, then Redeploy:
 *   VITE_SUPABASE_URL      = https://xxxx.supabase.co
 *   VITE_SUPABASE_ANON_KEY = eyJhbGciOi... (anon / publishable key)
 * Build runs scripts/write-supabase-config.mjs and overwrites this file on deploy.
 *
 * Login is email + 6-digit OTP only (no magic link, no Google/GitHub).
 *
 * Supabase → Authentication → Email Templates → Magic Link
 * Replace the body with OTP-only content, e.g.:
 *   <h2>Your login code</h2>
 *   <p><strong>{{ .Token }}</strong></p>
 *   <p>Enter this code in the app. It expires shortly.</p>
 * Do NOT include {{ .ConfirmationURL }} — that creates a clickable magic link.
 *
 * LOCAL: paste once in the in-app setup form (localStorage), or put values below.
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
