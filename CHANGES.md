# CHG-055: /rep <STATE> chat command (state tag before a member's name) and the homepage pill

Nest/Milliway repo (Cremea06/eagles-nest-chat) plus one line in the Shop (Cremea06/afirstflag, see the Shop note below).
DRAFT, prepared 2026-10-02 on the deliberate track: not committed, not pushed, not deployed. Andy tests first.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `6a1002d` ("CHG-053: CHANGES.md write-up").
- Commit: none yet (fill in after Andy approves and commits).

## What changed

| File | Change | +/- |
|---|---|---|
| `lib/states.js` (new) | The 50 US states: standard 2-letter USPS codes and full names. No DC, no territories. `normalize(raw)` returns the uppercase code or null (case-insensitive, surrounding spaces ignored); `nameOf(code)` returns the full name or null. | +28 / -0 |
| `lib/repThrottle.js` (new) | Per-account /rep throttle, in memory. `createRepThrottle(now)` with an injectable clock (for tests); `waitSeconds(key)` and `record(key)`. | +41 / -0 |
| `server.js` | `/rep` command, the throttle, the `rep` field on the member record, the shown name "WV Andy" in the room, and two new fields on `/api/member/me`. | +88 / -11 |

**The command**
- `/rep WV` (any case, e.g. `/rep wv`, `/REP Wv`). The code is stored and shown in uppercase.
- Only a signed-in member can use it: a socket that resumed from a valid `nest_member` cookie, or that finished `/auth` on this page, and whose account is in users.json. Guests and sockets that are halfway through /login get a private line: `Only signed-in members can use /rep. Type /login to sign in first.` Nothing goes to the room and nothing is saved.
- `/rep` with no state, or with more than one word (e.g. `/rep West Virginia`): private usage hint, `Usage: /rep <STATE> with a 2-letter US state, e.g. /rep WV. You can switch states but not clear one.` If a state is already set, it adds `You are shown as WV Andy.`
- Anything that is not one of the 50 codes (DC, PR, `none`, `XX`, `wva`...): private `Unknown state. Use one of the 50 US state abbreviations, e.g. /rep WV.` The typed text is not echoed back.
- The same state again: private `You already represent West Virginia.` and no new room line.
- Throttle (per member account, all tabs and devices together, not per socket): the first 10 successful switches in a rolling 1-minute window go through freely. After the 10th, further switches are limited to one per 60 seconds until the window clears. A throttled attempt gets only this private line, exactly:
  `A double-minded man is unstable in his ways`
  No countdown is shown. Nothing is saved and nothing goes to the room. Same-state re-claims, usage hints and unknown states are answered as above and do not count. Every successful switch counts, including the first claim. The tracking is in memory only and resets when the server restarts.
- A valid new state: saved to users.json, then the whole room (including the sender) gets this system line, spelled exactly as Andy asked, with the intentional "Chapster":
  `Republican Chapster from West Virginia will now be recognized Andy`
  The name at the end is the stored username (no prefix).
- Anyone may claim any state; there is no check. A member can switch at any time with another `/rep`. There is no way to clear a state (no `/rep none`).

**Message delivery and sender label**
- Private replies use the existing `system` event on the sender's socket only, like every other command reply (/help, /whoami, /mute usage).
- The success line uses `io.emit('system', ...)`: the centered, italic system line the room already uses for "X joined the chat", "X went live" and "* X waves". It has no sender label, so the text reads exactly as specified. It is not written to last5.txt (system lines never were).

**Where the state is stored**
- A new optional field `rep` (for example `"rep": "WV"`) on the member's users.json record. `username` is never changed, so login, /auth, the 30-day cookie, /nest, /mute and the CHG-051 name rules all keep using the plain name.
- Because it lives on the record, it survives a page refresh, a reconnect, a server restart, /logout and a fresh sign-in.
- The value is checked against lib/states.js every time it is read, so a bad hand edit in users.json shows no prefix instead of junk.

