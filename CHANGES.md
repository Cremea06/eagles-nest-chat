# CHG-048: escape chat rendering (stored XSS fix)

Nest/Milliway only (chat.afirstflag.com, repo Cremea06/eagles-nest-chat). Shop untouched.
Not pushed, not deployed, not marked shipped.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `fe77ad86b472070effc3c6f156c6cfba97c9167c` ("CHG-047: persis member sign-in via HttpOnly cookie"). Fresh clone on 2026-09-30.
- `CHG-048.diff` is `git diff` against that SHA (it also replaces this CHANGES.md, as prior CHGs did).

## What changed

| File | Change | +/- |
|---|---|---|
| `public/index.html` | The two HTML sinks that took user or AI text now build DOM: `<span class="username">` (or `neagle`) with `textContent = name + ':'`, followed by a text node `' ' + message`. The structure and classes are the same as before, so the look is identical. | +12 / -3 |
| `CHANGES.md` | this file | replaced |

No other file changed. `server.js`, `lib/last5.js`, `lib/memberToken.js`, `public/world/index.html` and `.env.example` are byte-identical to fe77ad8. No new dependencies. No `escapeHtml` helper was needed, because no markup has to wrap user text.

### Audit: every innerHTML / insertAdjacentHTML / outerHTML / document.write

| File:line (fe77ad8, then after) | Code | Fed by | Verdict |
|---|---|---|---|
| public/index.html:817 (now :818-822) | `addPriv`: `div.innerHTML = '<span class="username">' + from + ':</span> ' + text` | private pane: your own typed input echoed as `YOU:`, plus server prompts | **fixed** (DOM + textContent) |
| public/index.html:826 (now :831) | `privLog.innerHTML = ''` | constant (clears the pane) | safe static |
| public/index.html:941 (now :946-950) | `'chat message'`: `div.innerHTML = '<span class="' + nameClass + '">' + data.username + ':</span> ' + data.message` | every public chat line: people's names and text, and Neagle (AI) replies | **fixed** (DOM + textContent) |
| public/world/index.html:188 | `listEl.innerHTML = ''` | constant (clears the player list) | safe static |

There are no `insertAdjacentHTML`, `outerHTML` or `document.write` uses in either file. The world client lives in `public/world/index.html`, an inline module script; `three.min.js` is the vendored library.

Other places that render user or AI text were already text-only, and were checked and left alone:
- Main page: system lines (`/me`, "X joined", `/nest` output, `/help`): `div.textContent = msg` at :958, whose `white-space: pre-wrap` keeps `/help` newlines.
- Who's here roster names: `name.textContent` at :1002.
- Broadcast card "X is live": `setStatus` → `liveStatus.textContent` at :603, fed from :741 and :748.
- Open World status at :1059, and the usage chip at :939.
- World page: handle `handleEl.textContent` at :365, player list `li.textContent` at :195, status `statusEl.textContent` at :182.
- `window.open(url)` at index.html:1077 only runs on a `world:pass` event, which the server never emits (the handler is dormant, as it was before). It is not an HTML sink.

### Intentional HTML in messages?
None. Server system lines already went through `textContent`. Server priv-pane prompts ("Login. Enter your email.", "Fail. Closing in 5 seconds") are plain text. Neagle's prompt asks for short plain sentences, and nothing in the app formats its replies as HTML. There was no linkify: URLs in chat were never clickable, unless someone typed raw `<a>` HTML, which was the XSS path itself. `/nest` pass links were already plain text in a system line. So nothing needed special handling. Newlines behave as before: chat lines collapse whitespace (CSS `white-space: normal`, the same as the old innerHTML rendering), and system lines keep `pre-wrap`.

The one visible difference is intended: text that used to be interpreted as HTML now shows as typed. `&amp;` now shows `&amp;` (it used to show `&`), and `<b>x</b>` shows the tags instead of bold. Ordinary text, including `<`, `&&`, emoji and URLs, is pixel-identical (see below).

