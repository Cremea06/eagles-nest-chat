# Eagles Nest Chat

AI-monitored public chat for afirstflag.com.

Live: https://chat.afirstflag.com  
Site repo: https://github.com/Cremea06/afirstflag

## Current help wanted

Open-tier chat commands — [Issue #1](https://github.com/Cremea06/eagles-nest-chat/issues/1).

Command tiers and rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Run locally

```bash
cp .env.example .env   # add keys locally; never commit .env
npm install
npm start
```

## last5.txt (public room tail)

`https://chat.afirstflag.com/last5.txt` is **world-readable on purpose**. It holds only
the last 5 lines already broadcast to the public Milliway room (people and Neagle), one per
line as `username: text`, rewritten on every public message. It is a tail, not a log
archive: nothing older than 5 lines is kept, it starts empty on every server restart, and it
never contains commands, login/register/auth traffic, private-pane text, system notices,
presence events, or Nest World (`/nest`) traffic.

The file lives at `data/last5.txt` (gitignored; override with `LAST5_PATH`). The node
process must be able to create and write that directory.

## Server stats (public, read-only)

`https://chat.afirstflag.com/api/server-stats` gives the homepage Server row (Live-state Analysis drawer on
afirstflag.com) its numbers: CPU % of the VPS, the last 60 readings (one every 2 s), memory % and uptime. Numbers
only. Browsers may read it only from `https://afirstflag.com` and `https://www.afirstflag.com` (no cookies); 60
requests a minute per visitor. The sampler lives in `lib/serverStats.js`; tests: `npm test`. Details: CHANGES.md (CHG-081).

## Safe link check (CHG-106)

`POST https://chat.afirstflag.com/api/safe-link` with `{"url": "..."}` (JSON, max 2 KB) answers
`{verdict: "safe"|"caution"|"danger"|"unknown", reasons: [...], host, finalUrl?}` for the homepage search box.
It asks Google Safe Browsing (Lookup API v4), checks brand lookalikes and red flags, and expands known short links
(HEAD only, max 5 hops, private/local addresses refused on every hop). Only the two afirstflag.com origins get CORS;
10 checks per minute per client. URLs are never logged or stored. Needs `GOOGLE_SAFE_BROWSING_KEY` in `.env`
(never commit it). `TRUST_PROXY=1` only if nginx sends X-Forwarded-For. Tests: `npm test`; one real Google call:
`npm run test:live`. Logic: `lib/safeLink.js`, `lib/brands.js`.

## Offline chatroom (Windows PowerShell)

`tools/offline-chatroom.ps1` is a small console script for your own PC: a local scratch chat
that can also show the public room's last 5 lines. It does not sign in and cannot post to the
live chat.

**Requirements:** Windows PowerShell 5.1+ or PowerShell 7 (`pwsh`).

**Download** the script into a folder of your choice, from
https://raw.githubusercontent.com/Cremea06/eagles-nest-chat/main/tools/offline-chatroom.ps1
or in PowerShell:

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/Cremea06/eagles-nest-chat/main/tools/offline-chatroom.ps1 -OutFile offline-chatroom.ps1
```

**Run** it from that folder. `Unblock-File` removes the "downloaded from the internet" mark:

```powershell
Unblock-File .\offline-chatroom.ps1
.\offline-chatroom.ps1
```

If PowerShell still refuses to run scripts, allow it for that run only:

```powershell
powershell -ExecutionPolicy Bypass -File .\offline-chatroom.ps1
```

(With PowerShell 7, use `pwsh` instead of `powershell`.)

**Commands** at the `you:` prompt (case-insensitive; empty lines are ignored):

| Type | What happens |
|---|---|
| anything else | printed as `[local] ...` and saved to the local log |
| `/sync` | fetches https://chat.afirstflag.com/last5.txt and prints it (download only) |
| `/quit` | exits |

`/sync` prints `no remote file yet` when the tail is empty (or missing), `offline` when the
server cannot be reached, and `offline (HTTP <code>)` for any other HTTP error.

**Where local lines are saved:** `offline-chatroom.log` in the same folder as the script (or the
current folder if the script is pasted into a console), one line per entry:
`yyyy-MM-dd HH:mm:ss [local] text`.

**Privacy:** local lines stay on your PC and are never sent anywhere. `/sync` only reads the
public last-5 tail, a plain HTTPS GET of the same `last5.txt` anyone can open in a browser.
That file empties whenever the chat server restarts, so right after a restart `/sync` shows
`no remote file yet`.
