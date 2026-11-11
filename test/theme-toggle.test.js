// CHG-172: welcome-card theme toggle must be the header pill, not the Join Chat button.
// Static markup/CSS/JS checks only. No network. Run: npm test.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const themeJs = fs.readFileSync(path.join(ROOT, 'public', 'theme.js'), 'utf8');
const profileHtml = fs.readFileSync(path.join(ROOT, 'public', 'profile.html'), 'utf8');
const profileCss = fs.readFileSync(path.join(ROOT, 'public', 'profile.css'), 'utf8');
const worldHtml = fs.readFileSync(path.join(ROOT, 'public', 'world', 'index.html'), 'utf8');
function loginSlice() {
  const start = html.indexOf('id="login"');
  const end = html.indexOf('id="chat"');
  assert.ok(start >= 0 && end > start, 'login and chat blocks');
  return html.slice(start, end);
}

test('Join Chat button styles do not apply to the welcome-card theme toggle', () => {
  assert.match(html, /#login button:not\(\.theme-toggle\)\s*\{/);
  assert.match(html, /#login button:not\(\.theme-toggle\):hover\s*\{/);
  assert.match(html, /#login button:not\(\.theme-toggle\):active\s*\{/);
  // A bare #login button { would outrank .theme-toggle and restore the red bar.
  assert.doesNotMatch(html, /#login button\s*\{/);
  assert.doesNotMatch(html, /#login button:hover\s*\{/);
  assert.doesNotMatch(html, /#login button:active\s*\{/);
});

test('welcome-card toggle is a top-right pill, clear of the title', () => {
  const login = loginSlice();
  assert.match(login, /data-theme-toggle/);
  assert.ok(login.indexOf('data-theme-toggle') < login.indexOf('Welcome to Milliway'));
  assert.match(html, /#login\s*\{[^}]*padding-top:\s*3\.5rem/s);
  const rule = html.match(/#login \.theme-toggle\s*\{([^}]+)\}/);
  assert.ok(rule, '#login .theme-toggle rule');
  const body = rule[1];
  assert.match(body, /position:\s*absolute/);
  assert.match(body, /top:\s*12px/);
  assert.match(body, /right:\s*12px/);
  assert.match(body, /width:\s*auto/);
  assert.match(body, /border-radius:\s*999px/);
  assert.match(body, /display:\s*inline-flex/);
});

test('welcome and header toggles include first-paint Light and Dark labels', () => {
  const login = loginSlice();
  assert.match(login, /theme-toggle-label["']/);
  assert.match(login, /theme-toggle-label-alt/);
  assert.match(login, />Light</);
  assert.match(login, />Dark</);
  // Header toggle (inside #chat > h2)
  const chatHead = html.slice(html.indexOf('id="chat"'), html.indexOf('id="messages"'));
  assert.match(chatHead, /data-theme-toggle/);
  assert.match(chatHead, /theme-toggle-label-alt/);
  assert.match(html, /html\[data-theme="light"\] \.theme-toggle \.theme-toggle-label\s*\{[^}]*display:\s*none/s);
  assert.match(html, /html\[data-theme="light"\] \.theme-toggle \.theme-toggle-label-alt\s*\{[^}]*display:\s*inline/s);
});

test('theme.js still syncs aria on every toggle and leaves two-span labels to CSS', () => {
  assert.match(themeJs, /data-theme-toggle/);
  assert.match(themeJs, /Switch to dark theme/);
  assert.match(themeJs, /Switch to light theme/);
  assert.match(themeJs, /aria-pressed/);
  assert.match(themeJs, /aria-checked/);
  assert.match(themeJs, /theme-toggle-label-alt/);
  assert.match(themeJs, /lab && !alt/);
});

test('profile and world toggles get the same first-paint labels and are not in #login', () => {
  assert.match(profileHtml, /data-theme-toggle/);
  assert.match(profileHtml, /theme-toggle-label-alt/);
  assert.match(profileCss, /theme-toggle-label-alt/);
  assert.doesNotMatch(profileCss, /#login button/);
  // Existing CSP-related rule: profile page has no inline script.
  assert.ok(!/<script>/.test(profileHtml) && !/style=/.test(profileHtml));
  assert.match(worldHtml, /data-theme-toggle/);
  assert.match(worldHtml, /theme-toggle-label-alt/);
  assert.match(worldHtml, /theme-toggle-label-alt\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(worldHtml, /#login button/);
});

test('server.js is unchanged (client-only fix)', () => {
  const out = execFileSync('git', ['diff', '--', 'server.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(out, '');
});
