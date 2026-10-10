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
