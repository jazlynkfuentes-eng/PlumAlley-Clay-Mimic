/**
 * Browser diagnosis: why Enrich All yields 0 Enriched on deployed UI.
 * Serves local index.html, unlocks, pastes known firms, runs Confirm & Enrich, reports statuses.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = 8765;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const rootResolved = path.resolve(root);
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '').replace(/\//g, path.sep);
  const filePath = path.resolve(rootResolved, rel);
  if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
    res.writeHead(403); res.end('Forbidden: ' + filePath); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + rel); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`Serving ${root} on http://127.0.0.1:${PORT}`);

const COMPANIES = [
  'Cara Advisory',
  'NAV Fund Services',
  'PIMCO',
  'Blackstone',
  'Stable',
  'Heard Capital'
].join('\n');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (/\[resolve\]|\[verify\]|\[enrich\]|\[batch\]|AI search|error/i.test(t)) {
    logs.push(t);
  }
});
page.on('pageerror', (err) => logs.push('PAGEERROR: ' + err.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);

// Bypass gate via localStorage + reload if still locked
await page.evaluate(() => localStorage.setItem('plum_site_unlocked', '1'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const gate = page.locator('input[type="password"]');
if (await gate.count()) {
  console.log('Still gated — trying form unlock. PLUM_ACCESS=', await page.evaluate(() => window.PLUM_ACCESS));
  await gate.fill('plumalley');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(800);
}

const hasTextarea = await page.locator('textarea.company-textarea').count();
console.log('textarea count=', hasTextarea);
if (!hasTextarea) {
  console.log('PAGE TITLE', await page.title());
  console.log('BODY SNIPPET', await page.locator('body').innerText().then(t => t.slice(0, 500)));
  await browser.close();
  server.close();
  process.exit(2);
}

// Probe DNS from browser context
const dnsProbe = await page.evaluate(async () => {
  try {
    const r = await fetch('https://dns.google/resolve?name=pimco.com&type=A');
    const j = await r.json();
    return { ok: true, status: j.Status, answers: j.Answer?.length || 0, http: r.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
console.log('Browser DNS probe:', JSON.stringify(dnsProbe));

// Paste companies (React controlled textarea needs input event)
await page.locator('textarea.company-textarea').evaluate((el, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, COMPANIES);
await page.waitForTimeout(300);

// Preview / Parse
await page.getByRole('button', { name: /Parse & Preview/i }).click();
await page.waitForTimeout(800);

// Confirm & Enrich
const confirmBtn = page.getByRole('button', { name: /Confirm & Enrich/i });
if (await confirmBtn.count()) {
  await confirmBtn.click();
} else {
  // maybe already started
  console.log('No Confirm & Enrich button found');
}

// Wait for queue to drain
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const stats = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.stat-item')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
    const badges = [...document.querySelectorAll('.status-badge')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
    return { labels, badges };
  });
  const queueLabel = stats.labels.find(l => /Queue/i.test(l)) || '';
  const queueMatch = queueLabel.match(/Queue:\s*(\d+)/);
  const queue = queueMatch ? Number(queueMatch[1]) : null;
  console.log('progress', stats.labels.join(' | '), 'badges=', JSON.stringify(stats.badges));
  if (queue === 0 && stats.badges.length > 0 && !stats.badges.some(b => /Search|Verify|Enrich|Pending|Queue/i.test(b))) {
    break;
  }
  // also break if all terminal
  if (stats.badges.length >= 6 && stats.badges.every(b => /Found|Potential|Unverified/i.test(b))) {
    break;
  }
  await page.waitForTimeout(2000);
}

const final = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.stat-item')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
  const rows = [...document.querySelectorAll('.spreadsheet-table tbody tr')].map(tr => {
    const badge = tr.querySelector('.status-badge')?.textContent?.replace(/\s+/g, ' ').trim();
    const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
    return { badge, cells };
  });
  return { labels, rows };
});

console.log('\n=== FINAL STATS ===');
console.log(final.labels.join('\n'));
console.log('\n=== ROWS ===');
final.rows.forEach((r, i) => console.log(i + 1, r.badge, '|', r.cells.slice(0, 4).join(' | ')));

console.log('\n=== KEY LOGS (tail) ===');
logs.slice(-80).forEach(l => console.log(l));

await browser.close();
server.close();
process.exit(0);
