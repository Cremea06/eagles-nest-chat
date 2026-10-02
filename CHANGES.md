# CHG-051: one server-side username rule for new registrations

Nest/Milliway only (chat.afirstflag.com, repo Cremea06/eagles-nest-chat). Shop untouched.
On main as `ce97464` ("CHG-051 name rules"), 2026-09-30. CHANGES.md was not updated in that commit; this write-up is added afterwards.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `0e11ad2b75617f82c3bbfd8211c491a4ebab185a` ("CHG-049: adding server.js").
- Commit: `ce974649a48b7c0ab20fe8883bd933bc5b3697b8`.

## What changed

| File | Change | +/- |
|---|---|---|
| `lib/username.js` (new) | The shared validator. `check(raw, {email, serverGenerated})` returns `{ok:true, name}` (the normalized name) or `{ok:false, reason}` (plain text for the user). Also exports `normalize`, `fold`, `reservedKey`, `RESERVED`, `MIN`, `MAX`. | +83 / -0 |
| `server.js` | Requires the rule. Applies it at the private-pane `/register` **name step**, checks owner-only names at the **email step** (the Andy gate), and guards the legacy chat-registration confirm step (unreachable since CHG-047). | +23 / -2 |

**The rule (new names only)**
1. **Hidden characters** in the raw input are rejected: Unicode format characters (Cf, e.g. zero-width, bidi controls, U+FEFF, soft hyphen), lone surrogates, private use, and blank fillers (U+115F, U+1160, U+3164, U+FFA0, U+2800). Checked before whitespace collapsing, because JS `\s` would turn U+FEFF into a space.
2. **Normalize**: trim, and collapse each whitespace run to one space. The normalized name is what gets stored.
3. **Markup**: reject `< > & " '` and the backtick.
4. **Controls**: reject control characters left after collapsing (C0, DEL, C1).
5. **Length**: 2 to 24 characters, counted in code points.
6. **Letter or number**: at least one letter or digit.
7. **Reserved names** (below).

Rejections reach the user through the existing pane line `Fail. <reason> Closing in 5 seconds`, rendered as text by CHG-048. No page change.

**Reserved keys**: `neagle`, `admin`, `operator`, `system`, `andy`, `guestuser`, `server`, `anonymous`.
- Compared as **whole keys** after folding, so 'Sandy', 'Adminton', 'Systemic', 'NeagleFan' and 'Andy Smith' stay allowed.
- `guestuser` is a **prefix**: no new name may start with the guest prefix ('Guest User 1234', 'Guest-User 1234', 'GuestUserFan').
- **Fold**, applied to the candidate and to each key: NFKC, lowercase, strip accents (NFD then drop combining marks), a lookalike skeleton (Greek and Cyrillic letters to Latin, IPA and Armenian g to g; i, 1, |, U+01C0 and dotless i to l; 0 to o), strip whitespace, punctuation (including `_` and `-`), symbols and Cf, then `rn` to `m`.

**The Andy gate**
- `andy` is the only owner-only key. A name that folds to `andy` passes the name step if every other rule passes; the email step then allows it only when the account email (trimmed, lowercased) matches Andy's. Otherwise: `Fail. That name is reserved. Closing in 5 seconds`, and no account or code is created.
- The email is in the code only as a SHA-256 hash (`OWNER_EMAIL_SHA256.andy`), because the repo is public. The account still has to be confirmed with the `/auth` code sent to that inbox.

**Server-generated guest names** (`Guest-User NNNN`) skip the reserved check (`serverGenerated`); the full 1000 to 9999 range passes every other rule.

**Where the rule applies** (server.js line numbers at ce97464)
- `:895` register, name step: the only path that takes a new name from a user. Rule applied and the name normalized; the guest-name and duplicate checks then run on the normalized name.
- `:915` / `:917` register, email step: Andy gate, `check(name, {email})`.
- `:382` legacy chat-registration confirm: guarded with that path's own `system` message.
- Not validated, on purpose (stored or server-made names): `join` (`:796`, browser-sent names ignored since CHG-047), Guest-User generation (`:820`), cookie restore (`readMember`, `io.use`), login by email, `auth:try`, `POST /api/member/session`, the `/nest` command and namespace, Neagle replies.

## What did not change

- **Stored names are never re-checked or rewritten**, and users.json is not touched. Legacy members whose names would fail the new rule (including the existing 'Andy') still log in, restore by cookie, enter /nest, and appear in `/api/member/me`.
- CHG-047 sign-in, remember-me and `/logout` everywhere; CHG-048 text-only rendering; CHG-049 `/api/member/me` and its CORS (same status, headers and body as base for signed-in, signed-out, stale-cookie, foreign-origin and preflight cases).
- `public/index.html`, `public/world/index.html`, `lib/last5.js`, `lib/memberToken.js`, `.env.example`, `package.json`. No new dependencies and no new env vars.
- Still present: guest one-click join, `io.of('/nest')`, the `/nest` command, `/world`, the presence roster, `/last5.txt`, `?login=1`, the x / Esc login pane. Still absent: `mintNestWorldPass` and any server `world:enter` handler.

## VPS steps (for whoever ships it)

1. In the app dir: `git pull` (no `npm install`, no env changes).
2. `pm2 restart "Eagles Nest"`

Rollback: `git revert ce97464`, `git pull`, `pm2 restart "Eagles Nest"`.

## Risks and follow-ups

- The owner email is a hash, not plaintext. Someone who guesses the address can confirm it against the hash.
- The skeleton goes beyond Andy's list (i/l/1/| to l, 0 to o, `rn` to `m`, accents, symbols). Side effect: names one lookalike away from a reserved key ('Adrnin', 'Admln') are also rejected.
- Digits are kept, so 'Neagle2' and 'Andy1' are allowed. Digit-suffix reservation is a possible follow-up.
- Not covered: lookalikes outside the map (e.g. Cherokee), and near-duplicates of real members' names.
- Pre-existing, unchanged: an unconfirmed registration holds its name and email until it is confirmed.
