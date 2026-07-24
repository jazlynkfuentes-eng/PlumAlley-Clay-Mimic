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
 *
 * 4. Email magic link (make delivery actually work):
 *    a. Authentication → Providers → Email → Enable
 *    b. Built-in Supabase email is unreliable (spam / ~2–4 emails per hour).
 *       Project Settings → Authentication → SMTP Settings → enable custom SMTP.
 *       Easiest free option — Resend (https://resend.com):
 *         Host: smtp.resend.com
 *         Port: 465
 *         User: resend
 *         Pass: your Resend API key
 *         Sender email: an address/domain verified in Resend
 *    c. Authentication → Email Templates → Magic Link — include the code:
 *         <p>Click: <a href="{{ .ConfirmationURL }}">Log in</a></p>
 *         <p>Or enter this code: <strong>{{ .Token }}</strong></p>
 *       Then you can paste the 6-digit code in the app if the link fails.
 *
 * 5. Optional — Google / GitHub OAuth:
 *    Authentication → Providers → Google or GitHub → Enable
 *    Callback URL: https://<PROJECT_REF>.supabase.co/auth/v1/callback
 *
 * 6. Project Settings → API → copy Project URL + anon key into the fields
 *    below (or paste once in the in-app setup form / localStorage).
 */
window.PLUM_SUPABASE = window.PLUM_SUPABASE || {
  url: '',
  anonKey: ''
};
