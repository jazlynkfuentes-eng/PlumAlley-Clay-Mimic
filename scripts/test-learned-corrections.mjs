/**
 * Smoke-test learned corrections: upsert → lookup → persist file → reload.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'data', 'learned-corrections.json');

function companyKeyNorm(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const backup = fs.existsSync(JSON_PATH) ? fs.readFileSync(JSON_PATH, 'utf8') : null;

try {
  const now = new Date().toISOString();
  const store = {
    version: 1,
    updatedAt: now,
    corrections: [
      {
        companyName: 'Huntington Bancshares',
        companyKey: companyKeyNorm('Huntington Bancshares'),
        domain: 'huntington.com',
        source: 'thumbs-down',
        createdAt: now,
        updatedAt: now
      }
    ]
  };
  fs.writeFileSync(JSON_PATH, JSON.stringify(store, null, 2) + '\n');
  spawnSync(process.execPath, [path.join(__dirname, 'write-learned-corrections-config.mjs')], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  const { resolveHard } = await import('./lib/hard-sample-resolver.mjs');
  // Bust module cache isn't needed for first import of resolver after file write
  const resolved = await resolveHard('Huntington Bancshares');
  if (resolved.domain !== 'huntington.com' || !(resolved.sources || []).includes('learned')) {
    console.error('FAIL: expected learned huntington.com, got', resolved);
    process.exit(1);
  }
  console.log('PASS: Huntington Bancshares →', resolved.domain, 'via', resolved.sources.join('+'));
} finally {
  if (backup != null) {
    fs.writeFileSync(JSON_PATH, backup);
  } else {
    fs.writeFileSync(JSON_PATH, JSON.stringify({ version: 1, updatedAt: null, corrections: [] }, null, 2) + '\n');
  }
  spawnSync(process.execPath, [path.join(__dirname, 'write-learned-corrections-config.mjs')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
}
