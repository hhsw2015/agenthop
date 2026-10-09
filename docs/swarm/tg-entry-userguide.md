# Telegram bridge — user bring-up guide (TG user-entry v1)

A one-page guide to turn on the Telegram bridge so the swarm's decision approvals reach your phone and your taps come back as verdicts. The bridge is a **user entry** peer to the console: it only NOTIFIES you and COLLECTS your approvals — in v1 it **never executes anything** (a tap is only written to the decision ledger; the coordinator re-injects it). It is **dormant by default** and does nothing until you complete the steps below.

All commands run from the **agenthop repo root** (the `feat/tg-bridge` worktree). `tsx` ships as a dev dependency — use `npx tsx …` (or `node --import tsx …`) if `tsx` is not on your PATH.

---

## 1. Create the bot (BotFather — one time)

1. In Telegram, open **@BotFather** → send `/newbot` → pick a name and a username → BotFather replies with a **token** like `123456789:AAE...` (keep it secret).
2. Seed the token into a `0600` file (it travels on **stdin**, never the command line, so it can't leak to `ps` or child processes):
   ```sh
   printf %s '123456789:AAE_your_token_here' | npx tsx scripts/swarm-tg-entry.ts --seed-token
   ```
   This writes `~/.agenthop/tg/bot.token` (mode 0600) and prints the next step.
3. Open a chat with your new bot in Telegram and **send it any message** (e.g. `hi`). This lets the bridge learn your numeric `chat_id` (step 2 below prints it). Then create the allowlist `~/.agenthop/tg/allow.json` — **only the chat_ids listed here are ever read**:
   ```sh
   mkdir -p ~/.agenthop/tg
   printf %s '[123456789]' > ~/.agenthop/tg/allow.json   # your numeric chat_id
   chmod 600 ~/.agenthop/tg/allow.json
   ```
   (Either form works: `[123456789]` or `{"chatIds":[123456789]}`. Multiple ids are allowed.)
4. Turn the bridge on (next section). Done — the token + allowlist seeding is the only manual step; the bridge never creates the bot for you.

---

## 2. Start the bridge + verify

Start it (the `SWARM_TG_ENTRY=1` gate is required — without it the process prints `dormant` and exits):
```sh
SWARM_TG_ENTRY=1 npx tsx scripts/swarm-tg-entry.ts
```
On success it logs:
```
swarm-tg-entry: up (notify + collect-approvals; never executes).
```

**Verify inbound (your account is wired):** from Telegram, message the bot. If your id is not yet allowlisted, the bridge logs:
```
swarm-tg-entry: message from un-allowlisted chat_id 123456789 — add it to ~/.agenthop/tg/allow.json to enable
```
Copy that number into `allow.json` — the bridge re-reads the allowlist every loop, so **no restart is needed**.

**Verify outbound (send yourself a test notification):** with the bridge running, create a one-off test decision batch — the bridge delivers it to your chat within a second:
```sh
npx tsx -e 'import("./packages/bus/src/swarm/decision-batch-store.js").then(m => m.openBatch(require("os").homedir(), { batchId: "tg-selftest", owner: "you", items: [{ id: "t1", kind: "test", summary: "TG self-check — tap approve to confirm", suggestedAction: "approve" }], nowSec: Math.floor(Date.now()/1000) }))'
```
You should receive a message with **approve / decline / defer** buttons. Tapping writes the verdict (consume-once). `tg-selftest` is a throwaway batch — it is harmless to leave; the coordinator ignores unknown test batches.

To run it as a long-lived background service, start it under your process manager of choice (launchd / systemd / `nohup`), passing `SWARM_TG_ENTRY=1`.

---

## 3. What you'll see in Telegram

- **Decision approval (live in v1).** One message per pending item:
  ```
  pay $40 invoice
  suggested: approve
  ref: invoice://4021
  ```
  with an inline keyboard. Row 1 is the approve options, one per allowed scope — **approve (once)**, **approve (this chat)**, **approve (always)**. A **hard-gate** item (spend / publish / irreversible) is prefixed with `⚠` and shows **only approve (once)** — it can never be granted `this chat` or `always`. Row 2 is **decline** and **defer**. First tap wins; a second tap (or a console verdict on the same item) is a no-op — no double-decide, no fork.
- **Morning digest (v1.1).** A plain message `morning brief — 2026-10-09` with sections that lead with **needs you** (alerts), then **cleared**, **shipped**, **still pending** — or `(quiet night — nothing to report)`.
- **Bandwidth gauge card (v1.1).** A line like `bandwidth RED — produce 9/h, consume 1/h, backlog 30`; a RED zone is pinned to the chat.

> v1 delivers the **decision approvals** end to end. The morning digest and the bandwidth gauge card are implemented in the shared core and rendered, but their scheduled push through the driver is a **v1.1** follow-up — you will not see them until v1.1 wires the outbound schedule.

---

## 4. Troubleshooting

1. **Wrong / revoked token.** The loop logs repeat, e.g. `swarm-tg-entry loop error (continuing): Unauthorized` (HTTP 401 from Telegram) and no messages arrive. Re-seed the correct token from BotFather: `printf %s '<token>' | npx tsx scripts/swarm-tg-entry.ts --seed-token`, then restart the bridge.
2. **Your chat_id isn't allowlisted.** You message the bot but no approvals ever arrive, and the log shows `message from un-allowlisted chat_id <N> …`. Add `<N>` to `~/.agenthop/tg/allow.json` (0600). No restart needed — the allowlist is re-read each loop. (A non-allowlisted chat is dropped before anything is read; Telegram text is untrusted.)
3. **The bridge process died.** No notifications and no new log lines. Check it's still running and restart with `SWARM_TG_ENTRY=1 npx tsx scripts/swarm-tg-entry.ts`. The poll offset is persisted (`~/.agenthop/tg/offset`), so a restart resumes where it left off; a replayed update is de-duplicated by the consume-once ledger, so you can't double-decide across a restart.

---

## Safety notes

- **Dormant by default:** nothing runs until `SWARM_TG_ENTRY=1` is set and the token + allowlist are seeded.
- **Never executes:** v1 only writes your verdict to the decision ledger; the coordinator's chain re-injects it. The bridge has no command path.
- **Credentials:** the token lives only in `~/.agenthop/tg/bot.token` (0600), seeded via stdin — never on the command line or in a persistent env var.
- **Allowlist-gated:** every inbound message is checked against `~/.agenthop/tg/allow.json` before anything is read.
