/**
 * Supabase config for Plum Alley Clay Mimic.
 *
 * Setup (once):
 * 1. Create a free project at https://supabase.com
 * 2. Authentication → Providers → Email enabled; disable "Confirm email" if you want
 *    faster magic-link UX (optional). Keep magic link template default.
 * 3. Authentication → URL Configuration → add Site URL + Redirect URLs:
 *      http://localhost:5173
 *      http://127.0.0.1:5173
 *      (and your deployed origin when you have one)
 * 4. SQL Editor → run supabase/schema.sql
 * 5. Project Settings → API → copy Project URL + anon public key into the fields below
 *    (or paste them once in the in-app setup form — they are stored in localStorage).
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
