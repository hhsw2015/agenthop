# ③ rollout roster — claude members lit in herdr (read-only tracking ledger)

③ **core is CLOSED** (coordinator ruling): identify → `agent list` → state-flow is proven end-to-end on a real
member (the coordinator session; see `LIVE-acceptance/`). This file just tracks member convergence as each claude
session naturally restarts via the fixed launcher (`exec -a claude` + pure-version `find_real_binary`). No isolated
repro, no paid tests, no message spam — a one-line ledger updated on read-only `agent list` / `ps` checks.

**Closure of the ③ follow-up:** whichever comes first —
- all claude members naturally lit (restarted into herdr identification), OR
- the sentinel-wiring ticket (under `d7f6c917`, post board-admission) starts — its acceptance naturally exercises
  `wait --until blocked` in a real scenario, verifying the last unverified bits (`wait` / `blocked`) there.

`wait --until` and `blocked` are intentionally NOT verified via a synthetic isolated test; they ride the real
sentinel-wiring acceptance.

## Roster (updated 2026-10-06, read-only)

| member (session) | state | evidence |
|---|---|---|
| `fe0376cd` (coordinator) | **LIT** | w1:p1, argv0=claude (pid 6306), herdr `agent list` claude idle/working, seq flowing → `LIVE-acceptance/` |
| `90b58f9c` (this session) | pending restart | pid 28124 still `…/versions/2.1.283.pristine` |
| `f32a0507` | pending restart | pid 28759 version-named |
| `3e097dfe` (OpenDots) | pending restart | pid 29109 version-named |
| `d7f6c917` (Work) | pending restart | pid 29764 version-named |
| other claude procs (no swarm resume id: pids 92316, 72094) | n/a / pending | version-named; not tracked as swarm members |

Lit: **1** · pending natural restart: 4 tracked members (+ untracked). Mechanism proven; convergence is automatic as
each restarts. Update this table on the next read-only check; close per the criteria above.
