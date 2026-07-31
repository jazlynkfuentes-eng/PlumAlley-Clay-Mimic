/**
 * Cross-device sync check for the KV-backed learned corrections store.
 *
 * Teach phase: browser A teaches a correction through the real picker flow
 * (manual entry + Confirm), and browser B — a separate, isolated context, the
 * Playwright equivalent of an incognito window on another machine — must already
 * have it on load with no manual sync step.
 *
 * Delete phase: browser A removes it. The interesting failure mode is not the
 * shared store keeping the row, it's a device that still has the row cached
 * pushing it back up. So browser B is reloaded (it cached the entry during the
 * teach phase) and must both drop it and leave the shared store alone, and a
 * third fresh context must never see it.
 *
 * Cleans its probe entries out of KV afterwards so the shared store is left as
 * it was found. Needs KV_REST_API_URL / KV_REST_API_TOKEN (see .env.local).
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Serves index.html and hands /api/learned-corrections to the real serverless
// module, so the test covers the shipped handler against the real KV store.
// Point SITE at a deployment to run the same checks against one instead.
const PORT = Number(process.env.PORT || 8123);
const SITE = process.env.SITE || `http://127.0.0.1:${PORT}/`;
const ACCESS = process.env.PLUM_ACCESS_CODE || 'plumalley';
const KV_KEY = 'plum:learned-corrections:v1';
const LS_KEY = 'plum_learned_corrections_v1';

const PROBE_COMPANY = 'Zzz Kv Sync Probe Co';
const PROBE_KEY = 'zzzkvsyncprobeco';
const PROBE_DOMAIN = 'kv-sync-probe.example.com';
// Anything synthetic a run may have left behind, purged on cleanup so the shared
// store only ever holds corrections real users taught.
const PROBE_DOMAINS = new Set([PROBE_DOMAIN, 'kvroundtrip-test.example.com']);
const PROBE_KEYS = new Set([PROBE_KEY, 'kvroundtriptestco']);

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function startLocalServer() {
  const { default: handler } = await import(
    pathToFileURL(path.join(ROOT, 'api', 'learned-corrections.js')).href
  );

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/api/learned-corrections') {
      // Vercel's Node runtime decorates the response with these; the bare
      // http module does not.
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
      };
      try {
        await handler(req, res);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, reason: e.message || String(e) }));
      }
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[setup] serving ${SITE} with the real /api/learned-corrections handler`);
  return server;
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
  if (!raw) return { version: 1, updatedAt: null, corrections: [], deletions: [] };
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { corrections: [], deletions: [], ...parsed };
}

/** Poll KV until `predicate` holds, so assertions don't race the app's write. */
async function waitForKv(predicate, label, attempts = 15) {
  let store = null;
  for (let i = 0; i < attempts; i += 1) {
    store = await readKvStore();
    if (predicate(store)) return store;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for shared store: ${label}\nlast: ${JSON.stringify(store)}`);
}

function newPage(context, label) {
  return context.newPage().then((page) => {
    page.setDefaultTimeout(120000);
    page.on('console', (m) => {
      if (/\[learned\]/.test(m.text())) console.log(`  ${label}>`, m.text());
    });
    page.on('response', async (res) => {
      if (!res.url().includes('/api/learned-corrections')) return;
      console.log(`  ${label}> ${res.request().method()} ${res.status()}`);
    });
    return page;
  });
}

/** Resolves once the app logs that it finished reconciling with the shared store. */
function bootstrapDone(page) {
  return page.waitForEvent('console', {
    predicate: (m) => /\[learned\] (synced from shared store|shared store unavailable)/.test(m.text()),
    timeout: 60000
  });
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

function localHas(page, domain) {
  return page.evaluate(({ key, domain }) => {
    const store = JSON.parse(localStorage.getItem(key) || '{}');
    return (store.corrections || []).some(c => c.domain === domain);
  }, { key: LS_KEY, domain });
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

  await page.waitForFunction(({ key, domain }) => {
    const store = JSON.parse(localStorage.getItem(key) || '{}');
    return (store.corrections || []).some(c => c.domain === domain);
  }, { key: LS_KEY, domain: PROBE_DOMAIN }, { timeout: 60000 });
}

async function openLearnedModal(page) {
  await page.getByRole('button', { name: /Learned \(/i }).click();
  await page.locator('.learned-list').waitFor({ timeout: 30000 });
}

/** Index of the modal row holding `domain`; the domain lives in an input value. */
async function findLearnedRow(page, domain) {
  const rows = page.locator('.learned-row');
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const values = await rows.nth(i).locator('input').evaluateAll(els => els.map(e => e.value));
    if (values.includes(domain)) return i;
  }
  return -1;
}

async function removeCorrectionViaUi(page) {
  await openLearnedModal(page);
  const idx = await findLearnedRow(page, PROBE_DOMAIN);
  if (idx < 0) throw new Error('probe correction not listed in modal, cannot remove it');
  await page.locator('.learned-row').nth(idx).getByRole('button', { name: /^Remove$/ }).click();
  await page.getByText(/Removed everywhere\./i).waitFor({ timeout: 30000 });
}

async function main() {
  loadEnvLocal();
  const before = await readKvStore();
  console.log(`[setup] shared store holds ${before.corrections.length} correction(s), ${before.deletions.length} tombstone(s)`);

  const server = process.env.SITE ? null : await startLocalServer();
  const browser = await chromium.launch({ headless: true });
  let failure = null;

  try {
    // --- A teaches ---
    const a = await browser.newContext();
    const pageA = await newPage(a, 'A');
    await unlock(pageA);
    await teachCorrection(pageA);
    console.log(`[A] taught ${PROBE_COMPANY} -> ${PROBE_DOMAIN}`);

    const taught = await waitForKv(
      s => s.corrections.some(c => c.domain === PROBE_DOMAIN),
      'probe correction to appear'
    );
    console.log(`[KV] entry present, source=${taught.corrections.find(c => c.domain === PROBE_DOMAIN).source}`);

    // --- B picks it up with no manual action ---
    const b = await browser.newContext();
    const pageB = await newPage(b, 'B');
    await unlock(pageB);
    await pageB.waitForFunction(({ key, domain }) => {
      const store = JSON.parse(localStorage.getItem(key) || '{}');
      return (store.corrections || []).some(c => c.domain === domain);
    }, { key: LS_KEY, domain: PROBE_DOMAIN }, { timeout: 60000 });
    await openLearnedModal(pageB);
    await pageB.getByText(/Synced across devices/i).waitFor({ timeout: 30000 });
    if (await findLearnedRow(pageB, PROBE_DOMAIN) < 0) {
      throw new Error('probe correction missing from B\'s Learned Corrections modal');
    }
    console.log('[B] correction present on load, modal reports "Synced across devices"');

    // --- A removes it ---
    await removeCorrectionViaUi(pageA);
    console.log('[A] clicked Remove, UI confirmed "Removed everywhere."');

    const deleted = await waitForKv(
      s => !s.corrections.some(c => c.domain === PROBE_DOMAIN),
      'probe correction to leave the shared store'
    );
    if (!deleted.deletions.some(d => d.companyKey === PROBE_KEY)) {
      throw new Error(`delete left no tombstone: ${JSON.stringify(deleted.deletions)}`);
    }
    console.log('[KV] correction gone and tombstone recorded');
    await a.close();

    // --- B reloads while still holding the stale entry ---
    if (!(await localHas(pageB, PROBE_DOMAIN))) {
      throw new Error('B lost the entry before the reload, so this would not test resurrection');
    }
    const bSynced = bootstrapDone(pageB);
    await unlock(pageB);
    await bSynced;
    if (await localHas(pageB, PROBE_DOMAIN)) {
      throw new Error('B kept the deleted correction after reloading');
    }
    console.log('[B] dropped the deleted correction on reload despite having it cached');

    const stillGone = await readKvStore();
    if (stillGone.corrections.some(c => c.domain === PROBE_DOMAIN)) {
      throw new Error('B pushed the deleted correction back into the shared store');
    }
    console.log('[KV] B did not resurrect it');
    await b.close();

    // --- C has never seen it ---
    const c = await browser.newContext();
    const pageC = await newPage(c, 'C');
    const cSynced = bootstrapDone(pageC);
    await unlock(pageC);
    await cSynced;
    if (await localHas(pageC, PROBE_DOMAIN)) {
      throw new Error('a fresh browser picked up the deleted correction');
    }
    await openLearnedModal(pageC);
    if (await findLearnedRow(pageC, PROBE_DOMAIN) >= 0) {
      throw new Error('deleted correction still listed in a fresh browser');
    }
    console.log('[C] fresh browser never sees the deleted correction');

    // --- D re-teaches the same company: the tombstone must not be permanent ---
    const d = await browser.newContext();
    const pageD = await newPage(d, 'D');
    await unlock(pageD);
    await teachCorrection(pageD);
    const revived = await waitForKv(
      s => s.corrections.some(c2 => c2.domain === PROBE_DOMAIN),
      're-taught correction to come back'
    );
    if (revived.deletions.some(t => t.companyKey === PROBE_KEY)) {
      throw new Error('re-teaching left the tombstone in place, so it can be deleted again by accident');
    }
    console.log('[D] re-teaching after a delete revives the entry and clears the tombstone');
    await d.close();

    // C still holds the tombstone locally; it must accept the newer re-teach.
    const cSynced2 = bootstrapDone(pageC);
    await unlock(pageC);
    await cSynced2;
    if (!(await localHas(pageC, PROBE_DOMAIN))) {
      throw new Error('a browser holding the tombstone rejected the newer re-teach');
    }
    console.log('[C] browser holding the old tombstone accepts the re-taught entry');
    await c.close();

    console.log('\nPASS: Remove deletes from the shared store and stays deleted everywhere,');
    console.log('      and a later re-teach of the same company still works');
  } catch (err) {
    failure = err;
  } finally {
    await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    // Restore the shared store to exactly what it held before the probe.
    try {
      await kvCommand(['SET', KV_KEY, JSON.stringify({
        version: 1,
        updatedAt: before.updatedAt || null,
        corrections: before.corrections.filter(c => !PROBE_DOMAINS.has(c.domain)),
        deletions: before.deletions.filter(d => !PROBE_KEYS.has(d.companyKey))
      })]);
      const after = await readKvStore();
      console.log(`[cleanup] shared store restored to ${after.corrections.length} correction(s), ${after.deletions.length} tombstone(s)`);
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
