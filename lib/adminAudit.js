// CHG-173 — in-memory audit ring for the read-only /admin console.
// Holds the last MAX admin-relevant server events (tailgate changes, chat pause flips, edit mode, admin page views).
// Memory only: a restart empties it. Detail is limited to a fixed list of short fields, so a chat line, a whisper,
// an email, an address or a token cannot end up here by accident (any other key is dropped).
const MAX = 200;
const TYPES = new Set(['server_start', 'tailgate', 'tailgate_play', 'chat_pause', 'edit_mode', 'admin_view']);
const FIELDS = { paused: 'bool', playing: 'bool', on: 'bool', twitch: 'bool', live: 'bool',
  by: 'str', name: 'str', mode: 'str', override: 'str', source: 'str', embedId: 'str', page: 'str' };
const STR_MAX = 64;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu;

function cleanStr(v) {
  return String(v).replace(HIDDEN, '').replace(/\s+/g, ' ').trim().slice(0, STR_MAX);
}

function cleanDetail(detail) {
  const out = {};
  if (!detail || typeof detail !== 'object') return out;
  for (const k of Object.keys(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(detail, k)) continue;
    const v = detail[k];
    if (v == null) continue;
    if (FIELDS[k] === 'bool') { if (typeof v === 'boolean') out[k] = v; continue; }
    if (typeof v === 'string' || typeof v === 'number') { const s = cleanStr(v); if (s) out[k] = s; }
  }
  return out;
}

function createAudit(opts = {}) {
  const now = opts.now || Date.now;
  const max = opts.max > 0 ? opts.max : MAX;
  const ring = [];
  let seq = 0;
  function add(type, detail) {
    if (!TYPES.has(type)) return null;
    seq += 1;
    const e = { seq, at: new Date(now()).toISOString(), type, detail: cleanDetail(detail) };
    ring.push(e);
    if (ring.length > max) ring.shift();
    return e;
  }
  // newest first
  function list(limit) {
    const n = Math.max(1, Math.min(max, Math.floor(Number(limit)) || max));
    return ring.slice(-n).reverse().map((e) => ({ seq: e.seq, at: e.at, type: e.type, detail: Object.assign({}, e.detail) }));
  }
  return { add, list, size: () => ring.length, MAX: max };
}

module.exports = { createAudit, cleanDetail, TYPES, MAX };
