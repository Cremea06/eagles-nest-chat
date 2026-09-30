// CHG-044 — last5.txt: a tiny, world-readable tail of the public Milliway room.
//
// Keeps the last 5 public 'chat message' lines (humans + Neagle) in memory and
// rewrites a plain-text file on every qualifying message. It is NOT an archive:
// the file only ever holds the current last 5 lines, one per line, formatted
// "username: text". The in-memory ring starts empty on boot and the file is
// truncated to empty on boot (no seeding; the server keeps no chat history).
//
// Writes are atomic (temp file in the same dir, then fs.rename) and serialized
// through a single promise chain, so concurrent messages can never interleave.
// Nothing here may throw into the chat path: every entry point catches and logs.

const fs = require('fs');
const path = require('path');

const MAX_LINES = 5;
const MAX_TEXT = 500;   // chars (code points) per message text
const MAX_NAME = 64;    // chars (code points) per username

// C0/C1 controls, DEL, line/paragraph separators, and bidi overrides/isolates.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g;

function clean(value, max) {
  let s = String(value == null ? '' : value).replace(CONTROL_RE, ' ').trim();
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').trim();
  return s;
}

function formatLine(username, message) {
  const name = clean(username, MAX_NAME) || 'Anonymous';
  const text = clean(message, MAX_TEXT);
  if (!text) return '';
  return name + ': ' + text;
}

function createLast5(filePath) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  const base = path.basename(target);
  const ring = [];
  let chain = Promise.resolve();
  let seq = 0;
  let lastErrLog = 0;

  // Log write errors at most once a minute so a bad path can't flood pm2 logs.
  function logErr(what, err) {
    const now = Date.now();
    if (now - lastErrLog < 60000) return;
    lastErrLog = now;
    console.error('[last5] ' + what + ' failed (' + target + '):', err && (err.code || err.message));
  }

  function tmpName() {
    return path.join(dir, '.' + base + '.' + process.pid + '.' + (++seq) + '.tmp');
  }

  // Create the data dir (one level only; its parent must exist). Recursive mkdir is
  // avoided on purpose: it can hang on odd filesystems (e.g. /proc) in Node 20.
  function ensureDirSync() {
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  function snapshot() {
    return ring.length ? ring.join('\n') + '\n' : '';
  }

  async function writeAtomic(content) {
    const tmp = tmpName();
    try {
      await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
      await fs.promises.rename(tmp, target);
    } catch (err) {
      logErr('write', err);
      fs.promises.unlink(tmp).catch(() => {});
    }
  }

  // Queue a write of the current ring state. Each write snapshots the ring when
  // it runs, so a burst of messages collapses to "latest state wins", in order.
  function flush() {
    chain = chain.then(() => writeAtomic(snapshot())).catch((err) => {
      console.error('[last5] queue error:', err && err.message);
    });
    return chain;
  }

  function record(username, message) {
    try {
      const line = formatLine(username, message);
      if (!line) return;
      ring.push(line);
      while (ring.length > MAX_LINES) ring.shift();
      flush();
    } catch (err) {
      console.error('[last5] record failed:', err && err.message);
    }
  }

  // Boot: in-memory ring is empty; truncate the file to match. Synchronous (once, tiny)
  // so the file is already empty before the server starts listening.
  function init() {
    ring.length = 0;
    const tmp = tmpName();
    try {
      ensureDirSync();
      fs.writeFileSync(tmp, '', { encoding: 'utf8', mode: 0o644 });
      fs.renameSync(tmp, target);
    } catch (err) {
      logErr('init', err);
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  }

  // Express handler for GET /last5.txt. Missing file => empty 200.
  function handler(req, res) {
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.readFile(target, 'utf8', (err, data) => {
      if (!err) return res.status(200).send(data);
      if (err.code === 'ENOENT') return res.status(200).send('');
      console.error('[last5] read failed:', err.message);
      return res.status(500).send('');
    });
  }

  return { record, init, handler, flush, path: target, _ring: ring };
}

module.exports = { createLast5, formatLine, MAX_LINES, MAX_TEXT, MAX_NAME };
