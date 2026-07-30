/**
 * Live-site verification: Cara Advisory + Disciplina founders on Vercel.
 */
import { chromium } from 'playwright';

const SITE = process.env.PLUM_SITE || 'https://plum-alley-clay-mimic.vercel.app/';
const ACCESS = process.env.PLUM_ACCESS_CODE || 'plumalley';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  console.log('Opening', SITE);
  await page.goto(SITE, { waitUntil: 'networkidle' });

  // Access gate
  const codeInput = page.locator('input[type="password"], input[placeholder="••••••••"]');
  if (await codeInput.count()) {
    console.log('Entering access code...');
    await codeInput.first().fill(ACCESS);
    await page.getByRole('button', { name: /^Enter$/i }).click();
    await page.waitForSelector('textarea.company-textarea', { timeout: 30000 });
  } else if (await page.locator('textarea.company-textarea').count() === 0) {
    throw new Error('Could not find access gate or main textarea');
  }

  // Clear any existing table if possible
  const clearBtn = page.getByRole('button', { name: /Clear Table/i });
  if (await clearBtn.isEnabled().catch(() => false)) {
    page.once('dialog', (d) => d.accept());
    await clearBtn.click();
    await page.waitForTimeout(500);
  }

  const companies = 'Cara Advisory\nDisciplina Capital Management';
  await page.locator('textarea.company-textarea').fill(companies);

  // Parse preview then confirm enrich — try common button labels
  const parseBtn = page.getByRole('button', { name: /Parse|Preview|Ctrl/i }).first();
  // Prefer explicit parse if present; else Ctrl+Enter
  if (await page.getByRole('button', { name: /Parse preview|Parse/i }).count()) {
    await page.getByRole('button', { name: /Parse/i }).first().click();
  } else {
    await page.locator('textarea.company-textarea').press('Control+Enter');
  }

  await page.waitForTimeout(1000);
  const confirm = page.getByRole('button', { name: /Confirm & Enrich/i });
  await confirm.waitFor({ state: 'visible', timeout: 15000 });
  await confirm.click();
  console.log('Started enrichment...');

  // Wait until both rows leave pending/searching — either potential (picker) or found
  await page.waitForFunction(() => {
    const badges = [...document.querySelectorAll('.status-badge')].map((b) => b.textContent || '');
    if (badges.length < 2) return false;
    return badges.every((t) => /potential|found|unverified/i.test(t)) &&
      !badges.some((t) => /pending|searching|verifying|enriching/i.test(t));
  }, { timeout: 180000 });

  console.log('Initial resolve done. Handling pickers if needed...');

  // For each row: if picker visible, select matching domain and confirm
  async function confirmDomainForCompany(companySubstring, domainHint) {
    // Find row containing company name
    const row = page.locator('tr.table-row').filter({ hasText: companySubstring }).first();
    await row.waitFor({ state: 'visible', timeout: 30000 });
    const status = await row.locator('.status-badge').innerText().catch(() => '');
    console.log(`  ${companySubstring}: status=${status.trim()}`);

    const selectBtn = row.getByRole('button', { name: /Select this one/i });
    if (await selectBtn.count()) {
      // Prefer option whose domain link/text matches hint
      const options = row.locator('.candidate-option');
      const n = await options.count();
      let clicked = false;
      for (let i = 0; i < n; i++) {
        const opt = options.nth(i);
        const txt = (await opt.innerText()).toLowerCase();
        if (txt.includes(domainHint.toLowerCase())) {
          await opt.getByRole('button', { name: /Select this one/i }).click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await selectBtn.first().click();
      }
      await row.getByRole('button', { name: /^Confirm$/i }).click();
      console.log(`  ${companySubstring}: confirmed picker selection`);
    } else {
      console.log(`  ${companySubstring}: no picker (already locked/found?)`);
    }
  }

  await confirmDomainForCompany('Cara Advisory', 'caraadvisory.com');
  await confirmDomainForCompany('Disciplina', 'disciplina.com');

  // Wait for found status after confirm enrich
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('tr.table-row')];
    if (rows.length < 2) return false;
    return rows.every((r) => {
      const t = r.querySelector('.status-badge')?.textContent || '';
      return /found/i.test(t);
    });
  }, { timeout: 180000 });

  // Read founders from each row — contacts column
  const results = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr.table-row')];
    return rows.map((r) => {
      const cells = [...r.querySelectorAll('td')];
      const texts = cells.map((c) => (c.innerText || '').trim().replace(/\s+/g, ' '));
      return {
        status: r.querySelector('.status-badge')?.textContent?.trim() || '',
        cells: texts
      };
    });
  });

  // Also grab header labels to find Founders index
  const headers = await page.evaluate(() =>
    [...document.querySelectorAll('.spreadsheet-table th')].map((th) => (th.innerText || '').trim())
  );
  console.log('Headers:', headers);

  const foundersIdx = headers.findIndex((h) => /founder/i.test(h));
  const companyIdx = headers.findIndex((h) => /company/i.test(h));
  const websiteIdx = headers.findIndex((h) => /website|domain/i.test(h));

  const report = [];
  for (const r of results) {
    const company = r.cells[companyIdx] || r.cells[1] || '';
    const website = r.cells[websiteIdx] || '';
    const founders = foundersIdx >= 0 ? r.cells[foundersIdx] : '';
    report.push({ company, website, founders, status: r.status });
    console.log(JSON.stringify({ company, website, founders, status: r.status }));
  }

  const cara = report.find((r) => /cara/i.test(r.company));
  const disc = report.find((r) => /disciplina/i.test(r.company));

  const caraOk = !!(cara && /Alana Mag/i.test(cara.founders));
  const discOk = !!(disc && /Alena Kuprevich/i.test(disc.founders));

  console.log('\n=== LIVE VERDICT ===');
  console.log(`Cara Advisory Founders: ${cara?.founders || '(row missing)'} → ${caraOk ? 'PASS' : 'FAIL'}`);
  console.log(`Disciplina Founders: ${disc?.founders || '(row missing)'} → ${discOk ? 'PASS' : 'FAIL'}`);

  await browser.close();
  if (!caraOk || !discOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
