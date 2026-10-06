# ③ production acceptance — LIVE read-only capture (2026-10-06)

The first swarm member to naturally restart via the user-fixed launcher is the **coordinator session
(fe0376cd)**. Captured here READ-ONLY from the live default-socket herdr — no live session was operated,
prompted, or modified; only `agent list` / `agent explain` / `agent get` reads + a `ps` read.

RAW receipts in this dir:
- `01-live-agent-list.json` — herdr lists `claude` (w1:p1) `agent_status=working` (pre-fix this member was
  always absent from the list).
- `02-explain-claude-w1p1.txt` — `agent explain w1:p1`: `agent: claude, state: working,
  rule: osc_title_working, evidence "◐ Happycapy Codex review"` — herdr is classifying state from the real
  custom-TUI claude's OSC title.
- `03-process-argv0-claude.txt` — the bound process: `claude --model fable[1m] … --resume` with
  **argv0 = `claude`** (the `exec -a claude` fix live; other not-yet-restarted members still show
  `2.1.283.pristine`).
- `04-state-flow-poll.txt` / `05-agent-get-claude.json` — status + `state_change_seq` (accumulated
  transitions) read live; corroborates flow. The coordinator's own file
  (`live-acceptance-fe0376cd.md`, their checkout) records the working/idle/working samples +
  `state_change_seq=18` for the same member.

This is the coordinator's named production acceptance for ③ (end-to-end: identify → list → state flow),
on the real member via the fixed launcher. Not a note — raw live receipts.
