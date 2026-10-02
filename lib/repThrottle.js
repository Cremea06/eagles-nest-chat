// CHG-055: /rep switch throttle, per member account, kept in memory (it resets when the server restarts).
// The first FREE (10) successful switches in a rolling WINDOW_MS (1 minute) go through freely. After that,
// one switch per GAP_MS (60 s) until older switches age out of the window. With both at 60 s this works out
// as at most 10 switches in any 60 s. `now` is injectable so tests can move the clock.
const FREE = 10;
const WINDOW_MS = 60 * 1000;
const GAP_MS = 60 * 1000;

function createRepThrottle(now = () => Date.now()) {
  /** @type {Map<string, number[]>} account key -> times (ms) of successful switches inside the window */
  const switches = new Map();

  function recent(key, t) {
    const list = (switches.get(key) || []).filter((ts) => t - ts < WINDOW_MS);
    if (list.length) switches.set(key, list);
    else switches.delete(key);
    return list;
  }

  // -> 0 when this account may switch now, otherwise the whole seconds left to wait.
  function waitSeconds(key) {
    const t = now();
    const list = recent(key, t);
    if (list.length < FREE) return 0;
    const gapEnds = list[list.length - 1] + GAP_MS;          // one per minute after the free ones
    const windowFrees = list[list.length - FREE] + WINDOW_MS; // or back under FREE in the window
    const until = Math.min(gapEnds, windowFrees);
    return until <= t ? 0 : Math.ceil((until - t) / 1000);
  }

  function record(key) {
    const t = now();
    const list = recent(key, t);
    list.push(t);
    switches.set(key, list);
  }

  return { waitSeconds, record };
}

module.exports = { createRepThrottle, FREE, WINDOW_MS, GAP_MS };
