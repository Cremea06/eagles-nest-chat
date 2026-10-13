// CHG-129: short-term memory for support sessions (lib/support.js). Stubbed AI and a fake clock; no real provider call.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/support');

let nextId = 1;
function fakeSocket(ip = '203.0.113.7') {
  return { id: 'sock' + (nextId++), data: {}, connected: true, request: { socket: { remoteAddress: ip }, headers: {} } };
}
// Mirrors the server.js message handler for one line (snapshot, record, stubbed ask, record reply).
function makeRoom(t) {
  const said = [];
  const memory = S.createSupportMemory({ now: () => t.v, sweepMs: 0 });
  const sup = S.createSupport({ say: (x) => said.push(x), schedule: (fn) => fn(), log: () => {}, now: () => t.v, memory });
  const calls = [];
  const stubAsk = async (text, username, supportSession, history) => {
    const msgs = S.buildMessages(S.systemPromptFor('BASE', supportSession), supportSession && Array.isArray(history) ? history : [], `${username} said: ${text}`);
    calls.push(msgs);
    return 'reply ' + calls.length;
  };
  async function line(socket, username, text) {
    const supportSession = sup.isSupport(socket);
    const willReply = supportSession ? sup.shouldReply(socket) : true;
    const history = supportSession ? memory.get(socket) : null;
    if (supportSession) memory.add(socket, 'user', `${username} said: ${text}`);
    if (!willReply) return null;
    let reply = await stubAsk(text, username, supportSession, history);
    if (supportSession) { reply = S.withCrisisReminder(reply, text); memory.add(socket, 'assistant', reply); }
    t.v += S.REPLY_COOLDOWN_MS;
    return reply;
  }
  return { said, memory, sup, calls, line };
}

test('history accumulates (greeting first) and is sent in order with roles, newest last', async () => {
  const t = { v: 1e6 }; const r = makeRoom(t); const s = fakeSocket();
  r.sup.onJoin(s, { support: true }, () => 'Sam');
  await r.line(s, 'Sam', 'my dog died last week');
  await r.line(s, 'Sam', 'what did I tell you earlier?');
  const m = r.calls[1];
  assert.deepStrictEqual(m.map((x) => x.role), ['system', 'assistant', 'user', 'assistant', 'user']);
  assert.match(m[1].content, /Howdy partner/);
  assert.strictEqual(m[2].content, 'Sam said: my dog died last week');
  assert.strictEqual(m[3].content, 'reply 1');
  assert.strictEqual(m[4].content, 'Sam said: what did I tell you earlier?');
  assert.match(m[0].content, /SUPPORT SESSION/);
});

test('cap: at most 20 messages and about 4000 chars, oldest trimmed first', () => {
  const t = { v: 0 }; const mem = S.createSupportMemory({ now: () => t.v, sweepMs: 0 }); const s = fakeSocket();
  for (let i = 0; i < 30; i++) { mem.add(s, 'user', 'u' + i); mem.add(s, 'assistant', 'a' + i); }
  let h = mem.get(s);
  assert.strictEqual(h.length, S.HISTORY_MAX_MESSAGES);
  assert.strictEqual(h[0].content, 'u20'); assert.strictEqual(h[19].content, 'a29');
  for (let i = 0; i < 10; i++) mem.add(s, 'user', String(i).repeat(900));
  h = mem.get(s);
  assert.ok(h.reduce((n, x) => n + x.content.length, 0) <= S.HISTORY_MAX_CHARS);
  assert.strictEqual(h[h.length - 1].content, '9'.repeat(900));
  mem.add(s, 'user', 'x'.repeat(5000));
  h = mem.get(s); assert.strictEqual(h.length, 1); assert.ok(h[0].content.length <= S.HISTORY_MAX_CHARS);
});

test('disconnect (forget) wipes the history', async () => {
  const t = { v: 0 }; const r = makeRoom(t); const s = fakeSocket();
  r.sup.onJoin(s, { support: true }, () => 'G');
  await r.line(s, 'G', 'hello');
  assert.ok(r.memory.get(s).length > 0);
  r.memory.forget(s);
  assert.deepStrictEqual(r.memory.get(s), []); assert.strictEqual(r.memory.size(), 0);
});

