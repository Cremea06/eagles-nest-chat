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
  to hide, `?hide=0` to unhide). Hidden clips never render. To have a clip removed, ask in Milliway or contact the shop. Members can also delete their whole account, clips included (see below).
- Limits: 5 clips per 10 minutes per person, 3 per minute per network address (counted under a hash, in memory).
  `CLIPS_MEMBERS_ONLY=1` in `.env` limits clipping and upvotes to members. Up to 5,000 clips are kept (oldest
  un-upvoted first out). SQLite is the planned later home for clips.

## Deleting your account (CHG-138)

A signed-in member can delete their own account from the chat. Type `/delete`: the server emails a fresh code to the address
on the account (same mailer as sign-in) and shows you `auth code sent. /auth code to delete account`. Then type
`/auth <code>` as a normal chat line. Nothing else asks for confirmation, so the emailed code is the confirmation.

- **Codes:** a delete code is a different kind of code from a sign-in code. A sign-in code can never delete an account and a
  delete code can never sign anyone in. 10 minutes, single use, 5 wrong tries void it (type `/delete` again for a new one).
  The code is kept in server memory only (not in `users.json`). Requests are limited to 3 per account and 10 per network
  address (hashed, memory only) per 10 minutes. Guests get no code. The owner account is refused (the owner uses the admin route).
- **What is purged at once:** the member's record in `users.json` (username, email, join date, state, claimed X handle, sign-in fields); every
  clip they made (`clips.json`) with its cached card image in `clips-img/`; their upvotes on other clips (tallies drop with
  them); their open chat tabs, Go Live broadcast, `/nest` pass and live `/nest` session; their presence in the room; any
  waiting sign-in claim. The sign-in cookie stops working (the page also clears it). Other people's clips that show their
  name on a quoted line (`Name`, `WV Name`, `Name (flagholder)`) now show `Former member`, in the saved clips, the live clip
  buffer and `/last5.txt`; a Go Live clip that named them as broadcaster goes back to the plain Milliway slot.
- **What stays:** words typed inside someone else's message (for example "hi Alice") are not rewritten; content other people
  already saw or copied; server logs (pm2) that include the username (never the email in full); and `users.json.bak-delete`,
  one rolling copy of `users.json` taken just before each deletion (it is replaced by the next deletion; delete it by hand
  when you do not need it, and keep `users.json.bak-*` files out of git, they are gitignored). Backups made by hand on the VPS are
  yours to rotate.
- **Name hold:** the username is held for 90 days in `tombstones.json` (gitignored; names and dates only, no email), so
  nobody can take it straight away. New accounts also start at a random `tokenVersion`, so an old sign-in cookie can never
  sign in as a later owner of the same name.
- **Audit:** the log gets one line, `[account] deleted NAME clips=N votes=M anonymized=K`. No email, no code.
- Tests: `test/account-delete.test.js` (helpers) and `test/account-delete.server.test.js` (a real server on temp data and a
  fake local mail server; nothing is ever sent). `NEST_PORT` (default 3000) exists only so tests can pick a port.

## Claimed X handle (CHG-140, proof of concept)

A signed-in member can show an X (Twitter) handle on their profile page. It is **self-declared and unverified**: Milliway
never calls X, never fetches anything from X and never checks that the handle exists or belongs to the member. Start of a
possible "port my X profile" feature; for now it is only the handle.

- **Chat commands (members only):** `/x @handle` (the `@` is optional) sets it; `/x` alone shows the current value (or the
  usage); `/x clear` removes it. A bare word `clear` is the command, so to claim a handle that is literally named clear type
  `/x @clear`. Guests get `Only signed-in members can use /x. Type /login to sign in first.` and nothing is written. Every
  reply goes to the sender only (not to the room).
- **Validation:** 1 to 15 characters of `A-Z a-z 0-9 _`, ASCII only (one leading `@` is stripped; the typed case is kept).
  Anything else (spaces, dots, dashes, slashes, URLs, markup, Unicode lookalikes, longer than 15) is refused with
  `That is not a valid X handle. Use 1-15 letters, numbers or underscores, e.g. /x @handle.` (`lib/xhandle.js`).
