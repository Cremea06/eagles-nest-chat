// CHG-142 - the ONE place for the keystroke-gate speed limits. The chat page loads this file (<script>) and the server
// requires it (lib/keystrokeGate.js), so the page limiter and the server cap cannot drift apart. No dependencies.
//
// Rule (Andy, CHG-142): a held key's auto-repeat counts, but only at a normal OS default repeat speed; anything faster
// counts for nothing. The ceiling is ONE counted keystroke per MIN_GAP_MS = 30 ms (33.3 per second sustained).
// Why 30 ms: the fastest everyday defaults are Windows (repeat rate 31 = ~30 chars/s, ~33 ms, after a 500 ms delay) and
// GNOME/Ubuntu (30 ms, after 500 ms); X11 xset default is 25/s (40 ms); macOS default is ~11/s (90 ms, key repeat 6) and
// its fastest slider setting is 30 ms (key repeat 2). So 30 ms sits just under the quickest default and equals the
// fastest setting a normal settings screen offers; nothing a person holds down at a normal setting is lost. A key
// repeating at 15 ms or 5 ms (terminal-only tweaks, macros, scripts) is above the ceiling.
// A burst allowance covers real fast typists / key rollover: a few keys in a few ms, then the steady ceiling again.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeystrokeLimits = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var MIN_GAP_MS = 30;                 // one counted keystroke per this many ms, sustained
  var MAX_PER_SEC = 1000 / MIN_GAP_MS; // 33.33 keys/s: the ceiling, used by the page limiter AND the server cap
  var CLIENT_BURST = 4;                // page: keys that may land close together (rollover) before the ceiling applies
  var SERVER_BURST = 15;               // server: bucket size = most one report can add, and the starting allowance
  var REPORT_MS = 250;                 // page: send the running count at most this often while keys are being counted

  // Page-side limiter (token bucket: refills one key per MIN_GAP_MS, holds at most CLIENT_BURST).
  // accept(t) takes the event time in ms. true = count it. false = ignore it (no penalty, nothing is stored or owed).
  // The first call always counts. A clock that goes backwards gives no credit.
  function createLimiter() {
    var tokens = CLIENT_BURST, last = null;
    return {
      accept: function (t) {
        if (typeof t !== 'number' || !isFinite(t)) return false;
        if (last !== null) {
          tokens = Math.min(CLIENT_BURST, tokens + Math.max(0, t - last) / MIN_GAP_MS);
        }
        last = last === null ? t : Math.max(last, t);
        if (tokens >= 1 - 1e-9) { tokens -= 1; return true; }
        return false;
      }
    };
  }

  // Which key events are keystrokes at all. A real (trusted) key press in the chat box that types a character or is
  // Backspace. NOT: synthetic events (isTrusted false), Ctrl/Cmd shortcuts (Ctrl+AltGr is a typed character on some
  // layouts, so that is allowed), bare modifiers and other named keys (Shift, Alt, Enter, arrows, Tab, Escape...).
  // Auto-repeat (e.repeat) is NOT excluded any more (CHG-142): it goes through the speed limiter like everything else.
  function isCountableKey(e) {
    if (!e || e.isTrusted !== true) return false;
    if (e.metaKey) return false;
    if (e.ctrlKey && !(typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'))) return false;
    return typeof e.key === 'string' && (e.key.length === 1 || e.key === 'Backspace');
  }

  return { isCountableKey: isCountableKey, MIN_GAP_MS: MIN_GAP_MS, MAX_PER_SEC: MAX_PER_SEC, CLIENT_BURST: CLIENT_BURST, SERVER_BURST: SERVER_BURST, REPORT_MS: REPORT_MS, createLimiter: createLimiter };
});
