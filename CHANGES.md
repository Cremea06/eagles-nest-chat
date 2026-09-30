# CHG-044 — offline-sync: `/last5.txt` (pack tag CHG-044-offline-sync)

Nest/Milliway only (chat.afirstflag.com, repo Cremea06/eagles-nest-chat). Shop untouched.
Not pushed, not deployed, not marked shipped.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `83c1d232d7c949a1c763062962e575fd3293854f` ("second part of main page command line login").
  Fresh clone on 2026-09-30; `main` HEAD was exactly this SHA (main had not moved).
- `chg-044.diff` is `git diff` against that SHA (new file included); `git apply --check` passes on a clean checkout.

## What changed

| File | Change | +/- |
|---|---|---|
| `lib/last5.js` | **new**: in-memory ring of the last 5 public lines, sanitiser, serialized atomic writer, GET handler | +137 / -0 |
| `server.js` | require the module; create it and register `GET /last5.txt`; two `last5.record(...)` hooks | +9 / -0 |
| `.gitignore` | add `/data/` | +1 / -0 |
| `README.md` | new "last5.txt (public room tail)" section; also closes the previously unclosed ```` ```bash ```` fence in "Run locally" | +13 / -0 |

No new npm dependencies (`package.json` / `package-lock.json` unchanged). No new slash commands, no post-back,
no client/UI changes (`public/index.html` byte-identical to base).

## Path choice: explicit route + file outside `public/`

`GET /last5.txt` is an explicit Express route (`app.get('/last5.txt', last5.handler)`), registered **before**
`express.static`, that reads `data/last5.txt` (override with env `LAST5_PATH`).

Why not `public/last5.txt`:
- `public/` is git-tracked. A file the server rewrites there makes the deploy tree dirty and can make
  `git pull` refuse or conflict during a deploy. `data/` is outside `public/` and gitignored (`/data/`), so
  the working tree stays clean.
- The route lets us set the headers exactly: `Content-Type: text/plain; charset=utf-8`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Missing-file case handled explicitly: if the file does not exist, the route returns **200 with an empty
  body** (other read errors → 500 empty body, logged).
- Registered before `express.static`, so a stray `public/last5.txt` can never shadow it.

## Behaviour

- Ring of the last **5** lines in memory, file rewritten on **every** qualifying message (a tail, not an archive).
- Boot: the in-memory ring is **empty** and the file is **truncated to empty** at startup (synchronous
  atomic write before `server.listen`, so the first request after a restart already sees the empty file).
  No seeding: the server keeps no chat history in memory, so there is nothing to seed from.
- File format: one line per message, `username: text`, each line terminated with `\n`; empty file when the ring is empty.
- Atomic write: write `.last5.txt.<pid>.<n>.tmp` in the same directory, then `fs.rename` over `last5.txt`.
  On failure the temp file is unlinked.
- Serialized: every write goes through one promise chain; each queued write snapshots the ring when it runs,
  so concurrent messages cannot interleave and the file always ends at the latest state.
- Never throws into the chat path: `record()` is wrapped in try/catch; write errors are caught and logged
  (throttled to one log line per minute so a bad path cannot flood pm2 logs). Chat keeps working even if the
  file can't be written (tested with a read-only dir and a `/proc` path).
- The data dir is created with a **non-recursive** `mkdir` at boot (its parent must exist; for the default
  `data/` the parent is the app dir). Recursive mkdir was avoided on purpose: in Node 20 it hung on a `/proc`
  path during testing.

### Sanitising rules (applied to both username and text)

- C0 controls U+0000–U+001F (includes `\n`, `\r`, `\t`, ESC, BEL), DEL U+007F, C1 controls U+0080–U+009F,
  U+2028/U+2029 line/paragraph separators, and bidi overrides/isolates U+202A–U+202E, U+2066–U+2069 are
  replaced with a space (a run of them becomes one space), then the result is trimmed.
- Length caps (by Unicode code point, so surrogate pairs are never split): text **500**, username **64**;
  trimmed again after capping.
- A message whose text is empty after sanitising is not recorded. An empty username becomes `Anonymous`
  (can't happen today; the server always assigns one).
- The username recorded is exactly what was broadcast (`displayName`, i.e. including ` (flagholder)` when
  set). The text recorded is the broadcast `msg` / Neagle `reply`.

## Emit sites (default namespace `'/'`), line numbers in base 83c1d23 → out

`'chat message'` is only broadcast in two places. Both are hooked:

| Base line | Out line | Site | Class | Action |
|---|---|---|---|---|
| 868 | 875 (hook 879) | `io.emit('chat message', { username: displayName, message: msg })` | human public message | **hooked**: `last5.record(displayName, msg)` right after the emit |
| 884 | 892 (hook 896) | `io.emit('chat message', { username: 'Neagle', message: reply })` inside the `setTimeout` | Neagle (AI) public reply | **hooked**: `last5.record('Neagle', reply)` right after the emit |

Deliberately skipped (none of these are `'chat message'`; listed so the classification is explicit):

| Base line | Site | Class |
|---|---|---|
| 170 | `io.emit('system', '* name action')` (`/me`) | system broadcast (command output) |
| 334 | `socket.broadcast.emit('system', 'X registered.')` | system broadcast (legacy reg flow) |
| 597 | `io.emit('usage', ...)` | usage counter |
| 688 | `socket.broadcast.emit('system', 'X joined the chat')` | presence/system |
| 701 | `socket.broadcast.emit('presence:join'/'presence:update')` | presence |
| 824 | `socket.broadcast.emit('system', 'X has joined the chat')` (after `/auth`) | auth/system |
| 831 | `io.emit('presence:update')` | presence |
| 900, 912, 939 | `user-live` / `user-ended-live` | live-stream signalling |
| 905, 916, 943 | `io.emit/socket.broadcast.emit('system', 'went live' / 'ended the live stream')` | system broadcast |
| 922, 928 | `io.to(id).emit('watch-request' / 'webrtc-signal')` | WebRTC, targeted |
| 946 | `socket.broadcast.emit('system', 'X left the chat')` | presence/system |
| 950 | `socket.broadcast.emit('presence:leave')` | presence |
| 1030, 1046, 1058 | `nestNs.emit('playerLeft')` / `socket.broadcast.emit('playerJoined')` on `/nest` | `/nest` namespace |
| all `socket.emit('system', ...)` | command replies (`/help`, `/who`, `/whoami`, `/nest` mint URL, `/mute`, unknown command, `/auth` failure, muted, etc.) | server-only replies to one socket |
| 711, 752 (priv:line); 732, 735, 738, 746, 759, 779, 782 (priv:result) | `socket.emit('priv:line' / 'priv:result')` | private pane (`/login`, `/register`: emails, codes) |

Why commands can never reach the hooks: every text starting with `/` returns via `handleCommand()` before
the human emit at base line 868; the browser handles `/login`, `/register` and `/auth` client-side
(`priv:open`/`priv:line`/`auth:try` events), which never touch `'chat message'`; the legacy registration input
also returns before the emit. `/nest` and `/world` traffic is on another namespace / HTTP route.

## What did not change

- `public/index.html` (byte-identical), `public/world/*`, `package.json`, `package-lock.json`, `.env.example`,
  `CONTRIBUTING.md`, `LICENSE`.
- Every existing emit, command, route and namespace in `server.js`: `/nest` command and `io.of('/nest')`
  handshake, `/world` route, `milliwayPresence` and all `presence:*` emits, priv pane, `auth:try`, go-live /
  WebRTC, BTC lookup, Neagle prompt/trigger logic. The only server.js edits are the 9 added lines above.
- No new slash commands, no upload/post-back endpoint, no UI.

## Must-exist counts (base vs out)

| File | Marker | Base 83c1d23 | Out |
|---|---|---|---|
| public/index.html | `#sideCol` | 4 | 4 |
| public/index.html | `#whoCard` | 3 | 3 |
| public/index.html | `#liveCard` | 2 | 2 |
| public/index.html | `#worldCard` | 4 | 4 |
| public/index.html | `#enterWorldBtn` | 2 | 2 |
| public/index.html | `world:enter` | 1 | 1 |
| public/index.html | `world:pass` | 1 | 1 |
| public/index.html | `world:error` | 1 | 1 |
| public/index.html | `CHG-042 ?login hook: URLSearchParams` | 1 | 1 |
| public/index.html | `CHG-042 ?login hook: get('login')` | 1 | 1 |
| public/index.html | `CHG-042 comment` | 1 | 1 |
| public/index.html | `Broadcast heading` | 1 | 1 |
| public/index.html | `Milliway (titles)` | 3 | 3 |
| public/index.html | `<title>Milliway</title>` | 1 | 1 |
| public/index.html | `presence listeners socket.on('presence:` | 4 | 4 |
| server.js | `/nest command (command === '/nest')` | 1 | 1 |
| server.js | `io.of('/nest')` | 1 | 1 |
| server.js | `'/nest' (any)` | 3 | 3 |
| server.js | `/world route app.get(['/world'` | 1 | 1 |
| server.js | `milliwayPresence` | 7 | 7 |
| server.js | `presence:* emits` | 5 | 5 |
| server.js | `io.emit('chat message'` | 2 | 2 |

No count dropped.

## Tests (see `test/`)

- `test/test-last5.js` → `test/test-output.txt`: socket.io-client suite that spawns `node server.js`
  (port 3000, dummy `WORLD_TOKEN_SECRET`, no `XAI_API_KEY`, no SMTP). **36 passed, 0 failed** (also 3/3 clean
  runs before the final one).
  - Boot: `GET /last5.txt` 200, `text/plain; charset=utf-8`, `no-store`, empty body; file exists.
  - Private/command/system traffic: `/register` via priv pane (username + test email), `/login` via priv pane,
    wrong and correct `/auth` codes (codes read from the server's existing `[auth code]` log line, since SMTP is
    unset), raw `/login <email>`, `/register`, `/auth <code>`, `/help`, `/?`, `/who`, `/whoami`, `/me`, `/mute`,
    `/cancel`, `/nest`, unknown command, go-live/end-live → file stays empty and no chat broadcast occurs.
  - `/nest`: registered user minted a pass, connected to the `/nest` namespace with it and emitted
    `chat message`/`message`/`move`/`say`/`playerMoved` there → never appears.
  - Presence join/leave (extra client connect + disconnect) → never appears.
  - 8 public messages from two clients (registered `Tester044` and a guest), including one with `\n`, `\r\n`,
    `\t`, BEL, ESC, U+2028, U+202E, one of 700+ chars and one padded with spaces. After **each** message the file
    equals the last 5 broadcast lines in broadcast order; 5 lines + trailing newline; format checked; sanitised
    line, 500-char cap and trim verified.
  - Neagle: see below. Burst of 20 concurrent messages from two clients → file equals the last 5 broadcast
    lines in order; no stray temp files; disk file == HTTP body.
  - Forbidden scan over every file state seen (email, codes, command words, system/priv/presence/nest text) →
    no hits; every line ever written matched a public chat broadcast.
  - Restart → file truncated to empty. Read-only dir and `/proc` `LAST5_PATH` → server boots, GET returns 200
    empty, chat still delivered, one throttled `[last5] init failed` log line.
  - Cleanup: `users.json` and `data/` removed from the work folder.
- **Neagle reply**: tested through the real product path with no stubbing. `askNeagle()` returns its built-in
  string `The human forgot to give me my API key. Typical.` when `XAI_API_KEY` is empty, and that is broadcast
  as a normal Neagle `chat message`. A message containing "neagle" produced that reply, and it was recorded as
  `Neagle: The human forgot to give me my API key. Typical.` The xAI URL is hard-coded (no base-URL env var),
  so a fake provider could not be plugged in without changing product code, and wasn't. The random 12% Neagle
  join also fired during some runs; the suite compares against the observed broadcast stream, so it copes.
- `test/test-browser.js` → `test/browser-base.json`, `test/browser-out.json`: headless Chrome
  (`/usr/bin/google-chrome`, puppeteer-core) on base and out: page loads, guest joins, #sideCol/#whoCard/
  #liveCard/#worldCard/#enterWorldBtn present, "1 online", typed message echoes, `/login` opens the priv pane.
  Console errors are identical on base and out: one `404 /favicon.ico` (already there in base). No page errors.
  Out: `/last5.txt` holds the browser line and nothing from `/login`. Base: `/last5.txt` is 404 (expected).
- Test tooling (socket.io-client, puppeteer-core) was installed in a separate `/workspace/chg-044/testenv`, not in the repo.

## Deploy note (for whoever ships it; not done here)

1. On the server: `cd` to the app dir, `git pull` (the tree stays clean: `data/` is gitignored), then
   `pm2 restart <app>` (no `npm install` needed; no dependency change).
2. File location: `<app dir>/data/last5.txt`, created at boot. The user pm2 runs node as needs **write +
   execute permission on the app dir** (to create `data/` once) and on `data/` (to create the temp file and
   rename it). Alternatively create it ahead: `mkdir -p data && chown <node-user> data && chmod 755 data`.
   The file is written mode 0644 (world-readable is fine; the content is public).
   Setting `LAST5_PATH=/some/dir/last5.txt` moves it; that dir's parent must exist and the dir must be writable.
3. If nginx/Cloudflare fronts the site, `Cache-Control: no-store` should keep it uncached; check that no rule caches `*.txt`.
4. Smoke: `curl -i https://chat.afirstflag.com/last5.txt` → 200, `text/plain; charset=utf-8`, empty right after
   the restart; post a public line and fetch again.
5. Expect the file to be empty after each pm2 restart (by design).

## Revert

- Before commit: `git checkout -- server.js README.md .gitignore && rm -rf lib/last5.js data/`.
- After commit: `git revert <CHG-044 commit>` then `git pull` + `pm2 restart <app>` on the server; optionally
  `rm -rf data/` there. No data migration involved; nothing else depends on the file.

## Caveats

- The file resets to empty on every restart (in-memory ring, no seeding). This is on purpose; say so if a
  restart-surviving tail is wanted (easy: seed the ring from the file at boot).
- It is world-readable by design: anything said in the public room (including an email someone pastes as a
  normal public message) shows up there for up to 5 messages. Commands and priv-pane input never do.
- `fs.rename` over an existing file is atomic on Linux (production). On Windows, rename can fail with EPERM if
  something holds the file open; that would only log and skip that write.
- Pre-existing, not changed: the client renders chat via `innerHTML`; the server logs `/auth` codes to the pm2
  log (`[auth code] ...`); the client emits `world:enter` but the server has no handler for it. Out of scope, noted only.
