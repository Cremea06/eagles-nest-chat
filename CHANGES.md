# CHG-058: "Neagle go into edit mode" (scripted Neagle flow, secret code, EDIT MODE flag in the header)

Nest/Milliway repo (Cremea06/eagles-nest-chat) only. No Shop change.
DRAFT, prepared 2026-10-02 on the deliberate track: not committed, not pushed, not deployed. Andy tests first.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `3bc7050` ("CHG-055: /rep state tag with throttle").
- Commit: none yet (fill in after Andy approves and commits).

## What changed

| File | Change | +/- |
|---|---|---|
| `lib/editMode.js` (new) | Trigger match, the code check (SHA-256 only, no plaintext code), the 2-minute timeout and the 5-try limit. | +40 / -0 |
| `server.js` | The scripted flow (`handleEditFlow`), the per-socket edit mode, and the `editmode:state` event to the room and to newcomers. The normal chat path now posts through a small `postHumanLine` helper (same output as before). | +94 / -6 |
| `public/index.html` | `EDIT MODE` flag in the header between the "Milliway" title and the Neagle pill, driven by `editmode:state`. The header row may wrap on narrow screens. | +32 / -0 |
| `.env.example` | Optional `EDIT_MODE_CODE_SHA256` (blank by default). | +4 / -0 |

**Trigger**
- Anyone in Milliway (guest or member) sends `Neagle go into edit mode`. Any case, any run of spaces between the words, and trailing punctuation or spaces are fine (`neagle   GO into edit mode!!`). Other wording is not a trigger (for example `@Neagle go into edit mode`, `Neagle, go into edit mode`, `hey Neagle go into edit mode`, or extra words after it); those stay normal messages.
- The trigger is shown to the room as a normal chat line (and goes into last5.txt like any public line).

