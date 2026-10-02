# CHG-053: publish the offline chatroom script and README section

Nest/Milliway repo, docs and tools only (repo Cremea06/eagles-nest-chat). No server change. Shop untouched.
On main as `0d8b717` ("CHG-053 offline-chatroom"), 2026-09-30. CHANGES.md was not updated in that commit; this write-up is added afterwards.

## Base

- Repo: https://github.com/Cremea06/eagles-nest-chat, branch `main`
- Base SHA: `ce974649a48b7c0ab20fe8883bd933bc5b3697b8` ("CHG-051 name rules").
- Commit: `0d8b7171b2a372e4855b8d3f55b606af0b2d60c6`.

## What changed

| File | Change | +/- |
|---|---|---|
| `tools/offline-chatroom.ps1` (new) | Andy's laptop script (from CHG-044), published as is behind a 7-line header: what it does, that it is read-only toward the server, and `License: MIT (see LICENSE in https://github.com/Cremea06/eagles-nest-chat)`. Nothing personal was found in the source, so nothing was removed. | +112 / -0 |
| `README.md` | New section "Offline chatroom (Windows PowerShell)", appended after "last5.txt (public room tail)". | +51 / -0 |

**Script behaviour** (unchanged from the laptop copy)
- A local scratch chat in the console. Prompt `you:`; commands are case-insensitive and empty lines are ignored.
- Any other line prints as `[local] ...` and is appended to `offline-chatroom.log` next to the script (or the current folder if pasted into a console), one line per entry: `yyyy-MM-dd HH:mm:ss [local] text`.
- `/sync`: one HTTPS GET of the public `https://chat.afirstflag.com/last5.txt` (5 s timeout), printed as is. `no remote file yet` for an empty tail or 404, `offline` when there is no HTTP response, `offline (HTTP <code>)` for any other status.
- `/quit` (or EOF) exits.
- Sends nothing to the server: no POST/PUT, no body, no query string, no login. The URL is fixed.
- Works on Windows PowerShell 5.1 and PowerShell 7 (adds TLS 1.2 on older .NET).

**README section covers**: what it is; requirements; download via the raw GitHub link or an `Invoke-WebRequest -OutFile` one-liner; running it (`Unblock-File`, and `-ExecutionPolicy Bypass` for that run only, `pwsh` on 7); the commands and `/sync` messages; where the log is; privacy (local lines stay on the PC, `/sync` only reads the public tail, which empties when the server restarts).

## What did not change

- `server.js`, `public/`, `lib/`, `package.json`, `package-lock.json`, `.env.example`, `LICENSE`, `CONTRIBUTING.md`, `VALIDATE.md`. No server behaviour change, no env change.
- The rest of `README.md` (lines 1 to 32) is byte-identical; the section is appended.

## VPS steps

None required (docs and tools only). `git pull` on the VPS is harmless; no restart needed. The raw download link works now that the file is on main.

## Checks (done 2026-09-30, before commit)

- PowerShell 7.6.6 parse (`[System.Management.Automation.Language.Parser]::ParseFile`): 0 errors.
- Smoke test under pwsh 7.6.6: `/sync` printed the live last5.txt (matching curl); a local line printed `[local] ...` and was appended to the log; empty line ignored; `/SYNC` worked; `/quit` and EOF exited 0; with an unreachable proxy `/sync` printed `offline`.

## Notes

- Line endings: the prepared copy was CRLF, but the committed file is stored with LF (`git ls-files --eol`: `i/lf w/lf`). Content is otherwise identical. Both Windows PowerShell 5.1 and pwsh 7 run LF scripts; no action needed unless CRLF is wanted, in which case add a `.gitattributes` rule (`*.ps1 text eol=crlf`).
- `last5.txt` empties on every server restart, so `/sync` right after a restart shows `no remote file yet`.
