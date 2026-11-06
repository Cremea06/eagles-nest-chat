// CHG-163 — site-wide Tailgate "playing" (iframe up for everyone). Display/player only;
// admin mode (on/off/auto, embed, Twitch) stays in lib/tailgate.js.
// In-memory: restart -> not playing. Cleared when admin mode leaves tailgate.
// trySet(wantPlaying, displayName, rateKey, { modeIsTailgate }) -> { ok, state, notice?, reason?, unchanged? }
// state = { playing: boolean, by: string|null, since: number|null }
const { createRateLimiter } = require('./serverStats');

const GLOBAL_COOLDOWN_MS = 5000;
const SOCK_LIMIT = 3;
const SOCK_WINDOW_MS = 60 * 1000;
const BY_MAX = 64;

function createTailgatePlay(opts = {}) {
  const now = opts.now || Date.now;
  const cooldownMs = opts.globalCooldownMs != null ? opts.globalCooldownMs : GLOBAL_COOLDOWN_MS;
  const sockLim = opts.rateLimiter || createRateLimiter({
    limit: opts.sockLimit != null ? opts.sockLimit : SOCK_LIMIT,
    windowMs: opts.sockWindowMs != null ? opts.sockWindowMs : SOCK_WINDOW_MS
  });

  let playing = false;
  let by = null;
  let since = null;
  let lastFlipAt = 0;

  function state() {
    return {
      playing: !!playing,
      by: playing ? by : null,
      since: playing ? since : null
    };
  }

  function clear() {
    // Admin / mode-left: no rate limit
    const changed = playing === true;
    playing = false;
    by = null;
    since = null;
    return { ok: true, changed, state: state() };
  }

  function trySet(wantPlaying, displayName, rateKey, ctx) {
    ctx = ctx || {};
    if (typeof wantPlaying !== 'boolean') {
      return { ok: false, reason: 'bad_input', state: state(), notice: 'Could not change Tailgate.' };
    }
    if (wantPlaying && !ctx.modeIsTailgate) {
      return {
        ok: false,
        reason: 'not_tailgate',
        state: state(),
        notice: 'Tailgate is not on right now.'
      };
    }
    if (!!wantPlaying === !!playing) {
      return { ok: true, unchanged: true, state: state() };
    }
    const hit = sockLim.hit(String(rateKey || 'unknown'));
    if (!hit.ok) {
      return {
        ok: false,
        reason: 'rate',
        state: state(),
        notice: 'Too many Tailgate flips. Try again in a minute.'
      };
    }
    const t = now();
    if (lastFlipAt > 0 && t - lastFlipAt < cooldownMs) {
      return {
        ok: false,
        reason: 'cooldown',
        state: state(),
        notice: 'Wait a few seconds before flipping Tailgate again.'
      };
    }
    playing = !!wantPlaying;
    if (playing) {
      let name = String(displayName == null ? '' : displayName).trim().replace(/\s+/g, ' ');
      if (!name) name = 'Someone';
      if (name.length > BY_MAX) name = name.slice(0, BY_MAX);
      by = name;
      since = t;
    } else {
      by = null;
      since = null;
    }
    lastFlipAt = t;
    return { ok: true, state: state() };
  }

  return { state, trySet, clear, GLOBAL_COOLDOWN_MS: cooldownMs, SOCK_LIMIT, SOCK_WINDOW_MS };
}

module.exports = { createTailgatePlay, GLOBAL_COOLDOWN_MS, SOCK_LIMIT, SOCK_WINDOW_MS };
