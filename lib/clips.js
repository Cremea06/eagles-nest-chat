// CHG-134 — Clips: save a moment of Milliway chat (last 30 s, up to 25 lines) as a shareable card.
// Anyone in the room (guests and members) can clip, live or not; CLIPS_MEMBERS_ONLY=1 limits creating/voting to members.
// The server keeps its own recent-line buffer; a client only sends an id range, the server copies the text (no invented lines).
// Stream slot of a clip: 'room' (Milliway placeholder), 'tailgate' (Rumble placeholder + Watch on Rumble link) or
// 'golive' (broadcaster name/title, only when that broadcaster has 'Allow clipping' on; default off).
// Phase 1 = no video. Future: 1080x1920 vertical MP4 (stream slot top 1/3, chat lines, caption bar) — not built yet.
// Storage: clips.json (gitignored, 0600, atomic write, cap 5000; oldest unvoted dropped first). SQLite is the later home.
// Routes (mounted before the global cors(); same-origin only, no CORS headers):
//   GET    /api/clips/recent            -> {context, lines}            (clip session header)
//   POST   /api/clips {fromId,toId,caption?} -> {id,url,clip}         (5/10 min per clipper, 3/min per IP)
//   POST   /api/clips/:id/vote          -> {votes, voted}              (one vote per clipper key, toggle)
//   DELETE /api/clips/:id               clipper (own clip) or admin Bearer CLIPS_ADMIN_TOKEN (falls back to TAILGATE_TOKEN);
//                                       admin ?hide=1 hides, ?hide=0 unhides, no query deletes
//   GET    /c/:id  /c/:id.png           public page (escaped, OG/Twitter card) and 1200x630 PNG card (cached in clips-img/)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { rateKey } = require('./safeLink');
const { createRateLimiter } = require('./serverStats');
const { tokenOk, validEmbedId } = require('./tailgate');

const WINDOW_MS = 30 * 1000;      // clip window shown in the tray
const KEEP_MS = 5 * 60 * 1000;    // lines stay selectable this long (user may take a while to trim)
const MAX_LINES = 25;
const CAPTION_MAX = 80;
const LINE_MAX = 300;
const STORE_CAP = 5000;
const ID_RE = /^[A-Za-z0-9_-]{8}$/;
const BASE_URL = 'https://chat.afirstflag.com';

function newId() { return crypto.randomBytes(6).toString('base64url'); } // 8 url-safe chars

// ---- recent buffer ----------------------------------------------------------------------------------------
function createRecentBuffer(opts = {}) {
  const now = opts.now || Date.now;
  const keepMs = opts.keepMs || KEEP_MS;
  const max = opts.max || 500;
  let seq = 0; const lines = [];
  function prune() { const t = now(); while (lines.length && (lines.length > max || t - lines[0].t > keepMs)) lines.shift(); }
  return {
    add(user, text) {
      const l = { id: ++seq, user: String(user || 'Anonymous').slice(0, 64), text: String(text == null ? '' : text).slice(0, LINE_MAX), t: now() };
      lines.push(l); prune(); return l;
    },
    recent(windowMs = WINDOW_MS, cap = MAX_LINES) { prune(); const t = now(); return lines.filter((l) => t - l.t <= windowMs).slice(-cap); },
    // contiguous id range that is still in the buffer -> copies, else null
    range(fromId, toId) {
      prune();
      if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId > toId || toId - fromId + 1 > MAX_LINES) return null;
      const out = lines.filter((l) => l.id >= fromId && l.id <= toId);
      if (out.length !== toId - fromId + 1) return null;
      return out.map((l) => ({ id: l.id, user: l.user, text: l.text, t: l.t }));
    },
  };
}

// ---- caption ----------------------------------------------------------------------------------------------
const HIDDEN = /[\p{Cf}\p{Cs}\p{Co}\p{Cc}]/gu;
function sanitizeCaption(raw) {
  if (raw == null || raw === '') return { ok: true, caption: '' };
  if (typeof raw !== 'string') return { ok: false };
  const s = raw.normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(HIDDEN, (c) => (c === '\u200d' ? c : '')).replace(/\s+/g, ' ').trim();
  if ([...s].length > CAPTION_MAX) return { ok: false };
  return { ok: true, caption: s };
}