- **Rate limit:** 5 changes (sets or clears) per member per hour, in memory (resets when the server restarts), shared by all of
  the member's tabs. Invalid input and plain reads do not count.
- **Storage:** optional field `xHandle` on the member's record in `users.json` (never for guests). It is removed by `/x clear`
  and goes with the whole record on `/delete`. Saved with the normal `saveUsers`, which also clears the profile cache.
- **Profile:** `GET /api/profile/<name>` adds `xHandle` and `xVerified: false` only when a handle is set (the stored value is
  checked again on output, so a hand-edited bad value is never served). The key list is the allow-list `PUBLIC_FIELDS` in
  `lib/profile.js` (`username`, `tier`, `joined`, `xHandle`, `xVerified`); nothing else can leave. `/u/<name>` shows
  `X: @handle (unverified)` linking to `https://x.com/<handle>` (`rel="nofollow noopener noreferrer ugc"`, `target="_blank"`)
  and the line `Claimed by the member; not verified by Milliway.` The name is set as text and the link is built only from
  the checked handle. Public profile caching still applies (API 60 s, page 5 min), so a change can take up to a minute to show.
- Tests: `test/xhandle.test.js` (validation, API allow-list, profile page script on a fake DOM) and
  `test/xhandle.server.test.js` (a real server on temp data and a fake local mail server).

## Guests join muted until 100 keystrokes (CHG-141)

A guest (anyone not signed in) cannot post a plain chat line until the chat page has reported 100 real key presses in the chat box. A blocked line is not broadcast, not written to `last5.txt`, not put in the clip buffer and never sent to Neagle's AI; Neagle answers that guest only with a canned line ("Welcome, guest! Before you can speak in Milliway, you are required to record 100 keystrokes (you're at N/100). ..."), at most once per 5 s. At 100 the guest gets "Thank you, you may enter the conversation." (also private) and chats normally. Slash commands, `/login` and `/auth` are never gated. Members are never gated. The admin `/mute` still wins.

How: the page counts trusted key presses (a character or Backspace; not Ctrl/Cmd shortcuts, not bare modifiers, not Enter) and sends `keys:report {count}` (a cumulative number, up to four times a second while keys are being counted). The server (`lib/keystrokeGate.js`) credits it at no more than the speed limit below and sends `keys:state {gated, need, count}` back. The count lives in memory on the socket: no cookie, no storage, never what was typed, nothing logged. A page reload is a new guest and starts at 0. It is friction, not security: a script can still earn its 100 in about 2.6 seconds (CHG-142; it was about 8).

### Held keys count, at normal speed only (CHG-142)

Holding a key down (auto-repeat) counts as keystrokes, but only up to the normal OS default repeat speed; anything faster counts for nothing. The ceiling is one counted keystroke per 30 ms (33.3 per second sustained), with a small burst allowance (4 keys on the page for fast typists/rollover, 15 per report on the server). That sits just under the quickest everyday default (Windows ~30 chars/s after a 500 ms delay; GNOME 30 ms) and equals the fastest setting macOS's settings screen offers (macOS default is ~11/s, X11 `xset` default 25/s). A key repeating faster than that (terminal-only tweaks, macros, scripts) is simply not counted: no error, no penalty. All the numbers live in ONE file, `public/keystroke-limits.js`, which the chat page loads and the server `require`s, so the page limiter and the server cap cannot drift apart. The server enforces the ceiling on its own (credit <= 15 + 33.3 x elapsed seconds, whatever the page claims); a default-speed hold reaches 100 in about 3.5-4 s, a forged "I am at 100" report not before about 2.6 s. A hold can only be counted from real (trusted) key events; synthetic events never count. Tests: `test/keystroke-limits.test.js` (page limiter and which keys count), `test/keystroke-gate.test.js` and `test/keystroke-gate.server.test.js`.
