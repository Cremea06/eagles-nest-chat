# CHG-047: keep Nest members signed in + close (x) on the login pane

Nest/Milliway only (chat.afirstflag.com, repo Cremea06/eagles-nest-chat). Shop untouched.
Not pushed, not deployed, not marked shipped. Built to the approved `DESIGN.md` (2026-09-30).

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `a46b679968f11973f8f6b6c8c06106ce035e3222` ("CHG-044 publish last 5 milliway lines at /last5.txt"). Fresh clone on 2026-09-30.
- `CHG-047.diff` is `git diff` against that SHA, new file included (it also replaces this CHANGES.md, as CHG-044 did).

## What changed

| File | Change | +/- |
|---|---|---|
| `lib/memberToken.js` | **new**. Signed member token `mt1.<body>.<sig>` (HMAC-SHA256, Node `crypto`, base64url, `timingSafeEqual`, 60 s future-iat skew, 1 KB cap). `sign`, `verify` (returns null, never throws), and a tiny `parseCookie` | +65 / -0 |
| `server.js` | Remember-me config and helpers. `io.use` cookie check (default namespace only). `join` ignores browser-sent names. Claim on `/auth`. `POST /api/member/session` and `POST /api/member/logout`. Wrong-try limit. `crypto.randomInt` codes, timing-safe code compare. Codes and emails removed from logs. `/logout` added to `/help` | +153 / -13 |
| `public/index.html` | x button and Esc on the private pane (plus a fix for the old 5 s timer). `member:claim` / `member:stale` handlers. `/logout` command. The CHG-042 hook also strips `?login` for an already-remembered member | +56 / -4 |
| `.env.example` | `MEMBER_TOKEN_SECRET=` and `AUTH_CODE_LOG=`, blank, with comments | +6 / -0 |
| `CHANGES.md` | this file | replaced |

No new npm dependencies (`package.json` / `package-lock.json` unchanged; jsonwebtoken is still used only by `/nest`).

### How it works
1. `/auth CODE` succeeds as before. The server then sends that socket a one-time **claim** (32 random bytes, 60 s, single use).
2. The page POSTs the claim to `/api/member/session`. The server replies with the cookie `nest_member`: **HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000 (30 days, fixed)**. It is host-only (no `Domain`), so afirstflag.com never receives it.
   The token carries: username, per-user `tokenVersion`, iat, exp. No email.
3. On every socket.io handshake the browser sends the cookie. `io.use` verifies it and checks that `tokenVersion` matches users.json, then the `join` handler joins that socket **directly as the member**. The result is one "X joined the chat" line and one `presence:join`, with no guest-then-upgrade.
4. Anything wrong with the cookie (tampered, expired, other secret, old version, deleted user, garbage) means a quiet guest join plus a `member:stale` event. The page then POSTs `/api/member/logout`, which clears the cookie.
5. `/logout` (typed in chat) POSTs `/api/member/logout`. The server bumps the user's `tokenVersion` in users.json (signing out **every** device), clears this browser's cookie, and the page reloads as a guest.
6. Cookies are only honoured from origin `https://chat.afirstflag.com` (or `http://localhost:3000` / `http://127.0.0.1:3000` for local runs), or when no Origin is sent (same-origin polling). A handshake from any other origin is treated as a guest.

