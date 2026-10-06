# ③ production acceptance — LIVE read-only capture (2026-10-06)

The first swarm member to naturally restart via the user-fixed launcher is the **coordinator session
(fe0376cd)**. Captured READ-ONLY from the live default-socket herdr — no live session was operated, prompted,
or modified; only `agent list` / `agent explain` reads + one `ps` read.

RAW receipts (stating only what each file literally contains):
- `01-live-agent-list.json` — `type=agent_list`. claude @ `w1:p1`, `agent_status=working`, `state_change_seq=18`,
  `agent_session.value=fe0376cd-f1df-4d46-a15d-b333acba7ee9` (pre-fix this member was always ABSENT from the list).
- `05-live-agent-list-later.json` — `type=agent_list` (a later `agent list`; note: `agent get claude` by name did
  NOT resolve, so the capture fell back to `agent list` — see the by-name limitation note). SAME target
  (session `fe0376cd-…`, pane `w1:p1`), now `agent_status=idle`, `state_change_seq=33`.
- Taken together, 01 and 05 are two raw lists of the SAME target showing **working→idle** and **seq 18→33** =
  real state flow in production (does not rely on any single counter or on the external coordinator file).
- `02-explain-claude-w1p1.txt` — `agent explain w1:p1`: `state=working, rule=osc_title_working, evidence "◐ …"`
  (herdr classifying from the real custom-TUI claude's OSC title).
- `03-process-argv0-claude.txt` — a process whose command line begins `claude …` (argv0=claude, the fix live).
  This single `ps` line has no PID↔pane/session field; it shows a claude-argv0 process exists, it is NOT by itself
  the pane binding (the binding is the session/pane in 01/05).
- `04-state-flow-poll.txt` — six reads all `working`; shows a sustained working window, NOT a switch. The switch is
  evidenced by 01 vs 05, not by this file.

Layers of support for the argv0 mechanism, each by its own source (listing alone does NOT prove exact argv0 —
herdr also accepts `claude-code`): (a) macOS KERN_PROCARGS2/basename probe (isolated), (b) launcher static fix,
(c) the live `ps` (03).

Scope / handed to the ③ follow-up (owner 90b58f9c, acceptance fe0376cd): `wait --until` and a `blocked` observation
are NOT verified here. The external `live-acceptance-fe0376cd.md` (coordinator's own checkout) is a supplementary
source; the independent basis for the working/idle difference is 01/05 in this package.
