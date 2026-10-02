// CHG-058: "Neagle go into edit mode" helpers. The flow itself lives in server.js (handleEditFlow); this file holds
// the trigger match and the code check so they can be unit tested. Nothing here calls the AI.
// The secret code is never stored in plaintext in this public repo: only its SHA-256 (of the trimmed, lowercased
// code) is here. EDIT_MODE_CODE_SHA256 in .env (64 hex chars) replaces the built-in hash, e.g. to change the code.
const crypto = require('crypto');

const DEFAULT_CODE_SHA256 = '7f0b629cbb9d794b3daf19fcd686a30a039b47395545394dadc0574744996a87';
const PENDING_MS = 2 * 60 * 1000; // a pending step with no reply for 2 minutes is dropped silently
const MAX_WRONG = 5;              // wrong codes per socket, then triggering is refused on that socket

// Case-insensitive, any run of spaces between words, trailing punctuation and spaces allowed (after trim()).
const TRIGGER = /^neagle\s+go\s+into\s+edit\s+mode[\s.!?,;:\u2026]*$/i;

function isTrigger(text) {
  return TRIGGER.test(String(text == null ? '' : text).trim());
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// -> the hash in use: a valid env value (64 hex, any case) or the built-in one. A bad env value is ignored with a warning.
function resolveCodeHash(envValue, warn) {
  const v = String(envValue == null ? '' : envValue).trim().toLowerCase();
  if (!v) return DEFAULT_CODE_SHA256;
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  if (warn) warn('[editmode] EDIT_MODE_CODE_SHA256 is not 64 hex chars; using the built-in code hash');
  return DEFAULT_CODE_SHA256;
}

// -> function(given) -> true when trim+lowercase of `given` hashes to `hashHex` (constant-time compare).
function createCodeCheck(hashHex) {
  const want = Buffer.from(hashHex, 'hex');
  return function codeOk(given) {
    const got = crypto.createHash('sha256').update(String(given == null ? '' : given).trim().toLowerCase()).digest();
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  };
}

module.exports = { isTrigger, resolveCodeHash, createCodeCheck, sha256Hex, DEFAULT_CODE_SHA256, PENDING_MS, MAX_WRONG, TRIGGER };
