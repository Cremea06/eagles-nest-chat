// CHG-128: support-flag greeting (lib/support.js). Fake sockets and a stubbed AI; the real provider is never called.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/support');

function fakeSocket(ip = '203.0.113.7') {
  return { data: {}, connected: true, request: { socket: { remoteAddress: ip }, headers: {} } };
}
function harness(extra = {}) {
  const said = [];
  const sup = S.createSupport(Object.assign({ say: (t) => said.push(t), schedule: (fn) => fn(), log: () => {} }, extra));
  return { said, sup };
}

test('support flag -> exactly one public greeting with the exact text', () => {
  const { said, sup } = harness();
  const s = fakeSocket();
  assert.strictEqual(sup.onJoin(s, { support: true }, () => 'Guest-User 1234'), 'greeted');
  assert.deepStrictEqual(said, ['Guest-User 1234: Howdy partner, what seems to troubling you?']);
  assert.strictEqual(S.GREETING, 'Howdy partner, what seems to troubling you?');
  // re-join on the same socket: no second greeting
  assert.strictEqual(sup.onJoin(s, { support: true }, () => 'Guest-User 1234'), 'already');
  assert.strictEqual(said.length, 1);
  assert.strictEqual(sup.isSupport(s), true);
});

test('non-flag joins do not greet or start a support session', () => {
  const { said, sup } = harness();
  for (const d of [{}, undefined, null, { support: 1 }, { support: 'true' }, { tracking: 'x' }]) {
    const s = fakeSocket();
    assert.strictEqual(sup.onJoin(s, d, () => 'Guest-User 1'), 'none');
    assert.strictEqual(sup.isSupport(s), false);
    assert.strictEqual(sup.shouldReply(s), false);
  }
  assert.strictEqual(said.length, 0);
});

test('disconnected before the delay -> no greeting', () => {
  let pending;
  const { said, sup } = harness({ schedule: (fn) => { pending = fn; } });
  const s = fakeSocket();
  sup.onJoin(s, { support: true }, () => 'Guest-User 2');
  s.connected = false; pending();
  assert.strictEqual(said.length, 0);
});

test('rate limit: a few per IP per hour, hashed key, other IPs unaffected, resets after an hour', () => {
  let t = 1e9;
  const { said, sup } = harness({ now: () => t });
  for (let i = 0; i < S.PER_IP_PER_HOUR; i++) assert.strictEqual(sup.onJoin(fakeSocket(), { support: true }, () => 'G'), 'greeted');
  const blocked = fakeSocket();
  assert.strictEqual(sup.onJoin(blocked, { support: true }, () => 'G'), 'limited');
  assert.strictEqual(sup.isSupport(blocked), false);
  assert.strictEqual(said.length, S.PER_IP_PER_HOUR);
  assert.strictEqual(sup.onJoin(fakeSocket('198.51.100.9'), { support: true }, () => 'G'), 'greeted');
  const k = sup.ipKey(fakeSocket());
  assert.match(k, /^[0-9a-f]{32}$/); assert.ok(!k.includes('203.0.113.7'));
  t += S.HOUR_MS;
  assert.strictEqual(sup.onJoin(fakeSocket(), { support: true }, () => 'G'), 'greeted');
});

test('support-session prompt includes the 988 / 911 guidance; normal prompt unchanged', () => {
  const base = 'BASE PROMPT';
  assert.strictEqual(S.systemPromptFor(base, false), base);
  const p = S.systemPromptFor(base, true);
  assert.ok(p.startsWith(base));
  assert.match(p, /988/); assert.match(p, /911/);
  assert.match(p, /Never describe, suggest, compare, or confirm any method/);
  assert.match(p, /Never give medical advice/);
});

test('crisis reminder appended in code when self-harm comes up and the reply lacks 988', () => {
  const r = S.withCrisisReminder('I hear you.', 'i want to kill myself');
  assert.match(r, /^I hear you\. /); assert.match(r, /call or text 988/); assert.match(r, /call 911/);
  assert.strictEqual(S.withCrisisReminder('Call or text 988.', 'thinking about suicide'), 'Call or text 988.');
  assert.strictEqual(S.withCrisisReminder('Glad to hear.', 'rough day at work'), 'Glad to hear.');
  assert.ok(S.mentionsSelfHarm("I don't want to be here anymore"));
});

test('support guests get replies with a cooldown; stubbed AI sees the support prompt', async () => {
  let t = 0;
  const { sup } = harness({ now: () => t });
  const s = fakeSocket();
  sup.onJoin(s, { support: true }, () => 'G');
  const calls = [];
  const stubAsk = async (sys, msg) => { calls.push(sys); return 'You are not alone.'; }; // stub provider
  assert.strictEqual(sup.shouldReply(s), true);
  const reply = S.withCrisisReminder(await stubAsk(S.systemPromptFor('BASE', sup.isSupport(s)), 'suicide'), 'I keep thinking about suicide');
  assert.match(calls[0], /988/); assert.match(reply, /988/);
  assert.strictEqual(sup.shouldReply(s), false);
  t += S.REPLY_COOLDOWN_MS;
  assert.strictEqual(sup.shouldReply(s), true);
});