### Server side (unchanged)
- `server.js` builds no HTML from user input. `/world` and `/world/` are `sendFile` of a static page. `/api/*` return JSON. Auth emails are `text:` only. User text reaches Neagle only as a prompt string (that's prompt injection, not XSS, and out of scope).
- `/last5.txt` is `Content-Type: text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` (lib/last5.js:121-125). Payloads are stored and served as literal text, which is safe.
- Express's default 404 and error pages escape the path or message and send `Content-Security-Policy: default-src 'none'`.

## What did not change

- public/index.html: `#sideCol`, `#whoCard`, `#liveCard`, `#worldCard` / `#enterWorldBtn` and the world client script (including its `world:enter` emit), the CHG-042 `?login=1` hook, and CHG-047's x / Esc, `member:claim` → `POST /api/member/session`, `member:stale`, and `/logout`.
- server.js (untouched): `io.of('/nest')`, the `/nest` command, `/world`, the presence roster, `/last5.txt`, and `/api/member/session` / `/api/member/logout`. `lib/last5.js` and `lib/memberToken.js` are untouched. No `mintNestWorldPass` and no server `world:enter` handler.
- Name rules: usernames are still server-assigned (Guest-User NNNN) or the registered username (since CHG-047). Registration still accepts any 2+ character name that isn't a guest name or already taken, so names containing HTML are possible. They now render as literal text everywhere.
- Next: CHG-049 (Nest: read-only role endpoint, credentialed CORS for https://afirstflag.com only), then CHG-050 (Shop: Live-state chip reading it).

## VPS steps (for whoever ships it; not done here)

1. In the app dir: `git pull` (no `npm install`, no env changes).
2. `pm2 restart "Eagles Nest"`
3. Hard-refresh the chat page (Ctrl+Shift+R) so browsers pick up the new `index.html`.

Rollback: `git revert <CHG-048 commit>`, `git pull`, `pm2 restart "Eagles Nest"`.

## Test plan (VPS, after deploy)

Use two browsers, A and B. Send each line from A as a public chat message, and look at both A and B:
1. `<img src=x onerror=alert(1)>`: shows exactly as typed, no alert, no broken-image icon.
2. `<script>alert(1)</script>`: shows as typed.
3. `<svg onload=alert(1)>`: shows as typed.
4. `"><b>bold</b>`: shows as typed, not bold.
5. `literal &amp; and &lt; stay as typed`: shows `&amp;` and `&lt;` literally.
6. `Hello 👋 café naïve 日本語 🇺🇸` and `see https://afirstflag.com/shop?a=1&b=2`: look exactly as before. The URL is readable text (it was never clickable).
7. **Private pane echo**: type `/login`, then type payloads 1-4 into the pane. Each `YOU:` line shows as typed, with no alert.
8. **Name containing HTML**: names are server-assigned since CHG-047, so use registration, which accepts any name. `/register`, username `<img src=x onerror=alert(1)>`, then a mailbox you control, then `/auth CODE`. B sees "`<img ...> has joined the chat`", the chat lines and the Who's here row as literal text. `/nest` then Enter: the world page shows the handle literally. Afterwards, delete that test user from users.json (stop pm2 first, since the app rewrites the file from memory).
9. **Neagle reply containing HTML**: this can't be forced in prod. It was verified locally with a stubbed AI (below). In prod, `@neagle` replies should look as before.
10. `/me <img src=x onerror=alert(1)>`: the system line shows it literally (it already did).
11. `curl -si https://chat.afirstflag.com/last5.txt | head -5` shows `Content-Type: text/plain; charset=utf-8` and `X-Content-Type-Options: nosniff`.
12. **CHG-047 smoke**: sign in, reload (still a member, one roster row), `/?login=1` as a member (no pane, param stripped), x and Esc on `/login`, then `/logout`.

## Local verification (done 2026-09-30)

Main (fe77ad8, "before") and this build ("after") were each run with `node server.js` on http://localhost:3000. Setup: isolated users.json and data, dummy `WORLD_TOKEN_SECRET`, `MEMBER_TOKEN_SECRET` and `XAI_API_KEY`, SMTP unset (codes read from the isolated users.json). The xAI call was stubbed through a test-only `node -r` preload that returns an HTML reply; the same preload optionally seeds `Math.random` for deterministic screenshots. Driven by headless Chrome 154 (puppeteer-core). `window.alert` was hooked on every page before load, and the counts are alert calls across observer and sender. "Injected elements" counts `img, script, svg, b, iframe, a` inside `#messages`, `#privLog`, `#whoList`, `#liveCard`, or the world page `.door`.

| Path / payload | Before (fe77ad8) | After (CHG-048) |
|---|---|---|
| Chat `<img src=x onerror=alert(1)>` | **EXECUTED** (2 alerts), 1 img per page | PASS: 0 alerts, 0 elements, literal |
| Chat `<script>alert(1)</script>` | script element injected (innerHTML scripts don't run) | PASS: literal |
| Chat `<svg onload=alert(1)>` | svg element injected (onload didn't fire via innerHTML in Chrome) | PASS: literal |
| Chat `"><b>bold</b>` | `<b>` injected (rendered bold) | PASS: literal |
| Chat `&amp;` / `&lt;` literal | decoded to `&` / `<` | PASS: literal |
| Chat emoji + URL | shown | PASS: shown, identical |
| Private pane echo (payloads 1-4) | **EXECUTED** (1 alert), 4 elements injected | PASS: 0 alerts, 0 elements, literal |
| System line `/me <img ...>` | already safe (textContent) | PASS: literal |
| Neagle reply with HTML (stubbed AI) | **EXECUTED** (2 alerts), elements injected | PASS: 0 alerts, 0 elements, literal |
| Registered name with HTML: join line, chat line, roster | **EXECUTED** in the chat line (2 alerts); roster and join line already safe | PASS: 0 alerts, 0 elements, literal |
| Name with HTML: Broadcast card "is live" label | already safe | PASS: literal |
| Name with HTML: `/nest` output + world page handle and player list | already safe | PASS: literal |
| Page errors | 0 | 0 |

- **Visual comparison**: the same normal-chat session was run on before and after, with a seeded server RNG and CSS animations frozen. Messages included emoji, a flag, accents, CJK, a URL with `&`, `a < b && c > d`, `/me`, and a Neagle reply. The 1400x900 screenshots are **pixel-identical: 0 of 1,260,000 pixels differ** (pixelmatch, threshold 0). The rendered `innerHTML` of `#messages` and `#privLog` for normal input (including a private-pane session) is also **byte-identical** before vs after.
- **CHG-047 regression** (the CHG-047 headless suite pointed at this build): 13/13 PASS. That covers member reload with one roster row, return visit, restart, tampered cookie, `/logout` everywhere, `?login=1` as member and as guest, x / Esc, the wrong-try limit, and secret unset.
- **Screenshots**: `shot-before.png` and `shot-after.png` (normal chat, identical), and `shot-payloads-after.png` (the payloads in chat, a Neagle HTML reply, and the private-pane echoes, all literal).

## md5

| File | md5 |
|---|---|
| public/index.html | 453d450f95ef7f3e389adab55c7ecd7a |

`md5sums.txt` covers every delivered file, including this one, the diff and the screenshots.

## Remaining risks (not in this CHG)

- Registration accepts any name, including HTML, "Neagle" (which gets the gold Neagle styling), or very long names. This is now harmless for XSS but still allows impersonation. A server-side username rule would be a separate small CHG.
- No Content-Security-Policy on the main page (the inline scripts would need nonces). It would be defence in depth, not needed for this fix.
- Express shows stack traces on malformed JSON unless `NODE_ENV=production` is set in pm2. That is information disclosure, not XSS.
