// CHG-173 — read-only admin console for Milliway: GET /admin (page) and GET /api/admin/{overview,audit} (JSON).
//
// Who may see it: only a signed-in member whose account email passes the EXISTING owner check
// (lib/username.js isOwnerAccountEmail, a SHA-256 match). The caller is identified by the same HttpOnly
// nest_member cookie the chat uses; this file adds no credential, token, password or env switch.
// Everyone else (guest, other member, stale cookie, no cookie, remember-me off) falls through to the normal
// 404 of the app, byte for byte what /no-such-page returns, so the route is not advertised.
// Owner traffic is limited to LIMIT requests a minute (429 past that).
//
// Read-only: GET/HEAD only, no mutating endpoint, nothing is written to disk. Only counts, public room names,
// the public Tailgate state and server health numbers are returned: never a chat line, a whisper, an email, an
// address, a socket id, a cookie or the Tailgate token (only a yes/no "token configured").
const fs = require('fs');
const path = require('path');
const { createRateLimiter } = require('./serverStats');

const LIMIT = 120;            // owner requests per minute (the page polls ~24/min)
const WINDOW_MS = 60 * 1000;
const MSG_KEEP_MS = 15 * 60 * 1000;
const MSG_CAP = 5000;
const NAMES_MAX = 200;
const NAME_MAX = 64;

const ASSETS = { '/admin/admin.js': ['admin.js', 'application/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'] };

// Messages per minute from timestamps only (a number is all that is kept: never the line itself).
function createMessageRate(opts = {}) {
  const now = opts.now || Date.now;
  let human = []; // ms timestamps, humans only
  let neagle = 0;
  let total = 0;
  function prune(t) {
    const cut = t - MSG_KEEP_MS;
    let i = 0;
    while (i < human.length && human[i] < cut) i++;
    if (i) human = human.slice(i);
    if (human.length > MSG_CAP) human = human.slice(-MSG_CAP);
  }
  function note(kind) {
    if (kind === 'neagle') { neagle += 1; return; }
    const t = now();
    human.push(t); total += 1; prune(t);
  }
  function summary() {
    const t = now(); prune(t);
    const inLast = (ms) => human.filter((x) => x > t - ms).length;
    const series = new Array(15).fill(0); // oldest -> newest, one slot per minute
    for (const x of human) { const age = Math.floor((t - x) / 60000); if (age >= 0 && age < 15) series[14 - age] += 1; }
    return { perMinute: inLast(60000), last5min: inLast(5 * 60000), total, neagleTotal: neagle, series };
  }
  return { note, summary };
}

// Current commit from .git without running git: HEAD -> ref file or packed-refs. Short sha or null.
function readGitCommit(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    let sha = head;
    const m = /^ref:\s*(\S+)$/.exec(head);
    if (m) {
      const ref = m[1];
      if (!/^refs\/[A-Za-z0-9/_.-]+$/.test(ref) || ref.includes('..')) return null;
      try { sha = fs.readFileSync(path.join(dir, '.git', ref), 'utf8').trim(); }
      catch (e) {
        sha = '';
        for (const l of fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').split('\n')) {
          const p = l.trim().split(' ');
          if (p[1] === ref && /^[0-9a-f]{40}$/i.test(p[0])) { sha = p[0]; break; }
        }
      }
    }
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null;
  } catch (e) { return null; }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function str(v, max) { return String(v == null ? '' : v).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu, '').slice(0, max || NAME_MAX); }

