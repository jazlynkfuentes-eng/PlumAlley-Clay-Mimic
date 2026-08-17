/**
 * Vercel serverless: GET/POST /api/pdl-enrich
 * Requires env PDL_API_KEY. Never exposes the key to clients.
 */
import { handlePdlEnrichRequest, pdlStatusPayload } from '../scripts/lib/pdl-proxy-handler.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json(pdlStatusPayload());
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  const { status, payload } = await handlePdlEnrichRequest(body || {});
  res.status(status).json(payload);
}
