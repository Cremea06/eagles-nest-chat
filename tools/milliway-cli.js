#!/usr/bin/env node
// CHG-165 — Milliway guest terminal client. No credentials or chat logs stored locally.
// License: MIT (see LICENSE in https://github.com/Cremea06/eagles-nest-chat).
'use strict';
const readline = require('node:readline');
const { stripVTControlCharacters } = require('node:util');

// Strip complete terminal sequences first, then remaining controls (including bidi/zero-width).
// Flatten remote newlines so a peer cannot forge additional terminal lines/prompts.
function sanitize(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '');
}
function formatLine(kind, data, time = new Date()) {
  const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  let text;
  if (kind === 'chat') text = `${sanitize(data.username)}: ${sanitize(data.message)}`;
  else if (kind === 'whisper') {
    const tag = data && data.dir === 'out' ? `To ${sanitize(data.to)}:` : `${sanitize(data.from)} whispers:`;
    text = `${tag} ${sanitize(data && data.message)}`;
  }
  else if (kind === 'clip') text = `[clip] ${sanitize(data.clipper)}: ${sanitize(data.caption)} ${sanitize(data.url)}`;
  else text = sanitize(data);
  return `[${stamp}] ${text}`;
}
function createPauseBuffer(cap = 500) {
  let paused = false, by = '', items = [], dropped = 0;
  return {
    push(kind, data, own = false, time = new Date()) {
      const item = { kind, data, time };
      if (!paused || own) return [item];
      if (items.length >= cap) { items.shift(); dropped++; }
      items.push(item);
      return [];
    },
    apply(state) {
      paused = state.paused; by = sanitize(state.by || '');
      if (paused) return [];
      const result = items; items = []; dropped = 0; return result;
    },
    status() { return paused ? `Chat paused${by ? ' by ' + by : ''} · ${dropped ? cap + '+' : items.length} new` : 'Chat On'; },
    reset() { paused = false; by = ''; items = []; dropped = 0; }
  };
}
// Same token bucket as public/keystroke-limits.js, kept self-contained for tool-only downloads.
function createKeyLimiter() {
  let tokens = 4, last = null;
  return (now) => {
    if (!Number.isFinite(now)) return false;
    if (last !== null) tokens = Math.min(4, tokens + Math.max(0, now - last) / 30);
    last = last === null ? now : Math.max(last, now);
    if (tokens < 1 - 1e-9) return false;
    tokens--; return true;
  };
}
function parseArgs(args) {
  let url = 'https://chat.afirstflag.com', help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') help = true;
    else if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else throw new Error('Usage: node tools/milliway-cli.js [--url URL] [--help]');
  }
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('URL must be HTTP(S), without credentials, query or fragment.');
  return { url, help };
}
// Guest client forwards only these slash commands to the server; others stay blocked.
function isForwardedCommand(text) {
  const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  return cmd === '/who' || cmd === '/tell' || cmd === '/r';
}
function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); } catch (e) { console.error(sanitize(e.message)); process.exitCode = 1; return; }
  const help = '/help — commands; /who — online; /tell <name> <message> — whisper; /r <message> — reply; /pause /resume — shared Chat switch; /quit — exit';
  if (options.help) { console.log('Usage: node tools/milliway-cli.js [--url URL]\n' + help); return; }
  const { io } = require('socket.io-client');
  const input = process.stdin, output = process.stdout;
  const tty = !!(input.isTTY && output.isTTY);
  const rl = readline.createInterface({ input, output, terminal: tty });
  const pause = createPauseBuffer();
  let joined = false, username = '', closing = false;
  let gated = false, count = 0, sent = 0, need = 100, limiter = createKeyLimiter();
  const socket = io(options.url, { autoConnect: false, reconnection: true,
    reconnectionDelay: 1000, reconnectionDelayMax: 10000, randomizationFactor: 0.5 });
  function print(text, style = null) {
    if (tty) { readline.cursorTo(output, 0); readline.clearLine(output, 0); }
    const pre = tty && style === 'dim' ? '\x1b[2m' : (tty && style === 'whisper' ? '\x1b[95m' : '');
    const post = pre ? '\x1b[0m' : '';
    output.write(pre + text + post + '\n');
    if (tty && !closing) rl.prompt(true); // preserve rl.line and cursor while asynchronous lines arrive
  }
  function note(text) { print(formatLine('system', text), 'dim'); }
  function styleOf(kind) { return kind === 'whisper' ? 'whisper' : (kind !== 'chat' ? 'dim' : null); }
  function render(items) { for (const it of items) print(formatLine(it.kind, it.data, it.time), styleOf(it.kind)); }
  function receive(kind, data) {
    const own = kind === 'whisper' || (kind === 'chat' && data && data.username === username);
    const visible = pause.push(kind, data, own);
    render(visible);
    if (!visible.length) note(pause.status());
  }
  function flushKeys() {
    if (joined && gated && count !== sent) { sent = count; socket.emit('keys:report', { count }); }
  }
  const timer = setInterval(flushKeys, 250);
  // Readline emits keypress for real terminal input. Piped data never earns gate credit.
  function keypress(str, key = {}) {
    if (!tty || !joined || !gated || key.ctrl || key.meta) return;
    if ((key.name === 'backspace' || (str && Array.from(str).length === 1 && !/[\p{Cc}\p{Cf}]/u.test(str))) && limiter(performance.now())) count++;
  }
  input.on('keypress', keypress);
  socket.on('connect', () => {
    joined = false; pause.reset(); count = sent = 0; gated = false; limiter = createKeyLimiter();
    socket.emit('join', {});
  });
  socket.on('joined', (data) => { username = String(data.username); joined = true; note('You are ' + username); });
  socket.on('chat message', (data) => { if (data && typeof data === 'object') receive('chat', data); });
  socket.on('whisper', (data) => { if (data && typeof data === 'object') receive('whisper', data); });
  socket.on('system', (text) => receive('system', text));
  socket.on('clip:new', (data) => { if (data) receive('clip', data); });
  socket.on('chat:pause', (state) => {
    if (!state || typeof state.paused !== 'boolean') return;
    render(pause.apply(state)); note(pause.status()); if (state.notice) note(state.notice);
  });
  socket.on('keys:state', (state) => {
    gated = !!state?.gated; need = state?.need || 100;
    if (gated && typeof state.count === 'number' && state.count < sent) sent = state.count;
    note(gated ? `Type ${need} keystrokes to unlock chat (${state.count || 0}/${need}). Pasted/piped text does not bypass this gate.` : 'Chat typing unlocked.');
  });
  // /who uses the browser's server-side command, avoiding a second presence roster that can drift.
  socket.on('disconnect', () => { joined = false; if (!closing) note('Disconnected; reconnecting…'); });
  socket.on('connect_error', () => note('Connection failed; reconnecting…'));
  socket.io.on('reconnect_attempt', () => note('reconnecting…'));
  function close() {
    if (closing) return;
    closing = true; clearInterval(timer); input.removeListener('keypress', keypress);
    socket.disconnect(); rl.close();
  }
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/quit') return close();
    if (text === '/help') note(help);
    else if (!joined) note('Not connected; line not sent.');
    else if (text === '/pause' || text === '/resume') socket.emit('chat:pause:set', { paused: text === '/pause' });
    else if (text.startsWith('/') && !isForwardedCommand(text)) note('Guest-only client: use /help for supported commands.');
    else if (text) { flushKeys(); socket.emit('chat message', text); }
    if (tty) rl.prompt(true);
  });
  rl.on('SIGINT', close); rl.on('close', close);
  rl.setPrompt('you> '); note(help); socket.connect();
  return { socket, close };
}
module.exports = { sanitize, formatLine, createPauseBuffer, createKeyLimiter, parseArgs, isForwardedCommand, main };
if (require.main === module) main();
