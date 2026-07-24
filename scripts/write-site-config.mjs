/**
 * Writes site-config.js from PLUM_ACCESS_CODE at deploy time (optional).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '..', 'site-config.js');
const code = (process.env.PLUM_ACCESS_CODE || 'plumalley').trim() || 'plumalley';

const contents = `/**
 * AUTO-GENERATED at build time by scripts/write-site-config.mjs
 * Set PLUM_ACCESS_CODE in Vercel → Environment Variables (Production), then Redeploy.
 */
window.PLUM_ACCESS = {
  code: ${JSON.stringify(code)}
};
`;

fs.writeFileSync(outFile, contents, 'utf8');
console.log('[write-site-config] Wrote site-config.js (code length:', code.length + ')');
