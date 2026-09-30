# CHG-049: read-only member role endpoint for the homepage (`GET /api/member/me`)

Nest/Milliway only (chat.afirstflag.com, repo Cremea06/eagles-nest-chat). Step B part 1. **No Shop code**; the Shop chip is CHG-050.
Not pushed, not deployed, not marked shipped.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `8eaad5038515856dc4250205acbff39b952e8341` ("CHG-048: adding changes.md"). Fresh clone on 2026-09-30.
- `CHG-049.diff` is `git diff` against that SHA (it also replaces this CHANGES.md, as prior CHGs did).

## What changed

| File | Change | +/- |
|---|---|---|
| `server.js` | `GET` and `OPTIONS /api/member/me` (handler `memberMe`), plus the allowlist const `MEMBER_ME_ORIGINS` | +25 / -0 |
| `CHANGES.md` | this file | replaced |

**Behaviour**
- **Response**: a valid member gets exactly `{"member":true,"name":"<username>"}`. Everything else gets `{"member":false}`: no cookie, a stale, tampered, expired or old-version cookie, a deleted user, or remember-me off (secret unset or short). It never returns an email, token, tokenVersion or timestamps.
- **Cookie check**: the cookie is verified with CHG-047's existing `readMember()`. No token logic is duplicated.
- **Pure read**: no users.json write, no tokenVersion change, **no Set-Cookie**, and no new log lines. A stale cookie is just "not a member" and is not cleared here. The chat page still clears it on its next visit via CHG-047's `member:stale`. This avoids Set-Cookie on cross-origin responses.
- **CORS (route-only)**:
  - Always sent: `Cache-Control: no-store` and `Vary: Origin`.
  - Only when `Origin` is **exactly** `https://afirstflag.com` or `https://www.afirstflag.com`: `Access-Control-Allow-Origin: <that origin>` and `Access-Control-Allow-Credentials: true`.
  - `OPTIONS` answers `204`. For those two origins it also sends `Access-Control-Allow-Methods: GET` and `Access-Control-Max-Age: 600`. Any other origin gets no CORS headers, so the browser blocks the read.
  - There is no port, no `http://`, and no suffix matching: `https://afirstflag.com.evil.test`, `http://afirstflag.com`, `https://afirstflag.com:8443` and `null` all get nothing.
- **Which requests read the cookie**:
  - No `Origin` header (same-origin GET, curl): read.
  - The two homepage origins: read.
  - CHG-047's chat origins (`https://chat.afirstflag.com`, plus the localhost dev origins): read.
  - **Any other Origin: the cookie is not read at all**, and the response is `{"member":false}` with no CORS headers. The browser would block that response anyway, so answering false costs nothing and means a mis-set header can never leak a name.
- **Global CORS interaction**: the route is registered **before** the global `app.use(cors(...))`, and the global config is untouched. The global middleware is not a wildcard; it reflects its own origin list (the homepage plus localhost dev origins) **without** credentials, and **answers every OPTIONS itself** with `Allow-Methods: GET,POST,OPTIONS`. If it ran first on this route, it would short-circuit the preflight without `Allow-Credentials` and hand an ACAO to its localhost dev origins. Mounting first means this route only ever sends its own headers. Verified: on main, `OPTIONS /api/member/me` got the global answer; on this build it gets the route's own. Global CORS on every other route (e.g. `/api/online`, `/api/heartbeat` preflight) is byte-identical to main.
- **Methods**: `HEAD` works (Express maps it to GET). Other methods (e.g. POST) aren't handled here; they fall through to the global cors and static handler, then 404, as unknown paths already did.

## What did not change

