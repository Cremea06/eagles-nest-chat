# CHG-139: 'My profile' pill moves into Who's here (visual only)

Prepared 2026-10-24 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `5220c7e` (CHG-138).

| File | Change |
|---|---|
| `public/index.html` | The 'My profile' pill left the Milliway header (the Neagle badge stays) and now sits in the middle of the Who's here header row, between the title and 'N online' (3-column grid, pill centred). Members: the same blue link to `/u/<name>`, set from the existing `joined` event (no new endpoint), so it updates live after `/login` + `/auth`. Guests (and after `/logout`, which reloads the page): the same pill as a dimmed placeholder, no `href`, `aria-disabled="true"`, tooltip 'Sign in to get a profile page', so nothing jumps on sign-in. Narrow screens (320 px+): no overflow. |
| `test/profile.test.js` | Test 14 rewritten for the new markup (placeholder by default, pill gone from the Milliway header, member link / guest placeholder code). Still 103 tests. |

No server code, no `/login` or `/auth` change. Express serves `public/` from disk, so deploy is `git pull`; a pm2 restart is not needed. Rollback: `git revert <hash>`.

---

# CHG-138: /delete (a member deletes their own account)

Prepared 2026-10-24 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `2b4cead` (CHG-135).

| File | Change |
|---|---|
| `lib/accountDelete.js` (new) | Purpose-tagged delete codes (own in-memory store, 10 min, single use, 5 tries), 90-day name tombstones (`tombstones.json`, atomic, no email), atomic file backup, display-name matcher. |
| `server.js` | `/delete` (members only; guests get no code; owner account refused; 3/account and 10/address per 10 min), the system line `auth code sent. /auth code to delete account`, `auth:try` checks the delete code first for a signed-in member who has one outstanding (the sign-in path is untouched). Delete = back up `users.json` to `users.json.bak-delete` (atomic), hold the name, remove the record, purge clips/PNGs/votes, anonymize quoted names, end sockets/`/nest`/presence/claims, audit line. Registration refuses a tombstoned name; every new record starts at a random `tokenVersion`. Mail text for the delete code. `NEST_PORT` (tests only). `/help` lists `/delete`. |
| `lib/clips.js`, `lib/last5.js`, `lib/username.js` | `purgeMember` (one save), buffer/last5 `redact`, `isOwnerAccountEmail` (hash only). |
| `public/index.html` | `account:deleted` clears the cookie and reloads as a guest. |
| `.gitignore` | `tombstones.json`, `tombstones.json.tmp`, `*.bak-*`. |
| `test/account-delete.test.js`, `test/account-delete.server.test.js` (new) | 16 tests: helpers with fake clocks, plus a real server on temp data with a fake local SMTP. `npm test` = 103. |
| `README.md` | Deleting your account: flow, what is purged, what stays. |

Deploy (VPS, `~/chat-app`): `cp users.json users.json.bak-138`, `git pull`, `pm2 restart "Eagles Nest"` (no `npm ci`, no `.env` change). Rollback: `git revert <hash>` (a deleted account does not come back; restore from `users.json.bak-delete` while the server is stopped).

---

# CHG-135: Share card keeps text out of the bottom-left (X's caption bar)

Prepared 2026-10-22 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `d344615` (CHG-134).

| File | Change |
|---|---|
| `lib/clips.js` | X overlays its own caption bar ("Milliway clip by NAME") on the bottom-left of the share card and hid the footer text. The card now has no text in the bottom-left: the brand `chat.afirstflag.com` (+ small `Milliway clip — afirstflag`) moved to the top-right of the chat panel, the footer strip is decorative on its left, and `clipped by NAME` stays bottom-right (shortened by measured width so a long name never reaches the left 60 %). Layout version `CARD_LAYOUT = 2` is now part of the PNG cache key (`clips-img/ID-VERSION.png`), so every PNG cached by the CHG-134 layout regenerates on its next view. Size (1200x630), fonts, emoji stripping and caching are unchanged. |
| `test/clips.test.js` | 2 new tests (87 total): bottom-left (x < 60 %, y >= 85 %) renders as one flat colour for normal, very long name/caption/title cases; stale legacy-keyed cache file is replaced and removed. |

Deploy (VPS, `~/chat-app`): `git pull`, `pm2 restart "Eagles Nest"` (no `npm ci`, no `.env` change). Rollback: `git revert <hash>`.

---

# CHG-134: Clips (save a moment of Milliway chat as a shareable card)

Prepared 2026-10-22 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `01ab81b` (CHG-133).

