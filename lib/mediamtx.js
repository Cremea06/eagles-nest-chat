// CHG-177 — MediaMTX WHIP/WHEP session tokens and HTTP auth hook for Go Live.
const crypto = require('crypto');
const express = require('express');

const STREAM_KEY_RE = /^[A-Za-z0-9_-]{8,32}$/;
const STREAM_PATH_RE = /^live\/([A-Za-z0-9_-]{8,32})$/;
const PREPARE_TTL_MS = 2 * 60 * 1000;
const ACTIVE_TTL_MS = 12 * 60 * 60 * 1000;

function normalizePublicBase(raw) {
  const s = String(raw || '').trim();
  if (!s) return '/mtx';
  return s.replace(/\/+$/, '') || '/mtx';
}

function getPublicConfig(env = process.env) {
  const enabled = env.MEDIAMTX_ENABLED === '1' || env.MEDIAMTX_ENABLED === 'true';
  const base = normalizePublicBase(env.MEDIAMTX_PUBLIC_BASE || '/mtx');
  return { enabled, base };
}

function buildStreamUrls(base, streamPath) {
  const cleanBase = normalizePublicBase(base);
  return {
    whipUrl: `${cleanBase}/${streamPath}/whip`,
    whepUrl: `${cleanBase}/${streamPath}/whep`
  };
}

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isLoopbackAddr(addr) {
  const s = String(addr || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function createLiveSessionStore(opts = {}) {
  const now = opts.now || Date.now;
  const prepareTtlMs = opts.prepareTtlMs || PREPARE_TTL_MS;
  const activeTtlMs = opts.activeTtlMs || ACTIVE_TTL_MS;
  const isSocketAllowed = typeof opts.isSocketAllowed === 'function' ? opts.isSocketAllowed : () => true;

  /** @type {Map<string, { socketId: string, username: string, streamKey: string, streamPath: string, token: string, active: boolean, createdAt: number, expiresAt: number }>} */
  const bySocket = new Map();
  /** @type {Map<string, any>} */
  const byKey = new Map();

  function purgeExpired() {
    const t = now();
    for (const [sid, sess] of bySocket) {
      if (!sess || sess.expiresAt <= t) {
        bySocket.delete(sid);
        if (sess && byKey.get(sess.streamKey) === sess) byKey.delete(sess.streamKey);
      }
    }
  }

  function revokeSocket(socketId) {
    const prev = bySocket.get(socketId);
    if (!prev) return false;
    bySocket.delete(socketId);
    if (byKey.get(prev.streamKey) === prev) byKey.delete(prev.streamKey);
    return true;
  }

  function issue({ socketId, username }) {
    if (!socketId || !username) return null;
    purgeExpired();
    revokeSocket(socketId);
    let streamKey;
    do {
      streamKey = crypto.randomBytes(12).toString('base64url');
    } while (byKey.has(streamKey));
    const token = crypto.randomBytes(24).toString('base64url');
    const t = now();
    const sess = {
      socketId,
      username: String(username),
      streamKey,
      streamPath: `live/${streamKey}`,
      token,
      active: false,
      createdAt: t,
      expiresAt: t + prepareTtlMs
    };
    bySocket.set(socketId, sess);
    byKey.set(streamKey, sess);
    return sess;
  }

  function activate(socketId, streamKey) {
    purgeExpired();
    const sess = bySocket.get(socketId);
    if (!sess || sess.streamKey !== streamKey) return null;
    if (!isSocketAllowed(socketId)) {
      revokeSocket(socketId);
      return null;
    }
    sess.active = true;
    sess.expiresAt = now() + activeTtlMs;
    return sess;
  }

  function getBySocket(socketId) {
    purgeExpired();
    return bySocket.get(socketId) || null;
  }

  function getByKey(streamKey) {
    purgeExpired();
    return byKey.get(streamKey) || null;
  }

  function verifyHook(payload = {}) {
    purgeExpired();
    const action = typeof payload.action === 'string' ? payload.action : '';
    const streamPath = typeof payload.path === 'string' ? payload.path.replace(/^\/+/, '') : '';
    const m = STREAM_PATH_RE.exec(streamPath);
    if (!m) {
      return { ok: false, status: 403, reason: 'bad_path' };
    }
    const streamKey = m[1];

    if (action === 'read') {
      return { ok: true, status: 200 };
    }

    if (action === 'publish') {
      const presented = typeof payload.token === 'string' && payload.token
        ? payload.token
        : (typeof payload.password === 'string' ? payload.password : '');
      const sess = byKey.get(streamKey);
      if (!sess || !isSocketAllowed(sess.socketId)) {
        return { ok: false, status: 401, reason: 'unauthorized' };
      }
      if (!safeEqualStr(sess.token, presented)) {
        return { ok: false, status: 401, reason: 'unauthorized' };
      }
      return { ok: true, status: 200 };
    }

    return { ok: false, status: 403, reason: 'forbidden_action' };
  }

  return {
    issue,
    activate,
    revokeSocket,
    getBySocket,
    getByKey,
    verifyHook
  };
}

// Mount BEFORE global cors(); loopback-only with no proxy forwarding headers.
function authRoute(opts = {}) {
  const store = opts.store;
  if (!store) throw new Error('store is required');
  const getAuthSecret = typeof opts.getAuthSecret === 'function'
    ? opts.getAuthSecret
    : () => String(opts.authSecret != null ? opts.authSecret : (process.env.MEDIAMTX_AUTH_SECRET || ''));
  const parse = express.json({ limit: '4kb', strict: true, type: () => true });

  return function mediamtxAuthHandler(req, res) {
    res.removeHeader('X-Powered-By');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });

    const peer = req.socket && req.socket.remoteAddress;
    if (!isLoopbackAddr(peer) || req.headers['x-forwarded-for'] || req.headers['x-real-ip']) {
      return res.status(404).send('Cannot ' + req.method + ' ' + req.path);
    }

    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return res.status(405).json({ error: 'method' });
    }

    const expectedSecret = getAuthSecret();
    if (expectedSecret) {
      const given = (req.query && req.query.secret) || req.get('x-mediamtx-secret') || '';
      if (!safeEqualStr(expectedSecret, String(given))) {
        return res.status(401).json({ error: 'bad_hook_secret' });
      }
    }

    parse(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'bad_json' });
      const result = store.verifyHook(req.body || {});
      if (result.ok) return res.status(200).json({});
      return res.status(result.status).json({ error: result.reason });
    });
  };
}

module.exports = {
  STREAM_KEY_RE,
  STREAM_PATH_RE,
  PREPARE_TTL_MS,
  ACTIVE_TTL_MS,
  normalizePublicBase,
  getPublicConfig,
  buildStreamUrls,
  createLiveSessionStore,
  authRoute
};