**Flow (run by the server; Neagle's AI is never called, the token pill does not move)**
1. Neagle (room): `Are you sure <name>?` with the shown name, e.g. `Are you sure WV Andy?` or `Are you sure Guest-User 1234?`.
2. The same socket's next chat message, whatever it says, is shown to the room as a normal line. Then a system line to the whole room: `ALERT <NAME> HAS TRIGGERED THE EDIT MODE` with the shown name in uppercase (`ALERT WV ANDY HAS TRIGGERED THE EDIT MODE`). Then Neagle (room): `What's the code?`
3. The same socket's next chat message is the code attempt. It is never broadcast: only the sender sees it, as their own chat line. It is not written to last5.txt and not logged. The server compares it, trimmed and lowercased, against a SHA-256 hash (constant-time compare).
   - Right: Neagle (room) `code accepted`, and that socket enters edit mode.
   - Wrong: Neagle (room) `code rejected`. The flow ends; the next message is a normal line again.
- Neagle's scripted lines are ordinary `chat message` events with sender `Neagle`, so they look exactly like normal Neagle replies (gold name). They are written to last5.txt like normal Neagle lines. The ALERT is a system line, so like every system line it is not in last5.txt.
- Slash commands (`/who`, `/help`, ...) keep working during the flow and do not count as the reply.
- The existing mute rule applies first: a muted user cannot trigger or answer.

**Limits and timeout (per socket, in memory)**
- 5 wrong codes on one socket, then that socket's trigger is refused: the trigger line is still shown, and the sender alone gets the system line `Edit mode locked.` No Neagle line.
- A pending step with no reply for 2 minutes is dropped silently. The next message is then a normal line.
- Typing the trigger while already in edit mode: the trigger is shown, and the sender alone gets `You are already in edit mode.`
- Pending state, the wrong-code count and edit mode belong to that one socket (browser tab connection). Another tab of the same person is not affected.

**Edit mode**
- Lasts until that socket disconnects (tab closed, page refresh, network drop, or Socket.IO's own ping timeout). It survives /login + /auth on the same tab. It gives no other powers: every command and rule works exactly as before.
- Nothing is saved: no users.json field, no file.

**EDIT MODE flag in the header**
- The server sends `editmode:state` `{ on, names }` to the whole room whenever it changes (someone enters edit mode, or an edit-mode socket disconnects), and to each newcomer on join. `on` is true while at least one connected socket is in edit mode; `names` are their shown names (no duplicates).
- The page shows `EDIT MODE` between the title and the Neagle pill while `on` is true, for everyone in the room. The tooltip reads `In edit mode: WV Andy` (shown names, comma separated). When the last edit-mode socket disconnects, the flag disappears for everyone. A page that loses its connection hides the flag until it rejoins.
- Names in the tooltip update after `/rep` or a sign-in on an edit-mode tab.
- Text only (textContent and title), per CHG-048.

**The code**
- The code is not in this repo in plaintext. `lib/editMode.js` holds only the SHA-256 of the trimmed, lowercased code.
- To change it without a code change, set `EDIT_MODE_CODE_SHA256` in `.env` to the SHA-256 (64 hex chars) of the new code, lowercased and trimmed, then restart. A value that is not 64 hex chars is ignored with a warning in the log, and the built-in hash stays in use.

**Server log**
- `[editmode] on <username>`, `[editmode] wrong code <username> N/5`, `[editmode] off (disconnect) <username>`. Never the attempt text.

## What did not change

- Neagle's normal replies (mentions and the 12% random join), the token counter, the system prompt and the model call.
- /rep and its throttle, /nest, /login, /auth, /logout, the member cookie, /api/member/me, CHG-051 name rules, /mute, /who, /help text, presence roster, live broadcast, /last5.txt route.
- `lib/last5.js`, `lib/states.js`, `lib/repThrottle.js`, `lib/username.js`, `lib/memberToken.js`, `package.json`, `package-lock.json`. No new dependency. No users.json migration.

## VPS steps (after Andy approves)

1. On the laptop: commit `lib/editMode.js`, `server.js`, `public/index.html`, `.env.example` and this `CHANGES.md`, then `git push origin main`.
2. On the VPS, in `~/chat-app`: `git pull && pm2 restart "Eagles Nest"`.
3. No env change needed (the built-in hash is used). No npm install.

## Checks (done 2026-10-02 on the box, local test server only)

- Server tests (socket.io client against a local copy, with a test-only stand-in for the AI that records every call): 54/54 PASS. Covers the trigger variants, the exact lines and their order for the room and for the sender, the code attempt never reaching anyone else or last5.txt or the log, no AI call and no usage event during the flow, the 5-try lock, the 2-minute timeout (test-only clock), per-socket state, the header state on enter, on join and on disconnect, sign-in and /rep in edit mode, markup names as plain text, mute, the env override, and a base 3bc7050 reference run.
- The CHG-055 server suite run unchanged against this build: 62/62 PASS.
- Headless Chrome through a local HTTPS front: 18/18 PASS. The full flow as seen by the sender and by a guest, EDIT MODE between the title and the pill (also at 390 px wide), tooltip, newcomer sees it, it disappears after a refresh or a closed tab, the pill only moves for a real Neagle reply, no markup rendered, no page errors.

## Risks and notes

- The code is short and a common word. A SHA-256 of it can be reversed by a dictionary or brute-force guess in well under a second, so the hash keeps it out of casual reading of the public repo, not out of reach of a determined reader. For a real secret, set `EDIT_MODE_CODE_SHA256` to the hash of a long random code.
- The 5-try lock is per socket as specified. A page refresh gives a fresh socket and 5 more tries. Each try takes 3 messages, and the room sees every ALERT and "code rejected", so brute force is loud, but it is not blocked.
- If the 2-minute timeout passes after "What's the code?", the next message is a normal public line. A user who types the code late would post it to the room.
- Anyone can trigger the flow, and every trigger puts 2 to 4 lines in front of the room (a mild spam vector, similar to normal chat).
- Edit mode does nothing yet besides the header flag.
- Tier (CONTRIBUTING.md): Locked, because it speaks as Neagle (AI) and checks a secret.
