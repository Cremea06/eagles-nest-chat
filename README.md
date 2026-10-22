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

## Support entry (CHG-128)

The Shop's **Need to talk?** dialog links to the national 988 Suicide & Crisis Lifeline (call, text, or chat at
988lifeline.org) and offers **Join Milliway**, which opens `https://chat.afirstflag.com/?support=1`.

- The page removes `?support=1` from the address bar and tells the server once, with the first join. Nothing is shown to
  the room about the flag itself.
- Neagle then greets you **publicly** in Milliway by your display name: `Howdy partner, what seems to troubling you?`
  Milliway is a public room: everyone in it, including Neagle (an AI, not a counselor), sees what you write.
- For the rest of that connection, Neagle answers your lines with a supportive prompt (listen, encourage, no methods,
  no medical advice) and reminds you of 988 (call or text) and 911 for immediate danger whenever self-harm or suicide
  comes up. Neagle's replies go to an AI model provider, the same as every Neagle reply.
- **Privacy:** nothing extra is stored. The flag lives only in server memory on your connection and ends when you leave.
  The greeting is limited to one per connection and a few per visitor per hour, counted in memory under a salted hash,
  never the raw IP address.
- **Short-term memory (CHG-129):** so Neagle can follow the conversation, a support chat is remembered **only in server
  memory**, per connection: your lines and Neagle's replies (including the greeting), at most the last 10 turns and about
  4,000 characters. It is discarded when you leave, after 30 minutes of quiet, or when the server restarts, and it is
  never written to disk, logs, or the last-lines file. Each Neagle reply sends that recent conversation to the AI model
  provider along with your newest line. Ordinary (non-support) chat keeps no history.

## Clips (CHG-134)

Anyone in Milliway (guests and members) can press the gold **✂ Clip** button by the message box at any time, live or not.
A tray slides up over the bottom of the chat (the chat keeps moving) with the last 30 seconds of room lines (up to 25).
Trim lines from the top or bottom, add an optional caption (80 characters), and **Save**. You get a link
`https://chat.afirstflag.com/c/ID` with share buttons, the room sees `🎬 NAME clipped a moment` with an upvote and Open.

- **Stream slot:** during a Tailgate Party the card shows a Rumble placeholder and a **Watch on Rumble** link (the time
  offset is approximate). A Go Live broadcaster's name and title appear only when that broadcaster turned on
  **Allow clipping** (off by default, can be changed mid-stream). Otherwise the slot just says Milliway. No video yet.
- **Privacy:** a clip stores the chosen chat lines exactly as the room saw them (display names and text, with times),
  the caption, who clipped it (display name), when, the stream slot info above, and the upvote count (upvoters are kept
  as member names or an anonymous per-connection key, only to stop double votes). **Usernames in the clip appear on the
  public clip page and on the preview image that X, Telegram, Facebook and others show.** Clips are stored on the
  server in `clips.json` (not in git, owner-only file) and preview images in `clips-img/`; no IP addresses are stored.
- **Deleting:** the person who clipped can delete it from the share panel right after saving (a guest only during the same
  visit; a member any time while signed in, via `DELETE /api/clips/ID`). A broadcaster's **Remove my clips** strips their
  name and stream info from clips of their broadcasts (the chat lines stay). The admin can hide or delete any clip:
  `curl -X DELETE -H "Authorization: Bearer $CLIPS_ADMIN_TOKEN" https://chat.afirstflag.com/api/clips/ID` (add `?hide=1`
  to hide, `?hide=0` to unhide). Hidden clips never render. To have a clip removed, ask in Milliway or contact the shop.
- Limits: 5 clips per 10 minutes per person, 3 per minute per network address (counted under a hash, in memory).
  `CLIPS_MEMBERS_ONLY=1` in `.env` limits clipping and upvotes to members. Up to 5,000 clips are kept (oldest
  un-upvoted first out). SQLite is the planned later home for clips.
