/**
 * Local static server with POST /api/learned-corrections that writes
 * data/learned-corrections.json (and regenerates the config script).
 *
 * Usage: npm run dev:local
 * Then open http://127.0.0.1:8081/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8081);
const JSON_PATH = path.join(ROOT, 'data', 'learned-corrections.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8'
};

function regenerateConfig() {
  spawnSync(process.execPath, [path.join(__dirname, 'write-learned-corrections-config.mjs')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

regenerateConfig();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/learned-corrections') {
    if (req.method === 'GET') {
      try {
        const raw = fs.readFileSync(JSON_PATH, 'utf8');
        sendJson(res, 200, JSON.parse(raw));
      } catch (e) {
        sendJson(res, 200, { version: 1, updatedAt: null, corrections: [] });
      }
      return;
    }
    if (req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const payload = JSON.parse(raw || '{}');
        if (!payload || !Array.isArray(payload.corrections)) {
          sendJson(res, 400, { error: 'Expected { corrections: [...] }' });
          return;
        }
        const next = {
          version: 1,
          updatedAt: new Date().toISOString(),
          corrections: payload.corrections.map((c) => ({
            companyName: String(c.companyName || '').trim(),
            companyKey: String(c.companyKey || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''),
            domain: String(c.domain || '')
              .toLowerCase()
              .replace(/^(https?:\/\/)?(www\.)?/, '')
              .split('/')[0]
              .trim(),
            source: c.source || 'manual',
            createdAt: c.createdAt || new Date().toISOString(),
            updatedAt: c.updatedAt || new Date().toISOString()
          })).filter((c) => c.companyName && c.companyKey && c.domain && c.domain.includes('.'))
        };
        fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
        fs.writeFileSync(JSON_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
        regenerateConfig();
        console.log('[dev-static] Saved', next.corrections.length, 'learned corrections');
        sendJson(res, 200, { ok: true, count: next.corrections.length, updatedAt: next.updatedAt });
      } catch (e) {
        sendJson(res, 500, { error: e.message || String(e) });
      }
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
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
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-static] http://127.0.0.1:${PORT}/`);
  console.log('[dev-static] POST /api/learned-corrections writes data/learned-corrections.json');
});
