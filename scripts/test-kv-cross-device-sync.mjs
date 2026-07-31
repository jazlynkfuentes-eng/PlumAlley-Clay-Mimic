/**
 * Cross-device sync check for the KV-backed learned corrections store.
 *
 * Browser A teaches a correction through the real picker flow (manual entry +
 * Confirm). Browser B is a separate, isolated context — the Playwright
 * equivalent of an incognito window on another machine — and must already have
 * that correction on load, with no manual sync step.
 *
 * Cleans the probe entry out of KV afterwards so the shared store is left as
 * it was found. Needs KV_REST_API_URL / KV_REST_API_TOKEN (see .env.local).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SITE = process.env.SITE || 'https://plum-alley-clay-mimic.vercel.app/';
const ACCESS = process.env.PLUM_ACCESS_CODE || 'plumalley';
const KV_KEY = 'plum:learned-corrections:v1';

const PROBE_COMPANY = 'Zzz Kv Sync Probe Co';
const PROBE_DOMAIN = 'kv-sync-probe.example.com';
// Anything synthetic that a test run may have left behind, purged on cleanup so
// the shared store only ever holds corrections real users taught.
const PROBE_DOMAINS = new Set([PROBE_DOMAIN, 'kvroundtrip-test.example.com']);

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function kvCommand(command) {
  const url = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`KV ${command[0]} HTTP ${res.status}`);
  const json = await res.json();
  if (json?.error) throw new Error(`KV ${command[0]}: ${json.error}`);
  return json?.result ?? null;
}

async function readKvStore() {
  const raw = await kvCommand(['GET', KV_KEY]);
  if (!raw) return { version: 1, updatedAt: null, corrections: [] };
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function unlock(page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const code = page.locator('input[type="password"]');
  if (await code.count()) {
    await code.first().fill(ACCESS);
    await page.getByRole('button', { name: /^Enter$/i }).click();
  }
  await page.waitForSelector('textarea.company-textarea', { timeout: 60000 });
}

async function teachCorrection(page) {
  await page.evaluate((name) => {
    const ta = document.querySelector('textarea.company-textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, name);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, PROBE_COMPANY);

  await page.getByRole('button', { name: /Parse & Preview/i }).click();
  await page.getByRole('button', { name: /Confirm & Enrich/i }).click();

  // Wait for the row to settle out of the in-flight states.
  await page.waitForFunction(() => {
    const badges = [...document.querySelectorAll('.status-badge')].map(b => b.textContent || '');
    return badges.length > 0 &&
      !badges.some(t => /pending|searching|verifying|enriching/i.test(t));
  }, { timeout: 180000 });

  const row = page.locator('tr.table-row').first();

  // A confidently-resolved row locks its selection; thumbs-down reopens the
  // picker, which is the flow a user hits when the answer is wrong.
  const thumbsDown = row.locator('button[title="Mark website as incorrect"]');
  if (await thumbsDown.count()) await thumbsDown.first().click();

  // With candidates the picker hides manual entry behind a button; with none it
  // drops straight to the input.
  const manualInput = row.locator('.candidate-manual-row input');
  if (!(await manualInput.count())) {
    const manualBtn = row.getByRole('button', { name: /None of these \/ Enter manually/i });
    try {
      await manualBtn.waitFor({ timeout: 30000 });
    } catch (err) {
      const dump = await page.evaluate(() => ({
        text: (document.querySelector('tr.table-row')?.innerText || '').slice(0, 600),
        buttons: [...document.querySelectorAll('tr.table-row button')]
          .map(b => (b.textContent || b.title || '').trim()).filter(Boolean)
      }));
      console.error('[debug] picker not available:', JSON.stringify(dump, null, 2));
      throw err;
    }
    await manualBtn.click();
  }

  await manualInput.fill(PROBE_DOMAIN);
  await row.getByRole('button', { name: /^Use$/ }).click();
  await row.getByRole('button', { name: /^Confirm$/ }).click();

  // Confirm fires the KV write; wait for the store to report it as synced.
  await page.waitForFunction((domain) => {
    const store = JSON.parse(localStorage.getItem('plum_learned_corrections_v1') || '{}');
    return (store.corrections || []).some(c => c.domain === domain);
  }, PROBE_DOMAIN, { timeout: 60000 });
}

async function main() {
  loadEnvLocal();
  const before = await readKvStore();
  console.log(`[setup] shared store currently holds ${before.corrections?.length || 0} correction(s)`);

  const browser = await chromium.launch({ headless: true });
  let failure = null;

  try {
    // --- Browser A: teach ---
    const a = await browser.newContext();
    const pageA = await a.newPage();
    pageA.setDefaultTimeout(120000);
    pageA.on('console', (m) => {
      if (/\[learned\]/.test(m.text())) console.log('  A>', m.text());
    });
    pageA.on('response', async (res) => {
      if (!res.url().includes('/api/learned-corrections')) return;
      const body = await res.text().catch(() => '');
      console.log(`  A> ${res.request().method()} ${res.status()} ${body.slice(0, 200)}`);
    });
    await unlock(pageA);
    await teachCorrection(pageA);
    console.log(`[A] taught ${PROBE_COMPANY} -> ${PROBE_DOMAIN}`);

    let kvHit = null;
    for (let attempt = 0; attempt < 15 && !kvHit; attempt += 1) {
      const inKv = await readKvStore();
      kvHit = (inKv.corrections || []).find(c => c.domain === PROBE_DOMAIN) || null;
      if (!kvHit) await new Promise(r => setTimeout(r, 1000));
    }
    if (!kvHit) throw new Error('correction never reached KV');
    console.log(`[KV] entry present, source=${kvHit.source}`);
    await a.close();

    // --- Browser B: separate storage, no manual action ---
    const b = await browser.newContext();
    const pageB = await b.newPage();
    pageB.setDefaultTimeout(120000);
    pageB.on('console', (m) => {
      if (/\[learned\]/.test(m.text())) console.log('  B>', m.text());
    });

    await unlock(pageB);
    await pageB.waitForFunction((domain) => {
      const store = JSON.parse(localStorage.getItem('plum_learned_corrections_v1') || '{}');
      return (store.corrections || []).some(c => c.domain === domain);
    }, PROBE_DOMAIN, { timeout: 60000 });
    console.log('[B] correction present on load with no manual sync');

    // The modal should also report the shared store as healthy.
    await pageB.getByRole('button', { name: /Learned \(/i }).click();
    await pageB.getByText(/Synced across devices/i).waitFor({ timeout: 30000 });
    // The modal renders each entry as editable inputs, so match on value.
    const listed = await pageB.evaluate((domain) =>
      [...document.querySelectorAll('.learned-row input')].some(i => i.value === domain),
      PROBE_DOMAIN);
    if (!listed) throw new Error('probe correction missing from Learned Corrections modal in browser B');
    console.log('[B] modal shows "Synced across devices" and lists the probe entry');

    await b.close();
    console.log('\nPASS: a correction taught in one browser is live in a fresh browser with no manual step');
  } catch (err) {
    failure = err;
  } finally {
    await browser.close();
    // Restore the shared store to exactly what it held before the probe.
    try {
      await kvCommand(['SET', KV_KEY, JSON.stringify({
        version: 1,
        updatedAt: before.updatedAt || null,
        corrections: (before.corrections || []).filter(c => !PROBE_DOMAINS.has(c.domain))
      })]);
      const after = await readKvStore();
      console.log(`[cleanup] shared store restored to ${after.corrections?.length || 0} correction(s)`);
    } catch (e) {
      console.error('[cleanup] failed to restore shared store:', e.message);
    }
  }

  if (failure) throw failure;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
