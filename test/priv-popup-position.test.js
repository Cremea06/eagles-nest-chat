// CHG-144: static checks - the /login /register popup (#privPane) is anchored above the message input, not fixed to the screen corner.
// Position only: wording, the 5 s close and the /login /auth flow are covered by the existing server tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rule = (sel) => { const m = new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(html); return m ? m[1] : ''; };

test('p1. #privPane is positioned inside the chat, in a dock between #messages and the guest keystroke hint / input form', () => {
  const iMsgs = html.indexOf('<div id="messages"'); const iDock = html.indexOf('<div id="privDock">');
  const iPane = html.indexOf('<div id="privPane"'); const iHint = html.indexOf('<div id="keyHint"'); const iForm = html.indexOf('<form id="form">');
  assert.ok(iMsgs > 0 && iMsgs < iDock && iDock < iPane && iPane < iHint && iHint < iForm, 'order: messages, dock, pane, keyHint, form');
  assert.strictEqual(html.indexOf('id="privPane"', iPane + 10), -1, 'one #privPane only');
});

test('p2. #privPane is no longer fixed to the bottom-right corner of the viewport', () => {
  const css = rule('#privPane');
  assert.ok(css, '#privPane rule found');
  assert.ok(!/position:\s*fixed/.test(css));
  assert.ok(!/right:\s*24px/.test(css) && !/bottom:\s*24px/.test(css));
  assert.ok(/position:\s*absolute/.test(css) && /bottom:\s*0/.test(css));
  assert.ok(/position:\s*relative/.test(rule('#privDock')) && /height:\s*0/.test(rule('#privDock')));
});

test('p3. behaviour untouched: still 5 s close, opens on /login, focus call unchanged, no new focus() on the chat input', () => {
  assert.ok(/privTimer = setTimeout\(closePriv, 5000\)/.test(html));
  assert.ok(/cmd === '\/login'/.test(html) && /openPriv\('login'\)/.test(html));
  assert.strictEqual((html.match(/setTimeout\(\(\) => privInput\.focus\(\), 50\)/g) || []).length, 1);
  assert.ok(!/\binput\.focus\(\)/.test(html.replace(/privInput\.focus\(\)/g, '')), 'nothing focuses #input');
});
