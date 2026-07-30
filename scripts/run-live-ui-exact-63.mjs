/**
 * Run exact 63-row paste against live Vercel UI and report Enriched/Potential/Unverified.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url));
const PASTE = fs.readFileSync(path.join(root, 'exact-63-paste.txt'), 'utf8');
const TARGET = process.env.TARGET_URL || 'https://plum-alley-clay-mimic.vercel.app/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (/\[resolve\]|\[verify\] FAIL|\[enrich\] row failed|AI search|PAGEERROR|\[batch\]/i.test(t)) {
    logs.push(t);
  }
});
page.on('pageerror', (err) => logs.push('PAGEERROR: ' + err.message));

console.log('Opening', TARGET);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.setItem('plum_site_unlocked', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

await page.locator('textarea.company-textarea').evaluate((el, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, PASTE);

await page.getByRole('button', { name: /Parse & Preview/i }).click();
await page.waitForTimeout(1000);

const previewCount = await page.locator('.parse-preview-table tbody tr').count();
console.log('Parse preview rows:', previewCount);

// Sample first 3 company cells
const sample = await page.locator('.parse-preview-table tbody tr').evaluateAll((trs) =>
  trs.slice(0, 5).map(tr => {
    const input = tr.querySelector('input');
    return input ? input.value : tr.cells[0]?.textContent?.trim();
  })
);
console.log('Sample companies:', sample);

await page.getByRole('button', { name: /Confirm & Enrich/i }).click();
console.log('Enrich started…');

const deadline = Date.now() + 12 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  const snap = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.stat-item')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
    const badges = [...document.querySelectorAll('.status-badge')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
    const counts = badges.reduce((a, b) => { a[b] = (a[b] || 0) + 1; return a; }, {});
    return { labels, counts, n: badges.length };
  });
  const line = snap.labels.join(' | ') + ' :: ' + JSON.stringify(snap.counts);
  if (line !== last) {
    console.log(line);
    last = line;
  }
  const terminal = Object.keys(snap.counts).every(k => /Found|Potential|Unverified/i.test(k));
  const queue = snap.labels.find(l => /Queue/i.test(l));
  const q = Number((queue || '').match(/(\d+)/)?.[1] || -1);
  if (snap.n >= 60 && terminal && q === 0) break;
  await page.waitForTimeout(3000);
}

const final = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.stat-item')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
  const rows = [...document.querySelectorAll('.spreadsheet-table tbody tr')].map(tr => {
    const badge = tr.querySelector('.status-badge')?.textContent?.replace(/\s+/g, ' ').trim();
    const company = tr.querySelector('td input')?.value
      || [...tr.querySelectorAll('td')][1]?.textContent?.replace(/\s+/g, ' ').trim();
    const website = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()).find(t => /\.[a-z]{2,}/i.test(t)) || '';
    const notes = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()).slice(-1)[0] || '';
    return { badge, company: String(company || '').slice(0, 60), website: String(website).slice(0, 40), notes: String(notes).slice(0, 80) };
  });
  return { labels, rows };
});

const summary = final.rows.reduce((a, r) => {
  const k = r.badge || '?';
  a[k] = (a[k] || 0) + 1;
  return a;
}, {});

console.log('\n=== FINAL LABELS ===');
console.log(final.labels.join('\n'));
console.log('\n=== BADGE SUMMARY ===');
console.log(summary);
console.log('\n=== NON-FOUND ROWS ===');
final.rows.filter(r => r.badge !== 'Found').forEach((r, i) => {
  console.log(`${i + 1}. [${r.badge}] ${r.company} | ${r.website} | ${r.notes}`);
});

fs.writeFileSync(path.join(root, 'last-live-ui-63-result.json'), JSON.stringify({ labels: final.labels, summary, rows: final.rows, logs: logs.slice(-120) }, null, 2));
console.log('\nWrote scripts/last-live-ui-63-result.json');
console.log('\n=== FAIL/ERROR LOGS ===');
logs.filter(l => /FAIL|error|failed/i.test(l)).slice(0, 40).forEach(l => console.log(l));

await browser.close();
