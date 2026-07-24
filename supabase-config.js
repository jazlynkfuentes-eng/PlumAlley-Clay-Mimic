/**
 * Supabase config for Plum Alley Clay Mimic.
 *
 * Setup (once):
 * 1. Create a free project at https://supabase.com
 * 2. SQL Editor → run supabase/schema.sql
 * 3. Authentication → URL Configuration → Site URL + Redirect URLs:
 *      http://localhost:5173
 *      http://127.0.0.1:5173
 *      (and your deployed origin when you have one)
 *    Also add the Supabase callback if prompted:
 *      https://<PROJECT_REF>.supabase.co/auth/v1/callback
 *
 * 4. Preferred login — Google (Gmail accounts):
 *    Authentication → Providers → Google → Enable
 *    Create OAuth credentials in Google Cloud Console:
 *      https://console.cloud.google.com/apis/credentials
 *      Application type: Web application
 *      Authorized redirect URI (copy from Supabase Google provider panel):
 *        https://<PROJECT_REF>.supabase.co/auth/v1/callback
 *    Paste Client ID + Client Secret into Supabase Google provider → Save
 *
 * 5. Optional — GitHub:
 *    Authentication → Providers → GitHub → Enable
 *    GitHub → Settings → Developer settings → OAuth Apps → New
 *    Authorization callback URL:
 *      https://<PROJECT_REF>.supabase.co/auth/v1/callback
 *    Paste Client ID + Client Secret into Supabase
 *
 * 6. Project Settings → API → copy Project URL + anon public key into the
 *    fields below (or paste once in the in-app setup form / localStorage).
 *
 * Magic-link email still works as a fallback, but Google/GitHub is more reliable
 * on the free tier (Supabase’s built-in mail often lands in spam or is rate-limited).
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
