// CHG-141 — guests join muted until they have recorded 100 keystrokes (a speed bump, NOT security).
//
// What it is: a per-socket counter, memory only. The chat page counts real key presses in the chat box and reports
// a cumulative COUNT over the socket; the server decides how much of it to believe (a human typing rate) and
// unmutes the guest at NEED. Only a number is kept: never what was typed, never logged, never written to disk.
// What it is not: proof of a human. A determined script can send reports at the capped rate and get in after ~8 s.
// Members (signed in) are never gated. Slash commands are never gated (the caller only asks about plain lines).
const NEED = 100;
const MAX_PER_SEC = 12;     // believable typing rate (keys per second) the server will credit
const BURST = 15;           // most that one report can add (bucket size); also the starting allowance
const REPLY_GAP_MS = 5000;  // Neagle's "you are muted" reply to one guest: at most one per this long
const MAX_REPORT = 1000000; // reports above this are nonsense and ignored

function createState(now = Date.now()) {
  return { count: 0, tokens: BURST, last: now, lastReplyAt: -Infinity, unlocked: false };
}

// value = the cumulative count the page claims. Returns { accepted, count, unlockedNow, unlocked }.
// Bad input (not a finite non-negative integer, huge, or not above what is already credited) changes nothing.
function applyReport(state, value, now = Date.now()) {
  const out = { accepted: 0, count: state.count, unlockedNow: false, unlocked: state.unlocked };
  if (state.unlocked) return out;
  const dt = Math.max(0, now - state.last);
  state.tokens = Math.min(BURST, state.tokens + (dt / 1000) * MAX_PER_SEC);
  state.last = now;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_REPORT) return out;
  const want = value - state.count;
  if (want <= 0) return out;
  const grant = Math.min(want, Math.floor(state.tokens), NEED - state.count);
  if (grant <= 0) return out;
  state.tokens -= grant;
  state.count += grant;
  out.accepted = grant;
  out.count = state.count;
  if (state.count >= NEED) { state.unlocked = true; out.unlockedNow = true; out.unlocked = true; }
  return out;
}

// true when Neagle may send the guest another "you are muted" reply now (and records that it did).
function takeReply(state, now = Date.now()) {
  if (now - state.lastReplyAt < REPLY_GAP_MS) return false;
  state.lastReplyAt = now;
  return true;
}

// Canned local text (no AI). Shown only to that guest.
function blockedText(count) {
  return "Welcome, guest! Before you can speak in Milliway, you are required to record " + NEED + " keystrokes (you're at " +
    count + '/' + NEED + "). Keep typing here and I'll let you in. Slash commands like /help and /login always work.";
}
const UNLOCKED_TEXT = 'Thank you, you may enter the conversation.';

module.exports = { NEED, MAX_PER_SEC, BURST, REPLY_GAP_MS, MAX_REPORT, createState, applyReport, takeReply, blockedText, UNLOCKED_TEXT };