- The global `cors()` config and every other route: `/api/member/session`, `/api/member/logout`, `/last5.txt`, `/world`, `/api/online`, `/api/heartbeat`, and `/api/flag-wallet-lookup`.
- The socket handshake (CHG-047's `io.use`) still honours the cookie only from the chat origin. Nothing on the homepage can open a member socket.
- `public/index.html`, `public/world/index.html`, `lib/last5.js`, `lib/memberToken.js`, `.env.example` and `package.json` are all byte-identical to 8eaad50. No new dependencies and no new env vars.
- Still present: `io.of('/nest')`, the `/nest` command, `/world`, the presence roster, the `/last5.txt` route, `?login=1`, CHG-047's x / Esc / claim flow, and CHG-048's text-only rendering. No `mintNestWorldPass` and no server `world:enter`.

## VPS steps (for whoever ships it; not done here)

1. In the app dir: `git pull` (no `npm install`, no env changes).
2. `pm2 restart "Eagles Nest"`
3. Check that nginx adds no CORS headers of its own for `/api/`. Run curl test 1 below and look for exactly **one** `access-control-allow-origin` line.

Rollback: `git revert <CHG-049 commit>`, `git pull`, `pm2 restart "Eagles Nest"`. Nothing else depends on the route until CHG-050 ships.

## curl tests (VPS or laptop)

Copy your cookie from DevTools (chat.afirstflag.com > Application > Cookies > `nest_member` > Value) after signing in.

**1. Member, from the homepage origin**
```bash
curl -si https://chat.afirstflag.com/api/member/me \
  -H 'Origin: https://afirstflag.com' \
  -H 'Cookie: nest_member=PASTE_VALUE_HERE'
```
Expected (nginx adds `server`/`date`; header case may differ):
```
HTTP/1.1 200 OK
cache-control: no-store
vary: Origin
access-control-allow-origin: https://afirstflag.com
access-control-allow-credentials: true
content-type: application/json; charset=utf-8

{"member":true,"name":"<your username>"}
```
The same with `-H 'Origin: https://www.afirstflag.com'` echoes `https://www.afirstflag.com`.

**2. Guest (no cookie)**
```bash
curl -si https://chat.afirstflag.com/api/member/me -H 'Origin: https://afirstflag.com'
```
Expected: the same headers as test 1, and body `{"member":false}`.

**3. Foreign origin, even with a valid cookie**
```bash
curl -si https://chat.afirstflag.com/api/member/me \
  -H 'Origin: https://evil.test' -H 'Cookie: nest_member=PASTE_VALUE_HERE'
```
Expected: `200`, `cache-control: no-store`, `vary: Origin`, **no** `access-control-*` headers, and body `{"member":false}`.

**4. Preflight**
```bash
curl -si -X OPTIONS https://chat.afirstflag.com/api/member/me \
  -H 'Origin: https://afirstflag.com' -H 'Access-Control-Request-Method: GET'
```
Expected:
```
HTTP/1.1 204 No Content
cache-control: no-store
vary: Origin
access-control-allow-origin: https://afirstflag.com
access-control-allow-credentials: true
access-control-allow-methods: GET
access-control-max-age: 600
```
With `-H 'Origin: https://evil.test'` you get `204` with only `cache-control` and `vary`, and no `access-control-*` headers.

**5. Same-origin / no Origin**: `curl -s https://chat.afirstflag.com/api/member/me -H 'Cookie: nest_member=PASTE_VALUE_HERE'` returns `{"member":true,"name":"..."}`, with no CORS headers.

After any of these, `pm2 logs "Eagles Nest" --lines 20 --nostream` shows no new lines (the route logs nothing).

## Contract for CHG-050 (Shop chip)

- **URL**: `https://chat.afirstflag.com/api/member/me` (GET).
- **Responses** (HTTP 200, `application/json`):
  - member: `{"member":true,"name":"<username>"}`
  - anyone else: `{"member":false}`
  - Treat any other status, shape, network error or timeout as "not a member".
- **Allowed page origins**: exactly `https://afirstflag.com` and `https://www.afirstflag.com`. The homepage must be served over https; on `http://` the cookie isn't sent and the read is blocked.
- **Fetch, exactly like this**: `credentials: 'include'`, `cache: 'no-store'`, a 3 s timeout, and **no custom headers** (so no preflight):
```js
(function () {
  var chip = document.getElementById('ROLE_CHIP_ID'); // CHG-050 picks the element
  if (!chip) return;
  function setRole(label) { chip.textContent = 'Current role: ' + label; } // textContent, never innerHTML
  setRole('Guest User');
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, 3000);
  fetch('https://chat.afirstflag.com/api/member/me', { credentials: 'include', cache: 'no-store', signal: ctl.signal })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (d && d.member === true && typeof d.name === 'string' && d.name) setRole(d.name);
    })
    .catch(function () { /* stay "Guest User" */ })
    .finally(function () { clearTimeout(timer); });
})();
```
- **Chip text**:
  - member: `Current role: <name>`
  - otherwise: `Current role: Guest User`. That covers any error, timeout, non-200, bad JSON or `member:false`.
- **`name` is user-controlled.** Registration accepts any 2+ character name, including HTML-looking text, so it **must be set with `textContent`** (or equivalent), never `innerHTML` or string-built HTML. The endpoint returns it raw in JSON.

## Local verification (done 2026-09-30)

**Method: real origins.**
- A test-only HTTPS front (Node, self-signed cert with SANs for all four hosts) listened on 127.0.0.1:8443, behaving like nginx. It proxied `chat.afirstflag.com` to `node server.js` on :3000, including WebSocket, and served a blank stand-in page for `afirstflag.com`, `www.afirstflag.com` and `evil.test`.
- Headless Chrome 154 ran with `--ignore-certificate-errors` and `--host-resolver-rules="MAP chat.afirstflag.com 127.0.0.1:8443, MAP afirstflag.com 127.0.0.1:8443, MAP www.afirstflag.com 127.0.0.1:8443, MAP evil.test 127.0.0.1:8443"`. The resolver maps the port too, so the URLs, Origins and cookie host were the real `https://<host>` on the default port. There was no port in any Origin, no root, and the shipped allowlist wasn't changed.
- A member cookie was obtained by the normal flow in the same profile: `/login` pane, email, `/auth CODE`, on `https://chat.afirstflag.com`. The code was read from the isolated users.json because SMTP was unset.
- Request and response headers were captured from Chrome over CDP.

| # | Test | Result |
|---|---|---|
| setup | Sign-in on https://chat.afirstflag.com sets `nest_member`: domain `chat.afirstflag.com` (host-only), Secure, HttpOnly, SameSite=Lax. Reload stays a member through the front | PASS |
| a | Page on **https://afirstflag.com** runs the contract fetch: `{"member":true,"name":"Tester049"}`. Chrome **sent the cookie** (`Sec-Fetch-Site: same-site`). Response ACAO `https://afirstflag.com`, ACAC `true`, `Vary: Origin`, `no-store`, no Set-Cookie | PASS |
| b | Same from **https://www.afirstflag.com**: name read, ACAO echoes the www origin | PASS |
| c | Guest (fresh browser context, no cookie): `{"member":false}` | PASS |
| d | Page on **https://evil.test**: fetch rejects with `TypeError: Failed to fetch` and Chrome logs "blocked by CORS policy". No ACAO/ACAC on the response. The cookie isn't even sent (cross-site + Lax), and the server would answer false anyway | PASS |
| e | Tampered cookie: `{"member":false}`, no Set-Cookie, the cookie is left in place. An old-version cookie (after `/logout` elsewhere bumped tokenVersion) also gives `{"member":false}`. Signing in again reads the name again | PASS |
| f | `MEMBER_TOKEN_SECRET` unset, valid cookie sent: `{"member":false}`. Secret restored: the name is read again | PASS |
| g | `OPTIONS` from both homepage origins: 204 with ACAO (exact), ACAC `true`, `Allow-Methods: GET`, `Max-Age: 600`. From evil.test, localhost:3000, `http://afirstflag.com`, `https://afirstflag.com:8443`, `https://afirstflag.com.evil.test` and `null`: 204 with no `access-control-*` | PASS |
| h | No-Origin curl with the cookie gives the member name and no CORS headers; without the cookie, `{"member":false}`. Same-origin fetch from a chat-origin page (Chrome sent no Origin) reads the name | PASS |
| i | CHG-047 socket/HTTP suite 26/26 (including `/api/member/session` and `/api/member/logout`). CHG-047 browser suite 13/13 (reload, return visit, restart, tamper, `/logout` everywhere, `?login=1`, x/Esc, try limit, secret unset). CHG-048 XSS suite: 0 alerts and 0 injected elements on all 12 paths. Global CORS on other routes is identical to main | PASS |
| j | No new log lines from any `/api/member/me` request (browser a-d/h and all curls: 0 bytes). users.json byte-identical before and after. `console.*` count in server.js unchanged (24) | PASS |

**Browser caveats**
- **Chrome** (tested): `Sec-Fetch-Site: same-site`, so the Lax cookie is sent on this cross-origin, same-site fetch. Chrome's third-party-cookie restrictions don't apply, because the two sites are the same site.
- **SameSite=Lax** sends the cookie on *same-site* subresource requests even when they are cross-origin. "Same site" is scheme + registrable domain (schemeful same-site), so the homepage must be `https://`.
- **Firefox ETP / Total Cookie Protection** partitions cookies by top-level *site*. afirstflag.com and chat.afirstflag.com are one site, so they share the partition and the cookie is sent. Not tested here.
- **Safari ITP** blocks or partitions *cross-site* cookies; same-site subdomain requests are first-party. ITP's 7-day caps target script-written cookies and CNAME-cloaked or third-party-IP responses; this cookie is set by chat.afirstflag.com's own top-level HTTP response. Not tested here (no Safari on the box). Worth one manual check in CHG-050.
- Private windows, blocked cookies and privacy extensions just produce `member:false`, and the chip falls back to Guest User.

## md5

| File | md5 |
|---|---|
| server.js | 1de43204175bf116f313ea7aee43f212 |

`md5sums.txt` covers every delivered file, including this one and the diff.

## Risks

- If nginx ever adds its own `Access-Control-Allow-Origin` for `/api/`, there would be two ACAO headers and the browser would reject the read. Run curl test 1 after deploy.
- Anyone who can run script on afirstflag.com or www can read a signed-in visitor's chat username, but not the token or email. Keep the homepage free of third-party script injection.
- `name` is user-controlled. CHG-050 must render it as text (see the contract).