| File | Change |
|---|---|
| `lib/clips.js` (new) | Recent-line buffer (ids + times, 30 s / 25 lines shown, 5 min selectable), caption sanitizing (80 chars), stream-slot context (room / tailgate / golive), clip store (`clips.json`, 0600, atomic, cap 5000, oldest unvoted out), clip page `/c/ID` (escaped, OG + Twitter summary_large_image, strict CSP), PNG card `/c/ID.png` 1200x630 via `@resvg/resvg-js` + bundled DejaVu Sans (cache `clips-img/`), routes `GET /api/clips/recent`, `POST /api/clips`, `POST /api/clips/:id/vote`, `DELETE /api/clips/:id`. |
| `server.js` | Every public room line gets `id` + `t` and goes into the buffer. Per-connection clip session (`clips:session`, header `X-Clip-Session`). `clips:context` pushes; Go Live carries `allowClips` (default off); `clips:allow` (only the current broadcaster) and `clips:remove-mine`. Room line events `clip:new`, `clip:votes`, `clip:removed`. |
| `public/index.html` | Gold ✂ Clip button, tray (moment card, trim handles, caption, Cancel/Save), share panel (Copy, X, Telegram, Facebook, Reddit, Bluesky, Share…, Video coming soon, Delete), clip line with upvote/Open, Go Live 'Allow clipping' + 'Remove my clips'. |
| `assets/fonts/` (new) | DejaVu Sans + Bold with license (PNG text on the VPS). |
| `package.json` | `@resvg/resvg-js` (prebuilt binaries, no native build); `npm ci` needed on deploy. `test/clips.test.js` (14 tests). |
| `.env.example`, `.gitignore`, `README.md` | `CLIPS_MEMBERS_ONLY`, `CLIPS_ADMIN_TOKEN`; `clips.json`, `clips-img/`; Clips privacy note. |

Deploy (VPS, `~/chat-app`): `cp users.json users.json.bak-134`, `git pull`, `npm ci`, `pm2 restart "Eagles Nest"`.

---

# CHG-129: Short-term memory for support chats

Prepared 2026-10-13 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `5e79d7b` (CHG-128).

