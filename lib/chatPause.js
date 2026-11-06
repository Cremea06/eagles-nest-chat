// CHG-162 — site-wide Milliway Chat pause (display-only; the server still relays every line).
// In-memory only: a process restart returns to On (paused=false). No data file.
// trySet(wantPaused, displayName, rateKey) -> { ok, state, notice?, reason?, unchanged? }
// rateKey is per-socket (3 flips / rolling minute). Global cooldown is 5 s between successful flips.
// state = { paused: boolean, by: string|null }  (by is set only while paused)
const { createRateLimiter } = require('./serverStats');

const GLOBAL_COOLDOWN_MS = 5000;
const SOCK_LIMIT = 3;
const SOCK_WINDOW_MS = 60 * 1000;
const BY_MAX = 64;

function createChatPause(opts = {}) {
  const now = opts.now || Date.now;
  const cooldownMs = opts.globalCooldownMs != null ? opts.globalCooldownMs : GLOBAL_COOLDOWN_MS;
  const sockLim = opts.rateLimiter || createRateLimiter({
    limit: opts.sockLimit != null ? opts.sockLimit : SOCK_LIMIT,
    windowMs: opts.sockWindowMs != null ? opts.sockWindowMs : SOCK_WINDOW_MS
  });

  let paused = false;
  let by = null;
  let lastFlipAt = 0;

  function state() {
    return { paused: !!paused, by: paused ? by : null };
  }

  function trySet(wantPaused, displayName, rateKey) {
    if (typeof wantPaused !== 'boolean') {
      return { ok: false, reason: 'bad_input', state: state(), notice: 'Could not change Chat.' };
    }
    if (!!wantPaused === !!paused) {
      return { ok: true, unchanged: true, state: state() };
    }
    const hit = sockLim.hit(String(rateKey || 'unknown'));
    if (!hit.ok) {
      return {
        ok: false,
        reason: 'rate',
        state: state(),
        notice: 'Too many flips. Try again in a minute.'
      };
    }
    const t = now();
    if (lastFlipAt > 0 && t - lastFlipAt < cooldownMs) {
      return {
        ok: false,
        reason: 'cooldown',
        state: state(),
        notice: 'Wait a few seconds before flipping again.'
      };
    }
    paused = !!wantPaused;
    if (paused) {
      let name = String(displayName == null ? '' : displayName).trim().replace(/\s+/g, ' ');
      if (!name) name = 'Someone';
      if (name.length > BY_MAX) name = name.slice(0, BY_MAX);
      by = name;
    } else {
      by = null;
    }
    lastFlipAt = t;
    return { ok: true, state: state() };
  }

  return { state, trySet, GLOBAL_COOLDOWN_MS: cooldownMs, SOCK_LIMIT, SOCK_WINDOW_MS };
}

module.exports = { createChatPause, GLOBAL_COOLDOWN_MS, SOCK_LIMIT, SOCK_WINDOW_MS, IP_LIMIT: SOCK_LIMIT, IP_WINDOW_MS: SOCK_WINDOW_MS };
