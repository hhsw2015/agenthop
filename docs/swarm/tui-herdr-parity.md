# TUI seats vs herdr: parity table (2026-10-16)

**Live today: 0 of these Tern-side pieces is in effect.** The installed program is `agenthop v0.6.1-bus.10` and the installed
bridge plugin is the 2026-10-15 copy. On main, only T1b (screen state, a21f9a5) has merged. It is not installed:
`~/.agenthop/tern-panes/screens/` does not exist yet. Everything below is live only after
the bus.11 install (`docs/swarm/bus11-install-runbook.md`). That install has two parts: the new binary and every seat's MCP
restarted, and `tern-install.sh --live` (plugin install + reload) for the bridge. Pieces still in review start working
only after they merge and are installed again.

Short answer to "can the swarm run on Tern TUI as it did on herdr": **not yet**. It can for messaging and durable delivery,
because those never depended on the shell. Seeing and driving seats the herdr way is about half built. Today it runs by hand
with `tern send` / `tern capture`.

Upstream reference: herdr `~/Dev/vendor/herdr-upstream` @ 143bf5f (v0.9.5, Apache-2.0). Spec for the port:
`tern/agenthop-agents-bridge/UPSTREAM-DETECTION.md`.

Status words: **main** = merged; **review** = branch at a fixed SHA, with the review seats; **none** = no work exists.
"Live gate" = what must happen before the piece runs on this machine.

| herdr capability | Tern side (piece, SHA, status) | Live gate | Remaining gap |
|---|---|---|---|
| Agent state per pane: idle / working / blocked (screen read + manifests) | Classifier `classify.luau`: 17 manifests on main (#1041). T1a r8 brings the 22 upstream manifests, engine v3 and the codex "esc to interrupt" working rule (`feat/tui-classify-r6` a9e876e, **review**). Screen state machine + per-VM `screens/*.json` + bounded reader: T1b, **main** a21f9a5. | bus.11 install step 6 (plugin install + reload); again after T1a merges | Until T1a, codex `working` is not detected (spike: 0/56), so a codex screen that shows idle can be working. One pane is read per sweep round (5 s): with 8 seats, each is sampled about every 40 s. herdr reads each pane every 300 ms. Exited panes keep an old state until it ages out. |
| `agent list` | `agenthop_tui list` (blocks + screen state): T2, `feat/tui-seat-ops` 9a47e25, **review** | merge + bus.11-style rebuild + MCP restart | Only TUI agent blocks are listed. ACP blocks still go through `agenthop_tern list`. |
| `agent prompt` (paste → 300 ms → Enter, refuse when blocked) | `agenthop_tui ask`: refuses blocked / unknown screens; baseline capture; delivered only when the screen shows this prompt; at most one more Enter; one ask per block (lock). T2, **review** | as above | No bracketed-paste check (herdr checks whether the pane has paste mode on). Proof of delivery reads the screen only, not the transcript. |
| `agent wait --until …` | `agenthop_tui wait`: one monotonic deadline, unknown only when asked. T2, **review** | as above | herdr waits on events (about 100 ms). The Tern port polls the screens file (1 s), and each pane is sampled only once per round. |
| `agent read` / `pane read` | `agenthop_tui transcript` (the seat's own jsonl, last 512 KiB) T2 **review**; raw screen = `tern capture` (Tern CLI, live today) | as above | No `read` tool over the screen with scrollback options. The classifier's region rules are not exposed. |
| `agent explain` (why this state) | `screen` entry carries the matching `rule` (T1b, main) | bus.11 install step 6 | No explain command. A reader sees the rule id only, not the matched text. |
| `send-keys` | `tern send <block> keys …` (Tern CLI, live today). Swarm policy unchanged: report approvals, never answer them (R16). | none needed | No MCP tool for it, on purpose. Answering dialogs stays manual. |
| `agent start` / `pane split` | `agenthop_tui start` (`tern new tab` / `split … right`, highest permission by default, `--session-id` / `--resume`) T2 **review**. Seat restore with roster v2 + TUI path: T3 `feat/tui-t3` b152bfc (Infra Dev), **review** | merge + rebuild + MCP restart | No layout presets (herdr `layouts`). No workspace / worktree commands. |
| Session restore after restart | herdr restores the layout and resumes agents. Tern: the daemon keeps panes alive across window restarts. Re-launch after a machine restart = `tern-restore.py` with roster v2 (T3, **review**). Same-sid resume runbook: `tui-seat-switch-runbook.md` (**main**, used for Reserve and Platform Dev) | T3 merge | Not automatic after a reboot: someone runs restore. The presence race (SessionEnd deletes the new `.pid`) is handled by a wait in the runbook. The fix in the helper is T3. |
| Wake an idle seat that has mail | inbox-wake Tern path: only `tern acp` blocks were found, so **bare TUI seats were never woken**. Fix: T3 wake gate, `feat/tui-wake-screen` 34a6450, **review** (TUI blocks found, gated on screen state; blocked ⇒ S19). | merge + rebuild + MCP and dispatcher restart; screen state must be installed | Until then TUI seats wake only from their own inbox poll or a manual `tern send`. Codex seats on the default launch are woken through the codex daemon (A r11 probe). |
| codex seat identity on the bus | A r11 `fix/codex-main-thread-identity` fbf9c35, **review**: default codex TUI = daemon listener path; `--no-daemon` = hosted rule | merge + rebuild + codex MCP restart (runs under the app-server daemon) | The review seats are still ACP. They switch only after A r11 merges. |
| Remote machines in one window | Tern has `tern remote serve/setup/trust` (Tern feature). Swarm: `remote-herdr-view`, vm-ctl and remote-bootstrap are all built for **herdr** on the remote side | none for Tern itself | **None** for TUI seats. No remote screens, no remote wake, no combined list across machines for Tern blocks. Brief gate ③ (multi-machine) was never tested on Tern. |
| Notifications ("needs an answer") | A3 OSC 9;4 alert hook (`osc-alert-hook.sh`, main 613e691) feeds Tern's own attention signal. A blocked seat with mail ⇒ S19 card (T3 wake gate, review) | hook install per machine; wake gate merge | No equivalent of herdr's per-state sound / suppressed-in-active-tab rules. No push to the user's phone (TG) from screen state. |
| One screen, many agents (sidebar with state per pane) | Tern shows blocks and titles. Claude titles carry a spinner glyph while working. Swarm board: `tern/board` md (main). | none | No per-block state badge in Tern's UI from the classifier. The state lives in `screens/*.json` and in `agenthop_tui list`, not in the window. |
| Plugins / marketplace | Tern has its own plugin system. The bridge is one plugin. | n/a | Not a parity goal. |

## What has to happen for "the herdr effect", in order

1. bus.11 install (runbook, today): binary + MCP restarts + bridge plugin with T1b ⇒ screen state is written.
2. Merge T2 (seat ops), T3 wake gate, A r11, T1a. Rebuild, then re-run runbook steps 3-6 ⇒ list / ask / wait / start /
   transcript tools, TUI wake, codex working detection.
3. T3 (roster v2 + restore + presence fix) ⇒ seats come back after a reboot without hand work.
4. Switch the remaining seats (Infra Dev, Model Gateway, review seats after A r11, coordinator last).
5. Gaps with no work yet: remote Tern seats (multi-machine), a state badge in the Tern window, faster sampling. These need a
   decision first. They are not in any current ticket.

Not claimed here: no 12 h soak has run on any TUI piece. The screen state is advisory: a safety decision never reads the screen
alone (brief §5).