| File | Change |
|---|---|
| `lib/support.js` | `createSupportMemory()`: per-socket (Map keyed by socket.id) rolling history of user/assistant messages, capped at 20 messages and 4,000 characters (oldest trimmed first), 30-minute inactivity TTL (lazy check on every access + unref'd 60 s sweep; `now`/`ttlMs` injectable), `forget()` on disconnect. Memory only; never logged or written. `buildMessages()` = system, history, newest line last. The scripted greeting is recorded as the first assistant message. |
| `server.js` | `askNeagle(…, history)`: support sessions send their history; non-support chat sends exactly the same two messages as before. Every support line is recorded (lines inside the 4 s cooldown too) and Neagle's final reply (after the 988/911 code reminder). Disconnect wipes it. `max_tokens` stays 150. |
| `test/support-memory.test.js` (new) | 8 tests, AI stubbed, fake clock; `npm test` runs it. |
| `README.md` | Support privacy note: short-term memory. |

Deploy (VPS, `~/chat-app`): `cp users.json users.json.bak-129`, `git pull`, `pm2 restart "Eagles Nest"`.

---

# CHG-128: Support-flag greeting from Neagle (`/?support=1`)

Prepared 2026-10-13 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `fd72646`.

| File | Change |
|---|---|
| `lib/support.js` (new) | `createSupport()`: `onJoin` reads `{ support: true }` on join, one greeting per socket, 3 per visitor per hour (CHG-081 `createRateLimiter`, key = sha256(per-process salt + CHG-106 `rateKey`), memory only); Neagle's scripted public line `<name>: Howdy partner, what seems to troubling you?` (no AI call). `systemPromptFor()` adds the support-session prompt (listen, encourage, no methods, no medical advice, 988/911). `withCrisisReminder()` appends the 988/911 reminder in code when self-harm comes up and the reply lacks 988. |
| `server.js` | Join calls `onJoin` after the welcome. In a support session Neagle answers every line from that guest (4 s cooldown) with the support prompt, plus the code reminder; no-key/error/empty replies use a gentle fallback instead of the sarcastic lines. Everything else unchanged. |
| `public/index.html` | Strips `?support=1` from the address bar on load and sends `{ support: true }` with the first join only. |
| `test/support.test.js` (new) | 7 tests, stubbed AI; `npm test` runs it. |
| `README.md` | Support entry + privacy note. |

# CHG-115: read-only public profile page (GET /api/profile/:username + /u/:username)

Prepared 2026-10-12 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Base `b912df1` (CHG-106).

| File | Change |
|---|---|
| `lib/profile.js` (new) | Lookup by the CHG-051 `fold()` (lookalikes resolve to the real account; two stored names that fold together are both hidden). Returns only `{username, tier: 'Member', joined?}` (joined = `createdAt` day, omitted when missing). Plain 404 `{"error":"not_found"}` for unknown, unfinished sign-ups (`verified:false` / `pendingCode`), names failing today's CHG-051 `check()`, and collisions. 30/min per visitor with the CHG-106 `rateKey` (X-Forwarded-For only with `TRUST_PROXY=1` and a loopback peer), 429 + Retry-After. `Cache-Control: public, max-age=60`; in-memory index rebuilt after 60 s or on `invalidate()`. |
| `server.js` | Mounts `GET /api/profile/:username` and `GET /u/:username` (serves `public/profile.html`, strict CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; ...`, max-age 300) after users load; `saveUsers()` calls `profile.invalidate()`. |
| `public/profile.html`, `profile.js`, `profile.css` (new) | Static page in the chat's glass style; fills name, tier, join date with `textContent` only; 'No such member.' on 404, 'Slow down…' on 429; `noindex`. |
| `public/index.html` | Hidden 'My profile' pill in the chat header, shown on `joined` for members only (link `/u/<name>`, new tab). |
| `tools/audit-usernames.js` (new) | Prints only `N of M stored usernames fail today's CHG-051 rules` (exit 1 when N > 0). |
| `test/profile.test.js` (new) | 14 tests; `npm test` runs it. Test 12 starts a copy of server.js on port 3000 (skipped if busy). |
| `package.json` | `npm test` includes test/profile.test.js. No new dependency. |

No editing, no bio, no listing endpoint. users.json is only read. No `.env` change.
Deploy (VPS, `~/chat-app`): `cp users.json users.json.bak-115`, `git pull`, `node tools/audit-usernames.js users.json` (expect 0), `pm2 restart "Eagles Nest"`.

---

# CHG-106: POST /api/safe-link (Google Safe Browsing + lookalike + short-link checks)

Goes with the CHG-106 Shop change (Safe Search in the third-window search box on afirstflag.com).
Prepared 2026-10-09: committed locally by Andy's identity, not pushed, not deployed. Base `6674d7f` (CHG-081).

| File | Change |
|---|---|
| `lib/safeLink.js` (new) | Normalize (https default, http/https only, IDN both ways, 2048 cap), SSRF guard (literal + DNS, every hop, pinned at connect), Safe Browsing threatMatches:find (3 s, clientId afirstflag), red flags, short-link expansion, daily verdict counters (no URLs), the route. |
| `lib/brands.js` (new) | ~35 phished brands + official domains; lookalike check reusing the CHG-051 `fold()` skeleton plus vv->w. |
| `server.js` | Mounts `app.all('/api/safe-link', ...)` after server-stats, before the global `cors()`; `trust proxy` loopback only when `TRUST_PROXY=1`. |
| `test/safe-link.test.js`, `test/safe-link.live.test.js` (new) | Mocked unit + API tests; one real Google call (`npm run test:live`). |
| `package.json` | `npm test` also runs the safe-link tests; `test:live` script. No new dependency. |
| `README.md` | Short section. |

Env: `GOOGLE_SAFE_BROWSING_KEY` (required, in `.env`, never committed), `TRUST_PROXY=1` (optional, only with the nginx X-Forwarded-For line).

---

# CHG-081: GET /api/server-stats (CPU, memory and uptime for the homepage Server row)

Nest/Milliway repo (Cremea06/eagles-nest-chat). Goes with the CHG-081 Shop change (the Server row in the Live-state Analysis drawer on afirstflag.com).
Prepared 2026-10-08 on the deliberate track: committed locally by Andy's identity, not pushed, not deployed. Andy tests first.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `46eeca9` ("CHG-058: Neagle edit mode (scripted flow, EDIT MODE badge)").

## What changed

| File | Change |
|---|---|
| `lib/serverStats.js` (new) | The sampler, the rate limiter, the client key and the route handler. |
| `server.js` | Requires it, starts the sampler once at boot and mounts `app.all('/api/server-stats', ...)` right after `/api/member/me`, before the global `cors()`. +8 lines, nothing else touched. |
| `test/server-stats.test.js` (new) | `node:test` unit and route tests (no new dependency). |
| `package.json` | `npm test` now runs `node --test test/server-stats.test.js` (it was a placeholder that always failed). No dependency change. |
| `README.md` | Short section on the endpoint. |
| `CHANGES.md` | This write-up. |

**The endpoint**
- `GET https://chat.afirstflag.com/api/server-stats` answers JSON, numbers only:
  `{"cpu":12.4,"cores":2,"mem":{"usedPct":41.2},"load":[0.12,0.3,0.25],"uptimeSec":273600,"samples":[...up to 60...],"intervalMs":2000,"ts":1791497868950}`
  - `cpu`: CPU % of the whole VPS over the last 2 s (all cores together, 0 to 100, one decimal). `null` for the first 2 s after a restart.
  - `samples`: the last 60 readings, oldest first (2 minutes). `cpu` is the newest one.
  - `mem.usedPct`: memory in use, like Task Manager (cache does not count).
  - `load`: the 1, 5 and 15 minute load averages. `uptimeSec`: time since the VPS booted (not since the chat restarted).
- Nothing else: no process names, versions, hostnames, IPs, usernames, paths or env. The `X-Powered-By` banner is removed on this route.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Vary: Origin`.
- GET and HEAD only. `OPTIONS` answers 204. Any other method gets 405 with `Allow: GET, HEAD, OPTIONS`.

**How the numbers are measured**
- A background timer (every 2 s, `unref`'d so it never keeps the process alive) reads the first line of `/proc/stat` and `/proc/meminfo`. Both are small in-memory kernel files (no disk). One tick takes about 40 to 60 microseconds, so the sampler costs well under 0.01% of one core. Requests never read `/proc`: they send the JSON built at the last tick.
- CPU % = busy time / (busy + idle time) between two ticks. Busy = user + nice + system + irq + softirq. Idle = idle + iowait. `steal` (time the host gave to other customers' VMs) is left out of both, so a VPS that is fully busy reads about 100% even when the host is crowded. This matches what Task Manager means by "how busy is my machine".
- Memory % = (MemTotal - MemAvailable) / MemTotal.
- On a machine without `/proc` (for example a Windows PC while developing) it falls back to `os.cpus()` times and `os.freemem()`.

**CORS**
- Only `https://afirstflag.com` and `https://www.afirstflag.com` get `Access-Control-Allow-Origin` (their own origin back). Never `Access-Control-Allow-Credentials`, so the browser sends no cookies and the homepage asks with `credentials: 'omit'`.
- The route is mounted before the global `cors()`, the same way as `/api/member/me`, so the global list (which also allows localhost ports) never applies here. Other origins get the same JSON with no CORS header, so a browser on another site cannot read it. CORS is not access control: anyone can still `curl` it, which is fine for these numbers.

**Rate limit**
- 60 requests per minute per client (fixed window, kept in memory, at most 5000 clients remembered). Over the limit: 429 `{"error":"rate_limit"}` with `Retry-After` (seconds). The homepage polls about 24 times a minute while the drawer is open, so one person with two tabs open stays under it.
- Who is "one client": when the request comes from nginx on the same machine (loopback), the last `X-Forwarded-For` entry (the one nginx adds; earlier entries are whatever the visitor sent), else `X-Real-IP`. When it comes from anywhere else, those headers are ignored and the socket address is used. This is stricter than the older `/api/flag-wallet-lookup` limiter, which trusts the first `X-Forwarded-For` entry.

## What did not change

- Every other route, the socket.io chat, `/api/member/me` (still credentialed CORS), `/api/online`, `/api/heartbeat`, the global `cors()` list, `/last5.txt`, edit mode, /rep, `users.json`.
- No new dependency, no `npm install`, no `.env` change.

## VPS steps (after Andy approves)

1. In `~/chat-app`: `cp users.json users.json.bak-081`, then `git pull`, then `pm2 restart "Eagles Nest"`.
2. Check: `curl.exe -s -i -H "Origin: https://afirstflag.com" https://chat.afirstflag.com/api/server-stats` shows 200, `Access-Control-Allow-Origin: https://afirstflag.com` and the JSON. Full checklist: TEST-081.md.

## Checks (done 2026-10-08 on the box, local test copies only)

- `npm test`: 9 tests (unit and route).
- Endpoint tests against the real `server.js`: JSON shape, no leaks, CORS matrix, preflight, 405s, rate limit (including spoofed `X-Forwarded-For`), other routes unchanged, CPU against an independent `/proc/stat` reading at idle, half load and full load, sampler cost, idle CPU against base 46eeca9.
- Browser tests (headless Chromium, page served as https://afirstflag.com through a local HTTPS front): desktop, phone, /rust/ and /c/, www, polling only while the drawer is open and the tab is visible, fallbacks, a foreign origin blocked by CORS.

## Risks and notes

- The numbers are public on purpose (they show on the homepage). They reveal the core count, memory use and when the VPS last rebooted. Nothing that names or locates the machine.
- If nginx does not send `X-Forwarded-For` or `X-Real-IP`, every visitor counts as the same client and the limit (60 a minute) would be shared, so the Server row would show `CPU: …` for some visitors when several have the drawer open. TEST-081.md has a one-line check of the nginx config.
- Port 3000 is open to the internet only if the firewall allows it (the server listens on all interfaces). A direct caller there is limited by its own address.
- Tier (CONTRIBUTING.md): Trusted. Read-only, no accounts, no files written.