**Where "WV Andy" shows**
- Chat lines (`chat message` username), `/me` lines, `/who`, the welcome line, "joined the chat", "has joined the chat" after /auth, "left the chat", and the Who's here roster.
- After a successful `/rep`, a `presence:update` goes out for every open Milliway tab of that member, so the roster changes at once without a reload.
- A flagholder keeps the tag after the name, e.g. `WV Andy (flagholder)`.
- The `joined` event to the member's own page still carries the plain username (the page uses it to tell guest from member for ?login=1). Neagle is still addressed with the plain username.
- All of it is still plain text: the page renders names and messages with textContent (CHG-048), unchanged.

**`GET /api/member/me` (additive)**
- Member: `{"member":true,"name":"Andy","rep":"WV","display":"WV Andy"}`. A member without a state gets `"rep":null` and `"display"` equal to the name.
- Not a member: `{"member":false}`, unchanged.
- CORS, Vary, Cache-Control, OPTIONS handling, the origin list and the no-write/no-cookie behaviour are unchanged. Old consumers that read `member` and `name` see the same values.

**/help** lists one new line: `/rep <STATE>         - Show your US state before your name, e.g. /rep WV (members)`.

## What did not change

- `public/index.html` (the chat page), `lib/username.js`, `lib/memberToken.js`, `lib/last5.js`, `package.json`, `package-lock.json`, `.env.example`. No new dependency, no env change.
- CHG-051 name rules, the cookie format, /login, /auth, /logout, /nest, /mute matching (still by plain username), Neagle, /last5.txt route.
- Go live / end live lines and the Broadcast card still use the plain username.

## Shop note (afirstflag.com)

One line in `index.html` (base `b2ea92e`, live md5 f0c058b3): the Signed in pill now uses `display` when it is a non-empty string, otherwise `name` as before. Result: `Signed in: WV Andy`. Same single fetch, same textContent. Either side can ship first: the old Shop page ignores the new fields, and the new Shop page falls back to `name` against an old Nest.

## VPS steps (after Andy approves)

1. On the laptop: commit `lib/states.js`, `lib/repThrottle.js`, `server.js` and this `CHANGES.md`, then `git push origin main`.
2. On the VPS: `git pull`, then `pm2 restart "Eagles Nest"`.
3. No env change. users.json needs no migration (members without `rep` simply show no prefix).

## Checks (done 2026-10-02 on the box, local test server only)

- Server test (socket.io client against a local copy, 62/62 PASS): guest and mid-login sockets blocked privately; no-arg and two-word usage hint; DC, PR, none, XX, wva, markup rejected privately; exact West Virginia and Texas lines; switch; same-state note; cannot clear; users.json `rep` saved with username unchanged; chat, /me, /who, welcome, joined, left and roster show the prefix; both tabs of one member update; reconnect, server restart, /logout plus fresh sign-in all keep the state; `/api/member/me` new fields, and CORS/status/cache headers identical to base for 5 origin and cookie cases (GET and OPTIONS). Throttle (unit tests with an injected clock, plus end to end with a test-only clock preload that moves Date.now): 10 free switches; the 11th inside the minute gets exactly `A double-minded man is unstable in his ways` privately, with no room line, no roster update and nothing saved; still throttled 30 s later; allowed again after 60 s; window reset after 1 minute (10 free again, then throttled); same-state re-claims do not count; per account across two tabs (5 + 5, then both tabs throttled); another account unaffected; a restart clears it.
- Headless Chrome through a local HTTPS front (12/12 PASS): the room line and "WV Andy" chat line and roster render; markup in a name and message stays text and no script runs; reload keeps "WV Andy"; homepage pill "Signed in: WV Andy" on afirstflag.com and www; signed out shows Guest User with no pill; old Shop page with new Nest shows "Signed in: Andy"; new Shop page with old Nest shows "Signed in: Andy".

## Risks and notes

- Accepted by Andy (2026-10-02): CHG-051 does not reserve names shaped like "WV Andy", so a new account could pick such a name and look like a member with a state. The CHG-051 rules stay unchanged.
- /rep is unverified on purpose: anyone may claim any state.
- Throttle: with a 1-minute window and a 60-second gap, the gap never ends later than the window frees a slot, so in practice the limit is 10 switches in any 60 seconds per account. A member can still send up to 10 room lines a minute. The throttle resets on a server restart.
- Tier (CONTRIBUTING.md): Locked, because /rep writes users.json. It is listed in /help as the Open rules ask.
