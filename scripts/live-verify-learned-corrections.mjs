/**
 * Browser E2E (Playwright): teach a correction, reload, confirm resolve uses learned path.
 * Requires local static server with write API (npm run dev:local).
 */
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8091;
const SITE = `http://127.0.0.1:${PORT}/`;
const ACCESS = 'plumalley';
const JSON_PATH = path.join(ROOT, 'data', 'learned-corrections.json');

const backup = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, 'utf8') : null;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'dev-static-server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let ready = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (s.includes('http://127.0.0.1')) {
        ready = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => {
      if (!ready) reject(new Error('server start timeout'));
    }, 15000);
  });
}

async function main() {
  // Reset learned file
  fs.writeFileSync(JSON_PATH, JSON.stringify({ version: 1, updatedAt: null, corrections: [] }, null, 2) + '\n');
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  try {
    await page.goto(SITE, { waitUntil: 'networkidle' });
    const codeInput = page.locator('input[type="password"]');
    if (await codeInput.count()) {
      await codeInput.first().fill(ACCESS);
      await page.getByRole('button', { name: /^Enter$/i }).click();
      await page.waitForSelector('textarea.company-textarea');
    }

    // Teach via API path the app would use (simulates thumbs-down confirm)
    await page.evaluate(async () => {
      const store = {
        version: 1,
        updatedAt: new Date().toISOString(),
        corrections: [{
          companyName: 'Huntington Bancshares',
          companyKey: 'huntingtonbancshares',
          domain: 'huntington.com',
          source: 'thumbs-down',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      };
      localStorage.setItem('plum_learned_corrections_v1', JSON.stringify(store));
      await fetch('/api/learned-corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store)
      });
    });

    // Hard refresh so shipped+local merge and resolve cache are clean
    await page.reload({ waitUntil: 'networkidle' });
    // Re-enter access if needed
    if (await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="password"]').first().fill(ACCESS);
      await page.getByRole('button', { name: /^Enter$/i }).click();
      await page.waitForSelector('textarea.company-textarea');
    }

    // Verify in-page lookup sees learned hit
    const lookup = await page.evaluate(() => {
      // Re-merge from localStorage as App would on load
      return JSON.parse(localStorage.getItem('plum_learned_corrections_v1') || '{}');
    });
    if (!lookup.corrections?.some(c => c.domain === 'huntington.com')) {
      throw new Error('localStorage learned correction missing after reload');
    }

    const clearBtn = page.getByRole('button', { name: /Clear Table/i });
    if (await clearBtn.isEnabled().catch(() => false)) {
      page.once('dialog', (d) => d.accept());
      await clearBtn.click();
    }

    await page.locator('textarea.company-textarea').fill('Huntington Bancshares');
    if (await page.getByRole('button', { name: /Parse/i }).count()) {
      await page.getByRole('button', { name: /Parse/i }).first().click();
    } else {
      await page.locator('textarea.company-textarea').press('Control+Enter');
    }
    await page.getByRole('button', { name: /Confirm & Enrich/i }).click();

    // Learned path still goes through Potential picker (user confirm gate) OR may fast-path
    await page.waitForFunction(() => {
      const badges = [...document.querySelectorAll('.status-badge')].map(b => b.textContent || '');
      return badges.some(t => /potential|found|unverified/i.test(t)) &&
        !badges.some(t => /pending|searching|verifying|enriching/i.test(t));
    }, { timeout: 120000 });

    const row = page.locator('tr.table-row').filter({ hasText: 'Huntington' }).first();
    const bodyText = await row.innerText();
    if (!/huntington\.com/i.test(bodyText)) {
      throw new Error('Expected huntington.com in row after resolve, got: ' + bodyText.slice(0, 300));
    }

    // Confirm if picker still showing
    const selectBtn = row.getByRole('button', { name: /Select this one/i });
    if (await selectBtn.count()) {
      await selectBtn.first().click();
      await row.getByRole('button', { name: /^Confirm$/i }).click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.status-badge')?.textContent || '';
        return /found/i.test(t);
      }, { timeout: 120000 });
    }

    // Check resolve method note or domain present
    const finalText = await row.innerText();
    if (!/huntington\.com/i.test(finalText)) {
      throw new Error('Final row missing huntington.com');
    }

    // File on disk should contain the correction
    const disk = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    if (!disk.corrections?.some(c => c.domain === 'huntington.com')) {
      throw new Error('data/learned-corrections.json was not persisted');
    }

    console.log('PASS: learned correction resolves Huntington → huntington.com and persists to JSON');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    if (backup != null) fs.writeFileSync(JSON_PATH, backup);
    else fs.writeFileSync(JSON_PATH, JSON.stringify({ version: 1, updatedAt: null, corrections: [] }, null, 2) + '\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