### Decisions made during the build
- **Wrong-try limit: 5.** The 5th wrong `/auth` voids the pending code and replies "Too many wrong codes. Type /login to get a new code." The counter (`pendingTries`) is kept on the user record, so it doesn't reset per socket. It resets when a new code is issued. Tries 1-4 keep the old opaque "Unknown command: /auth" reply.
- **Cookie `Secure`: always on.** It does not depend on the request scheme, `trust proxy`, or X-Forwarded-Proto. That way production gets Secure whatever headers nginx forwards. Local http tests still work because Chrome and Firefox accept Secure cookies on `http://localhost` (tested with headless Chrome 154 on http://localhost:3000). Safari does not, so test locally in Chrome.
- **Secret unset or under 32 chars:** one `[member] ... remember-me is off` warning, then everything works as before. No claim is sent and cookies are ignored but **not cleared**, so restoring the secret brings members back.
- **Logs:** `[auth code]` and `[auth:try]` print `(hidden)` instead of the code, and a masked email (`t***@example.com`). `AUTH_CODE_LOG=1` prints the code (the email stays masked). `[mail fail]` now prints the SMTP error code first, because SMTP messages can echo the address. New lines: `[member] resume <name>`, `[member] logout <name>`, `[auth] too many wrong codes <name>`. Tokens, claims and cookies are never logged.
- **Browser-sent names on `join` are ignored.** Members come only from the verified cookie or an `/auth` on that socket; everyone else gets a server-assigned Guest-User name. The optional `tracking` (flagholder) field is still read.

## What did not change

- public/index.html: `#sideCol`, `#whoCard`, `#liveCard`, `#worldCard` / `#enterWorldBtn`, the world client script (including its `world:enter` emit), the CHG-042 `?login=1` hook (only the member-strip branch was added), and chat rendering (the `innerHTML` escaping fix is **CHG-048**, not here).
- server.js: the `/nest` command and mint, `io.of('/nest')` and its handshake and roster, `/world`, the Milliway presence roster, `/last5.txt` + `lib/last5.js` (byte-identical), and the email text and 10-minute code lifetime. No `mintNestWorldPass` and no server `world:enter` handler were added.
- Multi-tab: one roster row per socket, as before. `/logout` doesn't kick other *open* tabs; they drop to guest on their next reconnect or reload.
- Out of scope (homepage role hydrate), both after CHG-048: **CHG-049 (Nest)** adds the read-only role endpoint with credentialed CORS for https://afirstflag.com only; **CHG-050 (Shop)** adds the Live-state chip that reads it.

## VPS steps (for whoever ships it; not done here)

The app loads `.env` with `require('dotenv').config()` (server.js line 1), which reads `.env` from the **process working directory**, i.e. the app dir pm2 starts in. dotenv does not override variables already set in pm2's environment. The pm2 process is **`Eagles Nest`** (from the project baseline).

1. `cd` to the app dir, then `openssl rand -hex 32` and add `MEMBER_TOKEN_SECRET=<that 64-hex value>` to `.env`. Leave `AUTH_CODE_LOG` unset.
2. `git pull` (no `npm install`: no dependency change).
3. `pm2 restart "Eagles Nest" --update-env`
4. `pm2 logs "Eagles Nest" --lines 30 --nostream` should show **no** `remember-me is off` line. If it does, the secret isn't loaded (check the pm2 cwd and `.env`).
5. Keeping the secret: changing it signs everyone out, and removing it turns the feature off. Don't hand-edit users.json while pm2 runs (the app rewrites it from memory); stop pm2 first.

Rollback: `git revert <CHG-047 commit>`, `git pull`, `pm2 restart "Eagles Nest"`. Leftover `nest_member` cookies are then ignored. The `tokenVersion` / `pendingTries` fields in users.json are harmless.

## Test plan (VPS, after deploy)

Use two browsers (A = Chrome, B = another browser or profile).
1. **Sign in** on A (`/login`, email, `/auth CODE`). In DevTools > Application > Cookies, `nest_member` should show HttpOnly, Secure, SameSite Lax, expiring in about 30 days. `document.cookie` in the console must not show it.
2. **Reload** A: still you. B sees one "X left the chat" and one "X joined the chat", no Guest-User line for A, and one row for A in Who's here.
3. **Return visit**: quit Chrome completely, reopen, go to chat.afirstflag.com: still you. A **new tab** is you too (two rows while both are open, as before).
4. **pm2 restart**: `pm2 restart "Eagles Nest"`. A's open page reconnects as you without a reload.
5. **Tampered cookie**: in DevTools edit one character of the `nest_member` value, then reload. You are a quiet Guest-User (no error text) and the cookie disappears.
6. **/logout**: sign in on A and on B. Type `/logout` on A: A reloads as a guest and the cookie is gone. Reload B: B is a guest and its old cookie is cleared (tokenVersion revoked it).
7. **?login=1 as remembered member**: open `https://chat.afirstflag.com/?login=1`. No pane opens, and the address bar loses `login` (other params stay).
8. **?login=1 as guest** (private window): the pane opens (unchanged); after `/auth` the param is stripped.
9. **x and Esc**: `/login`, click x (closes); `/login` again, press Esc (closes). Reopening within 5 s of a result is no longer closed by the old timer.
10. **Wrong-try limit**: request a code, type 5 wrong `/auth` codes. The 5th replies "Too many wrong codes. Type /login to get a new code.", and the real code is then refused. `/login` again gets a new code that works.
11. **No codes/emails in logs**: `pm2 logs "Eagles Nest" --lines 300 --nostream | grep -E '\[auth'` shows `(hidden)` and `x***@domain` only, and `grep -Ec 'mt1\.|nest_member'` gives 0. `curl -s https://chat.afirstflag.com/last5.txt` shows only public lines. Optional: set `AUTH_CODE_LOG=1`, restart with `--update-env`, and the code appears. Remove it again.
12. **Secret unset** (optional, at a quiet time): comment out `MEMBER_TOKEN_SECRET`, restart `--update-env`. One warning; sign-in by code still works; reload returns to Guest-User as before; no crash. Restore it and restart: members who still have a cookie are back.
13. **Regression**: `/nest` pass and Open World Enter, Go Live, `/who`, `/whoami`, `/last5.txt`.
14. **Deferred / expected-fail (not this CHG)**: the afirstflag.com homepage chip showing the real role. It stays as it is today until **CHG-049 (Nest: read-only role endpoint, credentialed CORS for https://afirstflag.com only)** and **CHG-050 (Shop: Live-state chip reading that endpoint)** ship, both after CHG-048.

## Local verification (done 2026-09-30)

Environment: `node server.js` (Node 20.19.2) on http://localhost:3000 from an isolated copy of this tree, with its own users.json (two seeded test members) and `data/`. Settings: `WORLD_TOKEN_SECRET=dummy`, a 64-hex `MEMBER_TOKEN_SECRET`, SMTP unset (so no mail goes out; the pane says "Fail" but the code is still issued, which is the existing behaviour). Codes were read from the isolated users.json by the test harness. Nothing test-related is in the delivered files. Clients: socket.io-client 4 and headless Google Chrome 154 via puppeteer-core, installed in a separate test dir.

| # | Test | Result |
|---|---|---|
| S1 | guest joins with server-assigned name; browser-sent name ignored | PASS |
| S2 | email-code sign-in issues claim; claim -> HttpOnly Secure SameSite=Lax 30-day cookie | PASS |
| S3 | member reload: joins directly as member, one join line, no guest line, one roster row | PASS |
| S4 | remembered member is authed: /whoami and /nest pass work; /nest namespace joins | PASS |
| S5 | second tab: member again (one row per socket, as before); closing it removes its row | PASS |
| S6 | pm2-style restart: same cookie still a member | PASS |
| S7-tampered | bad cookie (tampered) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-tamperedBody | bad cookie (tamperedBody) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-expired | bad cookie (expired) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-futureIat | bad cookie (futureIat) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-wrongSecret | bad cookie (wrongSecret) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-deletedUser | bad cookie (deletedUser) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-garbage | bad cookie (garbage) -> quiet guest + member:stale + cleared by /api/member/logout | PASS |
| S7-noToken | no cookie -> guest, no member:stale | PASS |
| S8 | foreign Origin handshake with a valid cookie -> guest (cookie ignored); foreign-origin claim swap refused | PASS |
| S9 | /logout: tokenVersion bumped, cookie cleared, the other browser's old cookie now rejected | PASS |
| S10 | sign in again after /logout issues a cookie with the new version that works | PASS |
| S11 | wrong-try limit: 4 wrong -> opaque reply; 5th -> code voided; right code then refused | PASS |
| S12 | wrong-try counter is stored on the user record; a newly issued code resets it and signs in | PASS |
| S13 | codes come from crypto.randomInt, 6 digits (sample of 20) | PASS |
| S14 | public chat still works and reaches last5; commands/auth never do | PASS |
| S15 | default logs + last5: no codes, no full emails, no tokens/claims | PASS |
| S16 | AUTH_CODE_LOG=1 prints the code (email still masked) | PASS |
| S17-unset | MEMBER_TOKEN_SECRET unset: one warning, no crash, code sign-in works as today, no claim, old cookie ignored (no stale) | PASS |
| S17-short | MEMBER_TOKEN_SECRET short: one warning, no crash, code sign-in works as today, no claim, old cookie ignored (no stale) | PASS |
| S18 | /world, /last5.txt, / still served | PASS |
| B1 | guest page: required elements present; /login opens pane with visible x; x closes it; Esc closes it | PASS |
| B2 | old 5 s auto-close timer no longer closes a pane reopened in the meantime | PASS |
| B3 | ?login=1 as guest: pane opens; after sign-in the param is stripped; cookie HttpOnly+Secure+Lax, invisible to document.cookie | PASS |
| B4 | member reload: still Tester047; one roster row; observer sees left+joined only, no Guest line; no pane | PASS |
| B5 | ?login=1 as remembered member: no pane, param stripped (other params kept) | PASS |
| B6 | new tab is a member too | PASS |
| B7 | return visit: close Chrome completely, relaunch same profile -> still a member | PASS |
| B8 | server restart (pm2-style): open page reconnects as member without reload | PASS |
| B9 | tampered cookie (edited like in DevTools): quiet guest, no error text, cookie removed | PASS |
| B10 | /logout signs out everywhere: this browser -> guest + cookie gone; second browser with its old cookie -> guest + cleared | PASS |
| B11 | wrong-try limit in the UI: 5 wrong /auth -> "Too many wrong codes"; correct code then refused | PASS |
| B12 | secret unset: code sign-in works, reload drops to guest exactly as today, ?login=1 guest pane still opens | PASS |
| B13 | no page errors in any browser test | PASS |

Totals: socket/HTTP 26/26, browser 13/13. Log scan over every default run (8 server logs): 0 full emails, 0 six-digit codes, 0 `mt1.` tokens, 0 `nest_member`. Screenshots: `shot-login-pane.png` (pane with the x), `shot-member-reload.png` (Tester047 after reload, one row, "Welcome to Milliway, Tester047").

## md5

| File | md5 |
|---|---|
| server.js | 525883d158d91a5960b03d8ca67057b2 |
| lib/memberToken.js | e91a41a40bb351e3542689e1fbf6e73e |
| public/index.html | bbaeb0311f92ac23fe31d1768145d10e |
| .env.example | 4eee068c316e3c397ba2878d5089b4c7 |

`md5sums.txt` also covers this file, `CHG-047.diff` and the screenshots (a file can't list its own md5).

## Remaining risks

- The chat `innerHTML` XSS remains until CHG-048. The cookie can't be stolen, but a malicious chat line can act as a signed-in member while their page is open.
- Anyone can still make the server email a code to any member's address (pre-existing). Each code now allows only 5 guesses, but there is no rate limit on requesting codes, so it's a nuisance-mail vector with about 5 in 900,000 guess odds per code.
- Logout doesn't disconnect other already-open tabs until they reconnect.
- The secret lives only in the VPS `.env`. If it's lost, everyone signs in again (nothing breaks).