test('30 minutes of inactivity wipes it (lazy check and sweep), activity keeps it alive', async () => {
  const t = { v: 0 }; const r = makeRoom(t); const s = fakeSocket(); const s2 = fakeSocket('198.51.100.1');
  r.sup.onJoin(s, { support: true }, () => 'G'); r.sup.onJoin(s2, { support: true }, () => 'H');
  await r.line(s, 'G', 'first');
  t.v += S.HISTORY_TTL_MS - 10000; await r.line(s, 'G', 'still here');
  assert.ok(r.memory.get(s).length >= 4);   // not expired: activity refreshed it
  t.v += S.HISTORY_TTL_MS;
  assert.strictEqual(r.memory.size(), 0);    // sweep removed both quiet sessions
  assert.deepStrictEqual(r.memory.get(s), []);
  await r.line(s, 'G', 'back again');
  assert.deepStrictEqual(r.calls[r.calls.length - 1].map((x) => x.role), ['system', 'user']);
  const short = S.createSupportMemory({ now: () => t.v, ttlMs: 10, sweepMs: 0 }); // injectable TTL
  short.add(s, 'user', 'x'); t.v += 10; assert.deepStrictEqual(short.get(s), []);
});

test('non-support guests get no history and the exact old prompt shape', async () => {
  const t = { v: 0 }; const r = makeRoom(t); const s = fakeSocket();
  await r.line(s, 'Bob', 'hey neagle'); await r.line(s, 'Bob', 'neagle again');
  assert.deepStrictEqual(r.calls[1], [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'Bob said: neagle again' }]);
  assert.strictEqual(r.memory.size(), 0);
  // buildMessages with no history equals the CHG-128 two-message array
  assert.deepStrictEqual(S.buildMessages('P', [], 'U'), [{ role: 'system', content: 'P' }, { role: 'user', content: 'U' }]);
});

test('two concurrent support guests never mix; a name change keeps the history on the connection', async () => {
  const t = { v: 0 }; const r = makeRoom(t); const a = fakeSocket('192.0.2.1'); const b = fakeSocket('192.0.2.2');
  r.sup.onJoin(a, { support: true }, () => 'Ann'); r.sup.onJoin(b, { support: true }, () => 'Ben');
  await r.line(a, 'Ann', 'ann secret'); await r.line(b, 'Ben', 'ben secret');
  await r.line(a, 'Annie', 'renamed now');
  const ha = r.memory.get(a).map((x) => x.content).join('|'); const hb = r.memory.get(b).map((x) => x.content).join('|');
  assert.match(ha, /ann secret/); assert.match(ha, /renamed now/); assert.doesNotMatch(ha, /ben/i);
  assert.match(hb, /ben secret/); assert.doesNotMatch(hb, /ann/i);
});

test('988 safeguard still applies and the reminder is what is remembered', async () => {
  const t = { v: 0 }; const r = makeRoom(t); const s = fakeSocket();
  r.sup.onJoin(s, { support: true }, () => 'G');
  const reply = await r.line(s, 'G', 'i want to die');
  assert.match(reply, /988/); assert.match(r.memory.get(s).pop().content, /988/);
});

test('nothing is written to disk or logged', async () => {
  const fsW = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream'];
  const saved = {}; const hits = [];
  for (const k of fsW) { saved[k] = fs[k]; fs[k] = (...a) => { hits.push(k); }; }
  const logs = []; const ol = console.log; const oe = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = console.log;
  try {
    const t = { v: 0 }; const r = makeRoom(t); const s = fakeSocket();
    r.sup.onJoin(s, { support: true }, () => 'G');
    await r.line(s, 'G', 'private words here'); r.memory.sweep(); r.memory.forget(s);
  } finally { for (const k of fsW) fs[k] = saved[k]; console.log = ol; console.error = oe; }
  assert.deepStrictEqual(hits, []);
  assert.ok(!logs.join('\n').includes('private words'));
  const src = fs.readFileSync(path.join(__dirname, '../lib/support.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](fs|\.\/last5)['"]\)/);
});
