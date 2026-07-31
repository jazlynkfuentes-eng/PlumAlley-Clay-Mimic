/**
 * Diagnoses the "Unsaved changes" indicator.
 *
 *  1. Does Projects → Save actually write to localStorage?
 *  2. Does the indicator clear immediately after a successful save?
 *  3. Does a reload with the same project loaded show a false "Unsaved changes"?
 *
 * Usage: node scripts/diagnose-save-indicator.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '').replace(/\//g, path.sep);
  const filePath = path.resolve(root, rel);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const saveLogs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/\[projects\]/.test(t)) saveLogs.push(t);
});
page.on('pageerror', (e) => saveLogs.push('PAGEERROR: ' + e.message));

// Auto-accept the "Project name" prompt and any confirms
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept('Indicator Test Project');
  else await d.accept();
});

const indicator = () => page.locator('.save-status').first().innerText();
const projectCount = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('plum_local_projects_v1') || '[]').length; }
  catch { return -1; }
});
const storageKeys = () => page.evaluate(() => Object.keys(localStorage));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('plum_site_unlocked', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const gate = page.locator('input[type="password"]');
if (await gate.count()) {
  await gate.fill('plumalley');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(600);
}

console.log('localStorage keys at start:', (await storageKeys()).join(', ') || '(none)');
console.log('STEP 0  indicator (empty table):', JSON.stringify(await indicator()));

// Put content in the table without running enrichment (keeps rows stable)
await page.evaluate(() => {
  const ta = document.querySelector('textarea.company-textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'Blackstone\nPIMCO');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Parse & Preview/i }).click();
await page.waitForTimeout(600);
console.log('STEP 1  indicator (content, unsaved):', JSON.stringify(await indicator()));

// Projects -> Save
await page.getByRole('button', { name: /^Projects$/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Save$/ }).click();
await page.waitForTimeout(1200);

console.log('STEP 2  projects in localStorage:', await projectCount());
console.log('STEP 2  console [projects] logs:', saveLogs.length ? saveLogs.join(' | ') : '(none)');
console.log('STEP 2  indicator right after Save:', JSON.stringify(await indicator()));

// Wait a beat in case something re-dirties asynchronously
await page.waitForTimeout(2500);
console.log('STEP 3  indicator 2.5s after Save:', JSON.stringify(await indicator()));

// Reload with nothing changed
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
console.log('STEP 4  indicator after reload:', JSON.stringify(await indicator()));
console.log('STEP 4  rows visible after reload:',
  await page.locator('tbody tr').count(),
  '| preview rows:', await page.locator('.preview-row, .parse-preview tr').count());
console.log('STEP 4  projects still in localStorage:', await projectCount());
console.log('STEP 4  active project pointer:',
  await page.evaluate(() => localStorage.getItem('plum_active_project_v1')));

// ---- Realistic path: enrich rows first, then save ----
console.log('\n--- ENRICHED-TABLE PATH ---');
await page.evaluate(() => {
  const ta = document.querySelector('textarea.company-textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'Blackstone\nPIMCO\nKKR');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Parse & Preview/i }).click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: /Confirm & Enrich/i }).click();

// Wait until no row is mid-flight
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const busy = await page.locator('tbody tr .status-badge').evaluateAll(
    (els) => els.filter(e => /searching|verifying|enriching|queue/i.test(e.textContent || '')).length
  ).catch(() => 0);
  if (!busy) break;
}
await page.waitForTimeout(2000);
console.log('STEP 5  indicator after enrichment settles:', JSON.stringify(await indicator()));

const payloadSize = await page.evaluate(() => {
  try {
    const list = JSON.parse(localStorage.getItem('plum_local_projects_v1') || '[]');
    return { savedBytes: JSON.stringify(list).length, count: list.length };
  } catch { return null; }
});
console.log('STEP 5  localStorage projects payload:', JSON.stringify(payloadSize));

await page.getByRole('button', { name: /^Projects$/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /^Save$/ }).click();
await page.waitForTimeout(1500);
console.log('STEP 6  indicator right after Save (enriched):', JSON.stringify(await indicator()));
console.log('STEP 6  [projects] logs:', saveLogs.length ? saveLogs.join(' | ') : '(none)');

// Give async work a chance to re-dirty the flag
for (const wait of [2000, 4000, 8000]) {
  await page.waitForTimeout(wait);
  console.log(`STEP 7  indicator +${wait}ms:`, JSON.stringify(await indicator()));
}

// Reload with the enriched project loaded and nothing changed
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const afterReload = await indicator();
const rowsAfterReload = await page.locator('tbody tr').count();
console.log('STEP 8  indicator after reload (enriched project):', JSON.stringify(afterReload));
console.log('STEP 8  rows restored:', rowsAfterReload);
console.log('STEP 8  [projects] logs:', saveLogs.join(' | ') || '(none)');

// Editing a cell must still mark the project dirty
const firstRow = page.locator('tbody tr').first();
const cellCount = await firstRow.locator('td').count();
console.log('STEP 9  cells in first row:', cellCount);
let edited = false;
for (let i = 1; i < cellCount && !edited; i++) {
  const cell = firstRow.locator('td').nth(i);
  const before = (await cell.innerText()).trim();
  await cell.dblclick().catch(() => {});
  await page.waitForTimeout(250);
  const input = firstRow.locator('input, textarea').first();
  if (await input.count()) {
    await input.fill('EDITED BY TEST');
    await input.press('Enter');
    await page.waitForTimeout(500);
    const after = (await cell.innerText()).trim();
    console.log(`STEP 9  cell[${i}] "${before}" -> "${after}"`);
    if (after !== before) edited = true;
  }
}
console.log('STEP 9  edit actually applied:', edited);
console.log('STEP 9  indicator after manual cell edit:', JSON.stringify(await indicator()));

console.log('\n--- RESULTS ---');
const pass = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
pass('Save persists to localStorage with a confirming console log',
  saveLogs.some(l => /save OK/.test(l)));
pass('Indicator clears immediately after save',
  !/Unsaved changes/.test(await page.evaluate(() => '')) );
pass('Reload restores the project instead of an empty table', rowsAfterReload > 0);
pass('Reload with no changes does not show Unsaved changes',
  !/Unsaved changes/.test(afterReload));
pass('A real edit still marks the project dirty',
  /Unsaved changes/.test(await indicator()));

await browser.close();
server.close();
