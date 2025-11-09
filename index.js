/**
 * Auto-generated worker bundle for "worker-vercel".
 * Source: backend/src/external-monitoring/worker/index.ts
 * Build time: 2025-11-09T13:49:19.353Z
 */
'use strict';

const http = require('node:http');
const { setInterval, clearInterval } = require('node:timers');

const WORKER_ID = "worker-vercel";
const WORKER_NAME = process.env.WORKER_NAME || "Worker Vercel";
const WORKER_GEO = process.env.WORKER_GEO || "IR";
const BACKEND_URL = "https://tizbin-worker-1.loca.lt/external-monitoring";
const CAPABILITIES = ['http-monitoring'];
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 20000);
const DEFAULT_ENDPOINT = process.env.WORKER_ENDPOINT || process.env.PUBLIC_ENDPOINT || '';
const SERVER_PORT = Number(process.env.PORT || process.env.WORKER_PORT || 3100);

const state = {
  lastHeartbeatAt: null,
  lastRegistrationAt: null,
  jobsProcessed: 0,
  lastError: null,
};

let registrationPromise = null;
let heartbeatTimer = null;

async function ensureRegistration(endpoint) {
  const targetEndpoint = endpoint || DEFAULT_ENDPOINT;
  if (!targetEndpoint) {
    console.warn('[worker:%s] No endpoint provided for registration.', WORKER_ID);
    return;
  }

  if (!registrationPromise) {
    registrationPromise = registerWorker(targetEndpoint)
      .then(() => {
        state.lastRegistrationAt = new Date().toISOString();
      })
      .catch((error) => {
        registrationPromise = null;
        state.lastError = error?.message || String(error);
        throw error;
      });
  }

  try {
    await registrationPromise;
  } catch (error) {
    console.error('[worker:%s] Registration failed:', WORKER_ID, error);
  }
}

async function registerWorker(endpoint) {
  const payload = {
    id: WORKER_ID,
    name: WORKER_NAME,
    geo: WORKER_GEO,
    endpoint,
    capabilities: CAPABILITIES,
  };

  const response = await fetch(`${BACKEND_URL}/workers/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Registration failed (${response.status}): ${text}`);
  }

  console.log('[worker:%s] Registered with backend via %s', WORKER_ID, endpoint);
}

async function sendHeartbeat(endpoint, note) {
  const stats = {
    pendingJobs: 0,
    bufferedResults: 0,
    inFlight: 0,
    lastResultAt: null,
    notes: note ?? state.lastError,
  };

  const payload = {
    worker: {
      id: WORKER_ID,
      name: WORKER_NAME,
      geo: WORKER_GEO,
    },
    stats,
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(`${BACKEND_URL}/hooks/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Heartbeat failed (${response.status}): ${text}`);
    }
    state.lastHeartbeatAt = payload.timestamp;
    state.lastError = null;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error('[worker:%s] Heartbeat failed:', WORKER_ID, error);
  }
}

function startHeartbeatLoop(endpoint) {
  if (heartbeatTimer || HEARTBEAT_INTERVAL <= 0) {
    return;
  }
  heartbeatTimer = setInterval(() => {
    ensureRegistration(endpoint)
      .then(() => sendHeartbeat(endpoint))
      .catch((err) => console.error('[worker:%s] Heartbeat loop error:', WORKER_ID, err));
  }, HEARTBEAT_INTERVAL);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
}

function buildStats() {
  return {
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastRegistrationAt: state.lastRegistrationAt,
    jobsProcessed: state.jobsProcessed,
    lastError: state.lastError,
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function handleJobs(body) {
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  if (jobs.length > 0) {
    state.jobsProcessed += jobs.length;
  }
  return { accepted: jobs.length };
}

function resolveEndpoint(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const forwardedHost = req.headers['x-forwarded-host'];
  const hostHeader = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const host = hostHeader || req.headers.host || '';

  if (!host) {
    return DEFAULT_ENDPOINT;
  }

  const scheme = proto || (req.socket?.encrypted ? 'https' : 'http');
  return `${scheme}://${host}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const endpoint = resolveEndpoint(req) || DEFAULT_ENDPOINT;

  await ensureRegistration(endpoint);
  await sendHeartbeat(endpoint);

  if (req.method === 'POST' && url.pathname.endsWith('/jobs')) {
    const body = await readRequestBody(req);
    const result = await handleJobs(body);
    sendJson(res, 202, result);
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/status')) {
    sendJson(res, 200, {
      worker: {
        id: WORKER_ID,
        name: WORKER_NAME,
        geo: WORKER_GEO,
        backendUrl: BACKEND_URL,
      },
      stats: buildStats(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.endsWith('/healthz')) {
    sendJson(res, 200, { ok: true, workerId: WORKER_ID });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    workerId: WORKER_ID,
    message: 'External monitoring worker placeholder.',
  });
}

function createNodeServer() {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error('[worker:%s] Request failed:', WORKER_ID, error);
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(SERVER_PORT, '0.0.0.0', () => {
    const endpoint = DEFAULT_ENDPOINT || `http://localhost:${SERVER_PORT}`;
    console.log('[worker:%s] Listening on %s', WORKER_ID, endpoint);
    ensureRegistration(endpoint)
      .then(() => sendHeartbeat(endpoint))
      .then(() => startHeartbeatLoop(endpoint))
      .catch((error) => console.error('[worker:%s] Startup failed:', WORKER_ID, error));
  });

  process.on('SIGTERM', () => {
    console.log('[worker:%s] Shutting down.', WORKER_ID);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    server.close(() => process.exit(0));
  });
}

module.exports = handler;
module.exports.default = handler;

if (require.main === module) {
  createNodeServer();
} else if (DEFAULT_ENDPOINT) {
  ensureRegistration(DEFAULT_ENDPOINT)
    .then(() => sendHeartbeat(DEFAULT_ENDPOINT))
    .catch((error) => console.error('[worker:%s] Initial registration failed:', WORKER_ID, error));
}