// ---- context ----------------------------------------------------------------------------------------------
// broadcasters: [{username, allowClips}] (newest last); tailgate: {mode, embedId}; tgStartedAt: ms when the embed was first seen
function computeContext({ broadcasters = [], tailgate = null, tgStartedAt = 0, now = Date.now() } = {}) {
  const b = broadcasters.length ? broadcasters[broadcasters.length - 1] : null;
  if (b && b.allowClips) return { kind: 'golive', broadcaster: b.username, title: b.username + ' live in Milliway' };
  if (!b && tailgate && tailgate.mode === 'tailgate' && validEmbedId(tailgate.embedId)) {
    const c = { kind: 'tailgate', title: 'Nick Fuentes live on Rumble', embedId: tailgate.embedId, url: 'https://rumble.com/embed/' + tailgate.embedId + '/' };
    if (tgStartedAt) c.offsetSec = Math.max(0, Math.round((now - tgStartedAt) / 1000));
    return c;
  }
  return { kind: 'room', title: 'Milliway' };
}

// ---- store ------------------------------------------------------------------------------------------------
function createClipStore(opts = {}) {
  const file = opts.file || null; const cap = opts.cap || STORE_CAP; const now = opts.now || Date.now;
  let clips = [];
  if (file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.clips)) clips = j.clips.filter((c) => c && ID_RE.test(c.id)); } catch (e) { /* none yet */ } }
  const byId = new Map(clips.map((c) => [c.id, c]));
  function save() {
    if (!file) return;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ clips }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600); }
    catch (e) { console.error('[clips] could not save:', e.message); }
  }
  function trim() {
    while (clips.length > cap) {
      let i = clips.findIndex((c) => !c.voters || !c.voters.length);
      if (i < 0) i = 0;
      byId.delete(clips[i].id); clips.splice(i, 1);
    }
  }
  return {
    get: (id) => byId.get(id) || null,
    size: () => clips.length,
    all: () => clips.slice(),
    add(c) {
      let id; do { id = newId(); } while (byId.has(id));
      const clip = Object.assign({ id, createdAt: new Date(now()).toISOString(), voters: [], hidden: false }, c, { id });
      clips.push(clip); byId.set(id, clip); trim(); save(); return clip;
    },
    remove(id) { const c = byId.get(id); if (!c) return false; byId.delete(id); clips.splice(clips.indexOf(c), 1); save(); return true; },
    setHidden(id, h) { const c = byId.get(id); if (!c) return null; c.hidden = !!h; save(); return c; },
    vote(id, key) {
      const c = byId.get(id); if (!c || c.hidden) return null;
      const i = c.voters.indexOf(key); if (i >= 0) c.voters.splice(i, 1); else c.voters.push(key);
      save(); return { votes: c.voters.length, voted: i < 0 };
    },
    // 'Remove my clips' for a broadcaster: strip the broadcast's identity from their clips (clips stay, slot -> Milliway)
    stripBroadcaster(name) {
      let n = 0;
      for (const c of clips) if (c.context && c.context.kind === 'golive' && c.context.broadcaster === name) { c.context = { kind: 'room', title: 'Milliway' }; n++; }
      if (n) save(); return n;
    },
  };
}

function publicClip(c) {
  return { id: c.id, createdAt: c.createdAt, clipper: c.clipper, context: c.context, caption: c.caption, lines: c.lines.map((l) => ({ user: l.user, text: l.text, t: l.t })), votes: (c.voters || []).length };
}

// ---- rendering --------------------------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

function watchLink(ctx) {
  if (ctx && ctx.kind === 'tailgate' && validEmbedId(ctx.embedId)) return 'https://rumble.com/embed/' + ctx.embedId + '/' + (ctx.offsetSec ? '?start=' + (ctx.offsetSec | 0) : '');
  return null;
}
function badgeText(ctx) {
  if (!ctx || ctx.kind === 'room') return '';
  return ctx.kind === 'tailgate' ? '● LIVE on Rumble' : '● LIVE · ' + ctx.broadcaster;
}

