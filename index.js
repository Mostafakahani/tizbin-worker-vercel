/**
 * Auto-generated worker bundle for "worker-cloudflare".
 * Source: backend/src/external-monitoring/worker/index.ts
 * Build time: 2025-11-09T14:23:39.517Z
 */
'use strict';

const express = require('express');
const { setInterval, clearInterval } = require('node:timers');

const WORKER_ID = "worker-cloudflare";
const WORKER_NAME = process.env.WORKER_NAME || "Worker Cloudflare";
const WORKER_GEO = process.env.WORKER_GEO || "AWS";
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

function withEndpoint(handler) {
  return async (req, res) => {
    const endpoint = resolveEndpoint(req) || DEFAULT_ENDPOINT;
    await ensureRegistration(endpoint);
    await sendHeartbeat(endpoint);
    return handler(req, res, endpoint);
  };
}

function respond(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      console.error('[worker:%s] Request failed:', WORKER_ID, error);
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    });
  };
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.post(
    '/jobs',
    respond(
      withEndpoint(async (req, res) => {
        const result = await handleJobs(req.body);
        res.status(202).json(result);
      }),
    ),
  );

  app.get(
    '/status',
    respond(
      withEndpoint(async (_req, res) => {
        res.status(200).json({
          worker: {
            id: WORKER_ID,
            name: WORKER_NAME,
            geo: WORKER_GEO,
            backendUrl: BACKEND_URL,
          },
          stats: buildStats(),
        });
      }),
    ),
  );

  app.get(
    '/healthz',
    respond(
      withEndpoint(async (_req, res) => {
        res.status(200).json({ ok: true, workerId: WORKER_ID });
      }),
    ),
  );

  app.get(
    '/',
    respond(async (_req, res) => {
      res.status(200).json({
        ok: true,
        workerId: WORKER_ID,
        routes: ['/jobs', '/status', '/healthz'],
      });
    }),
  );

  return app;
}

const app = createApp();

module.exports = app;
module.exports.default = app;

if (require.main === module) {
  const endpoint = DEFAULT_ENDPOINT || `http://localhost:${SERVER_PORT}`;
  app.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log('[worker:%s] Listening on %s', WORKER_ID, endpoint);
    ensureRegistration(endpoint)
      .then(() => sendHeartbeat(endpoint))
      .then(() => startHeartbeatLoop(endpoint))
      .catch((error) =>
        console.error('[worker:%s] Startup failed:', WORKER_ID, error),
      );
  });

  process.on('SIGTERM', () => {
    console.log('[worker:%s] Shutting down.', WORKER_ID);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    process.exit(0);
  });
} else if (DEFAULT_ENDPOINT) {
  ensureRegistration(DEFAULT_ENDPOINT)
    .then(() => sendHeartbeat(DEFAULT_ENDPOINT))
    .catch((error) =>
      console.error('[worker:%s] Initial registration failed:', WORKER_ID, error),
    );
}
