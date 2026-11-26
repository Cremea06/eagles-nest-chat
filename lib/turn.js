// CHG-176 — short-lived TURN credentials (coturn REST / use-auth-secret scheme)
// and GET /api/ice-servers for Go Live WebRTC connections.
const crypto = require('crypto');
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');

const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';
const DEFAULT_HOST = 'chat.afirstflag.com';
const DEFAULT_PORT = 3478;
const DEFAULT_TLS_PORT = 5349;
const DEFAULT_TTL_SEC = 3600;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 86400;

function clampTtl(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SEC;
  return Math.max(MIN_TTL_SEC, Math.min(MAX_TTL_SEC, Math.floor(n)));
}

function sanitizeHost(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 253) return DEFAULT_HOST;
  if (!/^[a-z0-9.-]+$/i.test(s)) return DEFAULT_HOST;
  return s;
}

function sanitizePort(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function sanitizeTag(raw) {
  const s = String(raw || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return (s || 'milliway').slice(0, 32);
}

// coturn REST API (draft-uberti-behave-turn-rest-00):
// username = "<unix_expiry>:<tag>", credential = base64(HMAC-SHA1(secret, username))
function buildTurnCredentials({ secret, nowSec, ttlSec, tag } = {}) {
  if (typeof secret !== 'string' || !secret) return null;
  const baseSec = Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const ttl = clampTtl(ttlSec);
  const expiresAt = baseSec + ttl;
  const username = `${expiresAt}:${sanitizeTag(tag)}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttlSec: ttl, expiresAt };
}

function buildIceServers(cfg = {}) {
  const stunUrl = typeof cfg.stunUrl === 'string' && cfg.stunUrl ? cfg.stunUrl : DEFAULT_STUN_URL;
  const iceServers = [{ urls: stunUrl }];
  const secret = typeof cfg.secret === 'string' ? cfg.secret.trim() : '';
  if (!secret) {
    return { iceServers, turn: false };
  }
  const host = sanitizeHost(cfg.host);
  const port = sanitizePort(cfg.port, DEFAULT_PORT);
  const tls = cfg.tls === true || cfg.tls === '1' || cfg.tls === 'true';
  const tlsPort = sanitizePort(cfg.tlsPort, DEFAULT_TLS_PORT);
  const creds = buildTurnCredentials({
    secret,
    nowSec: cfg.nowSec,
    ttlSec: cfg.ttlSec,
    tag: cfg.tag
  });

  const urls = [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`
  ];
  if (tls) {
    urls.push(`turns:${host}:${tlsPort}?transport=tcp`);
  }

  iceServers.push({
    urls,
    username: creds.username,
    credential: creds.credential
  });

  return {
    iceServers,
    turn: true,
    tls,
    ttlSec: creds.ttlSec
  };
}

function defaultOriginOk(origin) {
  if (!origin) return true;
  if (origin === 'https://chat.afirstflag.com') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

// Mount BEFORE global cors() so third-party origins cannot harvest TURN credentials.
function iceServersRoute(opts = {}) {
  const limiter = opts.limiter || createRateLimiter({ limit: opts.limit || 30, windowMs: opts.windowMs || 60000 });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const originOk = typeof opts.originOk === 'function' ? opts.originOk : defaultOriginOk;
  const getConfig = typeof opts.getConfig === 'function'
    ? opts.getConfig
    : () => ({
        secret: process.env.TURN_SECRET || '',
        host: process.env.TURN_HOST || DEFAULT_HOST,
        port: process.env.TURN_PORT || DEFAULT_PORT,
        tls: process.env.TURN_TLS === '1' || process.env.TURN_TLS === 'true',
        tlsPort: process.env.TURN_TLS_PORT || DEFAULT_TLS_PORT,
        ttlSec: process.env.TURN_TTL_SEC || DEFAULT_TTL_SEC
      });
  const extraPayload = typeof opts.extraPayload === 'function' ? opts.extraPayload : null;

  return function iceServersHandler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    });

    const origin = req.get && req.get('origin');
    if (origin && !originOk(origin)) {
      return res.status(403).json({ error: 'origin' });
    }

    if (req.method === 'OPTIONS') {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD, OPTIONS');
      return res.status(405).json({ error: 'method' });
    }

    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit' });
    }

    const payload = buildIceServers(getConfig());
    if (extraPayload) {
      Object.assign(payload, extraPayload(req));
    }
    if (req.method === 'HEAD') return res.status(200).end();
    return res.json(payload);
  };
}

module.exports = {
  DEFAULT_STUN_URL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TLS_PORT,
  DEFAULT_TTL_SEC,
  clampTtl,
  sanitizeHost,
  buildTurnCredentials,
  buildIceServers,
  iceServersRoute
};
