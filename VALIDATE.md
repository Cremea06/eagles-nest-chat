# CHG-004 Slice 3 — local validate (2026-09-13)

| Case | Result |
|------|--------|
| Bad token → `/nest` ns | PASS — `invalid_token` |
| Expired token | PASS — `invalid_token` |
| Good token after chat `/nest` | PASS — `joined` `{ handle }` |
| Same token reused | PASS — `token_used` |
| `GET /world/` | PASS — door page, no three.js |

Did **not** use `NEST_SIMULATE_FULL`. Did **not** rewrite `/nest` mint / login / auth.