function renderClipPage(c, baseUrl = BASE_URL) {
  const url = baseUrl + '/c/' + c.id; const img = url + '.png';
  const ctx = c.context || { kind: 'room' };
  const title = 'Milliway clip by ' + c.clipper;
  const desc = c.caption || c.lines.slice(0, 3).map((l) => l.user + ': ' + l.text).join(' · ');
  const w = watchLink(ctx);
  const badge = badgeText(ctx);
  const lines = c.lines.map((l) => '<li><b>' + esc(l.user) + '</b> ' + esc(l.text) + '</li>').join('');
  let streamBtn = '';
  if (w) streamBtn = '<a class="btn gold" href="' + esc(w) + '" rel="noopener noreferrer" target="_blank">▶ Watch on Rumble at this moment</a>';
  else if (ctx.kind === 'golive' && !/^Guest-User /.test(ctx.broadcaster || '')) streamBtn = '<a class="btn gold" href="/u/' + encodeURIComponent(ctx.broadcaster) + '">' + esc(ctx.broadcaster) + '’s profile</a>';
  const when = new Date(c.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article"><meta property="og:site_name" content="afirstflag">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<style>body{margin:0;background:#141414;color:#eee;font-family:system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:16px}
.url{color:#888;font-size:13px;margin-bottom:10px}.card{border:1px solid #444;border-radius:12px;overflow:hidden;background:#1d1d1d}
.slot{position:relative;height:150px;background:#2a2a2a;display:flex;align-items:center;justify-content:center;color:#999;border-bottom:1px dashed #555}
.badge{position:absolute;left:10px;top:10px;border:1px solid #fff;border-radius:4px;padding:2px 6px;color:#fff;font-size:12px;font-weight:700}
.slot .t{position:absolute;left:10px;bottom:8px;color:#ddd;font-size:14px}ul{list-style:none;margin:0;padding:6px 12px}
li{padding:6px 0;border-bottom:1px solid #2c2c2c}li b{color:#d4af37}.cap{font-size:20px;margin:14px 0 4px}.meta{color:#999;font-size:13px}
.btn{display:block;text-align:center;margin:10px 0;padding:10px;border:1px solid #d4af37;border-radius:8px;color:#fff;text-decoration:none}.gold{background:#d4af37;color:#111;font-weight:700}
.votes{display:inline-block;border:1px solid #d4af37;border-radius:6px;padding:2px 8px;color:#d4af37;margin:8px 0}</style></head>
<body><main><div class="url">chat.afirstflag.com/c/${esc(c.id)} · Milliway</div>
<div class="card"><div class="slot">${badge ? '<span class="badge">' + esc(badge) + '</span>' : ''}<span>${ctx.kind === 'room' ? 'Milliway' : '(stream frame)'}</span><span class="t">${esc(ctx.title || 'Milliway')}</span></div>
<ul>${lines}</ul></div>
${c.caption ? '<p class="cap">' + esc(c.caption) + '</p>' : ''}
<div class="meta">clipped by ${esc(c.clipper)} · ${esc(when)}</div>
<span class="votes">▲ ${(c.voters || []).length}</span>
${streamBtn}<a class="btn" href="/">Join the room</a>
</main></body></html>`;
}

function renderNotFound() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Clip not found</title>' +
    '<style>body{margin:0;background:#141414;color:#eee;font-family:system-ui,sans-serif;text-align:center;padding:60px 16px}a{color:#d4af37}</style></head>' +
    '<body><h1>Clip not found</h1><p>This clip was removed or never existed.</p><p><a href="/">Join the room</a></p></body></html>';
}

// PNG text: DejaVu has no color emoji; drop pictographs/joiners/variation selectors instead of drawing boxes.
function pngSafe(s) {
  return String(s == null ? '' : s).replace(/[\p{Extended_Pictographic}\u200d\ufe0e\ufe0f\u20e3]|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]/gu, '').replace(HIDDEN, '').replace(/\s+/g, ' ').trim();
}
function clip(s, n) { const a = [...s]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : s; }
function wrap(s, n, maxLines) {
  const words = s.split(' '); const out = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = clip(out[maxLines - 1] + '…', n); }
  return out.map((l) => clip(l, n));
}

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
// CHG-135: X draws its own caption bar over the bottom-left of the card (about the bottom 15 % of the height, left 60 % of the width),
// so the card keeps all text out of that corner: brand top-right, 'clipped by' bottom-right and kept short enough to stay right of x = 720.
const CARD_LAYOUT = 2; // bump when the card drawing changes: it is part of the PNG cache key, so old cached cards regenerate
const CLIPPED_BY_MAX_PX = 440; // 1170 - 440 = 730, right of X's 60 % (x < 720) zone
function textWidth(s, size) {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="100"><text x="0" y="60" font-family="DejaVu Sans" font-size="${size}">${esc(s)}</text></svg>`;
  const b = new Resvg(svg, { font: { fontFiles: [path.join(FONT_DIR, 'DejaVuSans.ttf')], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).getBBox();
  return b ? b.width : 0;
}
function clippedBy(name) {
  let s = clip('clipped by ' + (pngSafe(name) || 'someone'), 40);
  while ([...s].length > 14 && textWidth(s, 22) > CLIPPED_BY_MAX_PX) s = clip(s.replace(/…$/, ''), [...s].length - 2);
  return s;
}

function cardSvg(c) {
  const ctx = c.context || { kind: 'room' };
  const badge = pngSafe(badgeText(ctx));
  const F = 'DejaVu Sans';
  let y = 110; let rows = '';
  const lines = c.lines.slice(-6);
  for (const l of lines) {
    const u = clip(pngSafe(l.user) || '?', 18); const t = clip(pngSafe(l.text) || '…', 44 - Math.min(18, [...u].length));
    rows += `<text x="660" y="${y}" font-family="${F}" font-size="24"><tspan font-weight="bold" fill="#d4af37">${esc(u)}</tspan><tspan fill="#dddddd"> ${esc(t)}</tspan></text>` +
      `<line x1="660" y1="${y + 18}" x2="1150" y2="${y + 18}" stroke="#333333" stroke-width="1"/>`;
    y += 52;
  }
  const cap = pngSafe(c.caption);
  if (cap) { y += 10; for (const w of wrap('“' + cap + '”', 34, 2)) { rows += `<text x="660" y="${y}" font-family="${F}" font-size="30" fill="#ffffff">${esc(w)}</text>`; y += 40; } }
  const slotLabel = ctx.kind === 'room' ? 'Milliway' : 'Stream placeholder';
  const slotTitle = clip(pngSafe(ctx.title || 'Milliway'), 36);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#1b1b1b"/>
<rect x="0" y="0" width="630" height="520" fill="#2a2a2a"/>
<line x1="630" y1="0" x2="630" y2="520" stroke="#555555" stroke-dasharray="4 4"/>
${badge ? `<rect x="20" y="20" width="${Math.min(590, 24 + [...badge].length * 13)}" height="38" rx="4" fill="none" stroke="#ffffff" stroke-width="2"/><text x="32" y="47" font-family="${F}" font-size="20" font-weight="bold" fill="#ffffff">${esc(badge)}</text>` : ''}
<text x="315" y="270" text-anchor="middle" font-family="${F}" font-size="${ctx.kind === 'room' ? 44 : 26}" font-weight="${ctx.kind === 'room' ? 'bold' : 'normal'}" fill="${ctx.kind === 'room' ? '#d4af37' : '#8a8a8a'}">${slotLabel}</text>
<text x="24" y="500" font-family="${F}" font-size="22" fill="#cccccc">${esc(slotTitle)}</text>
<text x="1170" y="52" text-anchor="end" font-family="${F}" font-size="24" font-weight="bold" fill="#d4af37">chat.afirstflag.com</text>
<text x="1170" y="78" text-anchor="end" font-family="${F}" font-size="18" fill="#8a8a8a">Milliway clip — afirstflag</text>
${rows}
<rect x="0" y="520" width="1200" height="110" fill="#222222"/>
<line x1="0" y1="520" x2="1200" y2="520" stroke="#d4af37" stroke-width="2" opacity="0.5"/>
<text x="1170" y="600" text-anchor="end" font-family="${F}" font-size="22" fill="#8a8a8a">${esc(clippedBy(c.clipper))}</text>
</svg>`;
}

function renderPng(c) {
  const { Resvg } = require('@resvg/resvg-js');
  const r = new Resvg(cardSvg(c), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: [path.join(FONT_DIR, 'DejaVuSans.ttf'), path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } });
  return r.render().asPng();
}
function cardVersion(c) { return crypto.createHash('sha1').update(JSON.stringify([CARD_LAYOUT, c.caption, c.hidden, c.context, c.lines, c.clipper])).digest('hex').slice(0, 10); }

function createPngCache(dir) {
  return {
    get(c) {
      const f = path.join(dir, c.id + '-' + cardVersion(c) + '.png');
      try { return fs.readFileSync(f); } catch (e) { /* miss */ }
      const png = renderPng(c);
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); this.drop(c.id); fs.writeFileSync(f, png, { mode: 0o600 }); } catch (e) { console.error('[clips] png cache:', e.message); }
      return png;
    },
    drop(id) { try { for (const n of fs.readdirSync(dir)) if (n.startsWith(id + '-')) fs.unlinkSync(path.join(dir, n)); } catch (e) { /* no dir */ } },
  };
}

// ---- routes -----------------------------------------------------------------------------------------------
// opts: store, buffer, getContext(), whoami(req) -> {name, key, member} | null, onSaved(clip), onVote(id,votes), onRemoved(id)
//       membersOnly(), adminToken(), trustProxy, imgDir, baseUrl, originOk(origin), limiters
function clipsRouter(opts) {
  const r = express.Router();
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const userLim = opts.userLimiter || createRateLimiter({ limit: 5, windowMs: 10 * 60000 });
  const ipLim = opts.ipLimiter || createRateLimiter({ limit: 3, windowMs: 60000 });
  const voteLim = opts.voteLimiter || createRateLimiter({ limit: 30, windowMs: 60000 });
  const readLim = opts.readLimiter || createRateLimiter({ limit: 60, windowMs: 60000 });
  const pngLim = opts.pngLimiter || createRateLimiter({ limit: 30, windowMs: 60000 });
  const membersOnly = opts.membersOnly || (() => process.env.CLIPS_MEMBERS_ONLY === '1');
  const adminSecret = opts.adminToken || (() => process.env.CLIPS_ADMIN_TOKEN || process.env.TAILGATE_TOKEN);
  const originOk = opts.originOk || (() => true);
  const base = opts.baseUrl || BASE_URL;
  const png = createPngCache(opts.imgDir || path.join(process.cwd(), 'clips-img'));
  const json = express.json({ limit: '2kb', strict: true });
  const ipKey = (req) => 'ip:' + crypto.createHash('sha256').update(rateKey(req, trustProxy)).digest('hex').slice(0, 32);
  const limited = (res, x) => { res.set('Retry-After', String(x.retryAfterSec)); return res.status(429).json({ error: 'rate_limit' }); };

  r.use(['/api/clips', '/c'], (req, res, next) => { res.removeHeader('X-Powered-By'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  r.use('/api/clips', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && !originOk(req.get('origin'))) return res.status(403).json({ error: 'origin' });
    next();
  });
  function who(req, res, needWrite) {
    const w = opts.whoami(req);
    if (!w) { res.status(401).json({ error: 'no_session' }); return null; }
    if (needWrite && membersOnly() && !w.member) { res.status(403).json({ error: 'members_only' }); return null; }
    return w;
  }

  r.get('/api/clips/recent', (req, res) => {
    const x = readLim.hit(ipKey(req)); if (!x.ok) return limited(res, x);
    if (!who(req, res, false)) return;
    res.json({ context: opts.getContext(), lines: opts.buffer.recent().map((l) => ({ id: l.id, user: l.user, text: l.text, t: l.t })), membersOnly: membersOnly() });
  });

  r.post('/api/clips', json, (req, res) => {
    const w = who(req, res, true); if (!w) return;
    const a = ipLim.hit(ipKey(req)); if (!a.ok) return limited(res, a);
    const b = userLim.hit(w.key); if (!b.ok) return limited(res, b);
    const body = req.body || {};
    const lines = opts.buffer.range(body.fromId, body.toId);
    if (!lines) return res.status(400).json({ error: 'bad_range' });
    const cap = sanitizeCaption(body.caption); if (!cap.ok) return res.status(400).json({ error: 'bad_caption' });
    const c = opts.store.add({ clipper: w.name, clipperKey: w.key, context: opts.getContext(), caption: cap.caption, lines: lines.map((l) => ({ user: l.user, text: l.text, t: l.t })) });
    if (opts.onSaved) opts.onSaved(c);
    res.status(201).json({ id: c.id, url: base + '/c/' + c.id, clip: publicClip(c) });
  });
  r.use('/api/clips', (err, req, res, next) => res.status(400).json({ error: 'bad_json' }));

  r.post('/api/clips/:id/vote', (req, res) => {
    const w = who(req, res, true); if (!w) return;
    const x = voteLim.hit(w.key); if (!x.ok) return limited(res, x);
    const v = ID_RE.test(req.params.id) ? opts.store.vote(req.params.id, w.key) : null;
    if (!v) return res.status(404).json({ error: 'not_found' });
    if (opts.onVote) opts.onVote(req.params.id, v.votes);
    res.json(v);
  });

  r.delete('/api/clips/:id', (req, res) => {
    const id = req.params.id; const c = ID_RE.test(id) ? opts.store.get(id) : null;
    const auth = req.get('authorization');
    if (auth) {
      const s = adminSecret();
      if (typeof s !== 'string' || s.length < 16) return res.status(404).json({ error: 'disabled' });
      if (!tokenOk(auth, s)) { res.set('WWW-Authenticate', 'Bearer'); return res.status(401).json({ error: 'unauthorized' }); }
      if (!c) return res.status(404).json({ error: 'not_found' });
      png.drop(id);
      if (req.query.hide === '1' || req.query.hide === '0') { opts.store.setHidden(id, req.query.hide === '1'); if (opts.onRemoved && c.hidden) opts.onRemoved(id); console.log('[clips] admin hide', id, req.query.hide); return res.json({ ok: true, hidden: c.hidden }); }
      opts.store.remove(id); if (opts.onRemoved) opts.onRemoved(id); console.log('[clips] admin delete', id);
      return res.json({ ok: true, deleted: true });
    }
    const w = who(req, res, false); if (!w) return;
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (c.clipperKey !== w.key) return res.status(403).json({ error: 'not_yours' });
    png.drop(id); opts.store.remove(id); if (opts.onRemoved) opts.onRemoved(id);
    res.json({ ok: true, deleted: true });
  });

  r.get('/c/:slug', (req, res) => {
    const m = /^([A-Za-z0-9_-]{8})(\.png)?$/.exec(req.params.slug);
    const c = m ? opts.store.get(m[1]) : null;
    if (m && m[2]) {
      const x = pngLim.hit(ipKey(req)); if (!x.ok) return limited(res, x);
      if (!c || c.hidden) return res.status(404).type('text/plain').send('not found');
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
      return res.send(png.get(c));
    }
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (!c || c.hidden) return res.status(404).type('html').set('Cache-Control', 'no-store').send(renderNotFound());
    res.set('Cache-Control', 'public, max-age=60').type('html').send(renderClipPage(c, base));
  });
  return r;
}

module.exports = { newId, createRecentBuffer, sanitizeCaption, computeContext, createClipStore, publicClip, renderClipPage, renderNotFound, cardSvg, renderPng, cardVersion, createPngCache, CARD_LAYOUT, pngSafe, esc, clipsRouter, watchLink, ID_RE, MAX_LINES, CAPTION_MAX, WINDOW_MS };