// opts: { dir, resolveUser(cookieHeader)->user|null, isOwnerEmail(email)->bool, audit, msgRate, sources, startedAt, now, limiter, trustProxy }
// sources: presence(), connected(), registered(), broadcasting(), editModeOn(), chatPause(), tailgatePlay(),
//          tailgate(), tailgateTokenSet(), tailgatePolling(), featured(), whisperMembersOnly()
function createAdminConsole(opts) {
  const express = require('express');
  const { rateKey } = require('./safeLink');
  const now = opts.now || Date.now;
  const src = opts.sources || {};
  const audit = opts.audit;
  const dir = opts.dir;
  const startedAt = opts.startedAt || now();
  const limiter = opts.limiter || createRateLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const startCommit = opts.startCommit !== undefined ? opts.startCommit : readGitCommit(dir);
  const denied = { count: 0, lastAt: null };
  let commitCache = { at: 0, sha: startCommit };

  function currentCommit() {
    const t = now();
    if (t - commitCache.at > 30000) commitCache = { at: t, sha: readGitCommit(dir) };
    return commitCache.sha;
  }

  function ownerOf(req) {
    try {
      const user = opts.resolveUser(req.get('cookie'));
      if (user && opts.isOwnerEmail(user.email)) return { name: str(user.username) };
    } catch (e) { /* treated as not the owner */ }
    return null;
  }

  function safe(fn, fallback) { try { return typeof fn === 'function' ? fn() : fallback; } catch (e) { return fallback; } }

  function overview() {
    const t = now();
    const people = safe(src.presence, []) || [];
    const names = people.map((p) => ({ name: str(p.name), guest: !!p.guest }));
    const members = names.filter((n) => !n.guest);
    const guests = names.filter((n) => n.guest);
    names.sort((a, b) => (a.guest - b.guest) || a.name.localeCompare(b.name));
    const pause = safe(src.chatPause, { paused: false, by: null }) || {};
    const play = safe(src.tailgatePlay, { playing: false }) || {};
    const tg = safe(src.tailgate, {}) || {};
    const fe = safe(src.featured, null) || {};
    const mem = process.memoryUsage();
    const sha = currentCommit();
    const os = require('os');
    return {
      generatedAt: new Date(t).toISOString(),
      room: {
        connected: num(safe(src.connected, 0)),
        joined: names.length,
        members: members.length,
        guests: guests.length,
        registered: num(safe(src.registered, 0)),
        broadcasting: num(safe(src.broadcasting, 0)),
        names: names.slice(0, NAMES_MAX),
        namesTruncated: names.length > NAMES_MAX,
        messages: opts.msgRate ? opts.msgRate.summary() : null,
        chatPause: { paused: !!pause.paused, by: pause.paused && pause.by ? str(pause.by) : null },
        tailgatePlay: { playing: !!play.playing, by: play.playing && play.by ? str(play.by) : null, since: play.playing && Number.isFinite(play.since) ? new Date(play.since).toISOString() : null },
        editMode: !!safe(src.editModeOn, false),
        whispers: { membersOnly: !!safe(src.whisperMembersOnly, false), note: 'Private. Never shown or logged here.' }
      },
      server: {
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        node: process.version,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        system: { loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100), totalMem: os.totalmem(), freeMem: os.freemem(), cpus: os.cpus().length },
        commit: { atStart: startCommit, onDisk: sha, changedSinceStart: !!(startCommit && sha && startCommit !== sha) }
      },
      tailgate: {
        mode: str(tg.mode, 16), override: str(tg.override, 16), live: !!tg.live,
        embedId: tg.embedId ? str(tg.embedId, 32) : null, source: tg.source ? str(tg.source, 16) : null,
        twitch: !!tg.twitch, twitchChannel: tg.twitchChannel ? str(tg.twitchChannel, 32) : null,
        pollingEnabled: !!safe(src.tailgatePolling, false), tokenConfigured: !!safe(src.tailgateTokenSet, false)
      },
      featured: {
        polling: !!fe.polling, cacheSeconds: num(fe.cacheSeconds), checkedAt: fe.checkedAt || null,
        creators: (Array.isArray(fe.creators) ? fe.creators : []).map((c) => ({ id: str(c.id, 32), name: str(c.name, 64), live: !!c.live }))
      },
      audit: { size: audit ? audit.size() : 0, max: audit ? audit.MAX : 0, deniedAttempts: denied.count, lastDeniedAt: denied.lastAt }
    };
  }

  function baseHeaders(res) {
    res.removeHeader('X-Powered-By');
    res.set({
      'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin'
    });
  }

  const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  const router = express.Router();

  // Gate for everything under /admin and /api/admin. Not the owner (or not GET/HEAD): leave the router untouched
  // so the app's normal 404 answers, same as for any unknown path.
  router.use(['/admin', '/api/admin'], (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next('router');
    const owner = ownerOf(req);
    if (!owner) { denied.count += 1; denied.lastAt = new Date(now()).toISOString(); return next('router'); }
    baseHeaders(res);
    const r = limiter.hit('o:' + owner.name.toLowerCase() + '|' + rateKey(req, trustProxy));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit' });
    }
    req.adminOwner = owner;
    return next();
  });

  router.get(['/admin', '/admin/'], (req, res, next) => {
    if (audit) audit.add('admin_view', { page: 'admin' });
    res.set({ 'Content-Security-Policy': PAGE_CSP });
    res.sendFile(path.join(dir, 'admin', 'admin.html'), (err) => { if (err && !res.headersSent) next('router'); });
  });

  router.get(Object.keys(ASSETS), (req, res, next) => {
    const a = ASSETS[req.path];
    res.set('Content-Type', a[1]);
    res.sendFile(path.join(dir, 'admin', a[0]), { headers: { 'Content-Type': a[1] } }, (err) => { if (err && !res.headersSent) next('router'); });
  });

  router.get('/api/admin/overview', (req, res) => {
    const o = overview();
    o.owner = { name: req.adminOwner.name };
    res.json(o);
  });

  router.get('/api/admin/audit', (req, res) => {
    res.json({ generatedAt: new Date(now()).toISOString(), max: audit ? audit.MAX : 0, entries: audit ? audit.list(req.query && req.query.limit) : [] });
  });

  // anything else under the prefixes (owner or not): the normal 404
  router.use(['/admin', '/api/admin'], (req, res, next) => next('router'));

  return { router, overview, ownerOf, denied };
}

module.exports = { createAdminConsole, createMessageRate, readGitCommit, LIMIT };
