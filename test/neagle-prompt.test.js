// CHG-175: Milliway Neagle system prompt checks (no live AI call).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const support = require('../lib/support');

function readPrompt() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/const NEAGLE_SYSTEM_PROMPT = `([\s\S]*?)`;/);
  assert.ok(m, 'NEAGLE_SYSTEM_PROMPT template literal should exist in server.js');
  return m[1];
}

test('NEAGLE_SYSTEM_PROMPT has the CHG-175 looser wording and key lines', () => {
  const p = readPrompt();
  assert.match(p, /You are Neagle, house presence in Milliway, a public chat attached to America First Flags\./);
  assert.match(p, /Voice: dry, witty, a little tired, but genuinely helpful\. Keep it conversational\. Short by default, longer when the question deserves it\./);
  assert.match(p, /You can talk about anything people bring up: news, ideas, jokes, the Hitchhiker's \/ Milliway theme if it fits, or just shooting the breeze\. Have opinions and share them\./);
  assert.match(p, /Help with the room when asked: \/help, \/register, \/login, \/who, \/nest \(registered members\), \/tell, flags, tracking numbers\. If you don't know something, say so rather than make it up\./);
  assert.match(p, /Address people by the name you are given\./);
});

test('NEAGLE_SYSTEM_PROMPT drops the old CHG-175-removed bans', () => {
  const p = readPrompt();
  for (const banned of [
    'Do not call this the last chatroom',
    'You are not support docs',
    'Two or three short sentences unless they asked for more',
    'If they do not, never bring it up',
    'Do not invent lore'
  ]) {
    assert.ok(!p.includes(banned), `old restriction still present: ${banned}`);
  }
});

test('support-session add-on still layers 988/911 guidance onto NEAGLE_SYSTEM_PROMPT', () => {
  const p = readPrompt();
  const sup = support.systemPromptFor(p, true);
  assert.ok(sup.startsWith(p));
  assert.match(sup, /SUPPORT SESSION/);
  assert.match(sup, /988/);
  assert.match(sup, /911/);
});
