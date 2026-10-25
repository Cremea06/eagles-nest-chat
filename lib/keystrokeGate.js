// CHG-141 — guests join muted until they have recorded 100 keystrokes (a speed bump, NOT security).
//
// What it is: a per-socket counter, memory only. The chat page counts real key presses in the chat box and reports
// a cumulative COUNT over the socket; the server decides how much of it to believe (a human typing rate) and
// unmutes the guest at NEED. Only a number is kept: never what was typed, never logged, never written to disk.
// What it is not: proof of a human. A determined script can send reports at the capped rate and get in after ~2.6 s (CHG-142).
// CHG-142: the speed limits live in public/keystroke-limits.js (shared with the chat page). The server credits at most
// elapsed time x ceiling (33.3 keys/s, i.e. a held key at the fastest normal OS default) plus a 15-key bucket, whatever
// number the page claims.
// Members (signed in) are never gated. Slash commands are never gated (the caller only asks about plain lines).
const limits = require('../public/keystroke-limits');
const NEED = 100;
const MAX_PER_SEC = limits.MAX_PER_SEC; // CHG-142: 33.3 keys/s (was 12): a held key at the fastest normal OS default counts, nothing faster
const BURST = limits.SERVER_BURST;      // most that one report can add (bucket size); also the starting allowance (15)
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

// Canned local text (no AI). Shown only to that guest. CHG-143: addressed to the guest by their display name
// (plain text, collapsed to one line; "Guest" when no name is available) and shorter than the CHG-141 wording.
function blockedText(count, name) {
  const who = String(name == null ? '' : name).replace(/\s+/g, ' ').trim() || 'Guest';
  return who + ", I'll need some more keystrokes from you before I'll let you talk in here. You're at " + count + '/' + NEED + '.';
}
const UNLOCKED_TEXT = 'Thank you, you may enter the conversation.';

module.exports = { NEED, MAX_PER_SEC, BURST, MIN_GAP_MS: limits.MIN_GAP_MS, REPORT_MS: limits.REPORT_MS, REPLY_GAP_MS, MAX_REPORT, createState, applyReport, takeReply, blockedText, UNLOCKED_TEXT };
