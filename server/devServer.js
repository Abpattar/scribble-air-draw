// Local dev server that mounts the api/* Vercel handlers with the same
// behaviour as production, so plain `npm run dev` (Vite) persists profiles,
// drawings, billing, friends, groups and competitions exactly like Vercel.
// Spawned automatically by server/vercelDevPlugin.js — no extra process setup.

import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.NEON_DEV_API_PORT || 8787);

function loadLocalEnv() {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(rootDir, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
  if (!process.env.RAZORPAY_KEY_ID && process.env.VITE_RAZORPAY_KEY_ID) {
    process.env.RAZORPAY_KEY_ID = process.env.VITE_RAZORPAY_KEY_ID;
  }
}

loadLocalEnv();

function mountShim(nodeReq, nodeRes, query) {
  const request = {
    method: nodeReq.method,
    headers: { ...nodeReq.headers },
    url: nodeReq.url,
    query,
    body: {},
    rawBody: '',
  };
  const response = {
    _status: 200,
    _headers: {},
    status(n) {
      this._status = n;
      return this;
    },
    setHeader(k, v) {
      this._headers[k] = v;
      return this;
    },
    json(payload) {
      const body = JSON.stringify(payload);
      const headers = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...this._headers,
      };
      if (!nodeRes.headersSent) nodeRes.writeHead(this._status, headers);
      nodeRes.end(body);
    },
    send(text) {
      const body = String(text);
      if (!nodeRes.headersSent) nodeRes.writeHead(this._status, { 'content-type': 'text/plain', ...this._headers });
      nodeRes.end(body);
    },
  };
  return { request, response };
}

function matchRoute(urlParts, segments) {
  if (urlParts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].startsWith(':')) {
      params[segments[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (segments[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

const routes = [];
async function mount(segments, file) {
  const abs = path.join(rootDir, 'api', file);
  try {
    const mod = await import(pathToFileURL(abs).href);
    routes.push({ segments, handler: mod.default, file });
  } catch (err) {
    console.warn('[dev-api] could not load', abs, '—', err.message);
  }
}

await mount(['api', 'profile'], 'profile.js');
await mount(['api', 'plans'], 'plans.js');
await mount(['api', 'create-order'], 'billing.js');
await mount(['api', 'create-subscription'], 'billing.js');
await mount(['api', 'verify-payment'], 'billing.js');
await mount(['api', 'check-subscription'], 'billing.js');
await mount(['api', 'cancel-subscription'], 'billing.js');
await mount(['api', 'razorpay-webhook'], 'billing.js');
await mount(['api', 'friends'], 'friends.js');
await mount(['api', 'friends', 'requests'], 'friends.js');
await mount(['api', 'requests'], 'requests.js');
await mount(['api', 'groups'], 'groups.js');
await mount(['api', 'groups', ':groupId'], 'groups.js');
await mount(['api', 'competitions'], 'competitions.js');
await mount(['api', 'competitions', ':competitionId'], 'competitions.js');
await mount(['api', 'admin'], 'admin.js');
await mount(['api', 'admin', 'users'], 'admin.js');
await mount(['api', 'admin', 'users', ':userId'], 'admin.js');
await mount(['api', 'admin', 'billing'], 'admin.js');
await mount(['api', 'admin', 'groups', ':groupId'], 'admin.js');
await mount(['api', 'admin', 'competitions', ':competitionId'], 'admin.js');
await mount(['api', 'admin', 'plans'], 'admin.js');
await mount(['api', 'admin', 'plans', ':planId'], 'admin.js');

const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', 'http://localhost');
  const urlParts = url.pathname.split('/').filter(Boolean);
  for (const route of routes) {
    const params = matchRoute(urlParts, route.segments);
    if (!params) continue;
    let raw = '';
    try {
      for await (const chunk of nodeReq) raw += chunk;
    } catch {
      /* ignore body read errors */
    }
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const { request, response } = mountShim(nodeReq, nodeRes, params);
    request.body = body;
    request.rawBody = raw;
    try {
      await route.handler(request, response);
    } catch (err) {
      console.error(`[dev-api] ${route.file} failed:`, err);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'Internal server error.' }));
      }
    }
    return;
  }
  nodeRes.writeHead(404, { 'content-type': 'application/json' });
  nodeRes.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', (err) => {
  console.error('[dev-api] failed to start:', err.message);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`[dev-api] serving /api on http://127.0.0.1:${PORT}`);
});