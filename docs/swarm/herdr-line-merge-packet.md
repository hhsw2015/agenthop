# herdr line — merge packet (S14, author 90b58f9c; prepared 2026-10-06)

Ready for the user's merge gate. Both review phases are signed off at 0 REMAIN. **Nothing here merges or pushes
anything** — this is the decision packet so the merge can happen the moment the gate opens.

## 1. What this is

An **optional `herdr` backend** for spawn/resume, plus the stall-sentinel + approval parts for S24. Dual-backend:
when the dispatcher runs inside a herdr pane and the server is reachable, spawn/resume use herdr (JSON receipts +
lifecycle states); otherwise they fall back to the existing Ghostty/osascript path. **Ghostty is not removed.**

- Branch: `feat/herdr-backend`. **Reviewed/signed code + evidence = `de4812a` (phase-2), `2fec5587` (phase-1).** This
  packet is a docs-only commit added on top of `de4812a` (it changes no code or evidence; the sign-off stands).
- Base (merge-base with `main`): `b5fde6527b29c454665d794883b82ec3c95f5b8c` (current main tip — clean 3-way)
- Worktree: `/Users/wowdd1/Dev/agenthop-wt/herdr-backend` (NOT pushed, NOT merged)
- Diff vs main (through `de4812a`): **19 files, +953 / -4** (this packet adds one docs file on top)

## 2. Two-phase verdicts (authoritative pointers)

| Phase | Scope | Signed SHA | Verdict | Report (path · SHA-256) |
|---|---|---|---|---|
| phase-1 | module/criteria/IO helpers (R11/R12/R13 honest-degradation) | `2fec5587` | 0 P1/0 P2/0 P3, 0 REMAIN | `~/Work/review-reports/herdr-rereview-2fec5587-2026-10-06.md` · `f29cbe133cbccdcdbfd6f34adb16fd3320f5857ef9b2a5aa458df74a205d2b3b` |
| phase-2 | real-machine verification + archive consistency | `de4812a` | 0 P1/0 P2/0 P3, 0 REMAIN | `~/Work/review-reports/herdr-phase2-review-de4812a-2026-10-06.md` · `b6973af0f4fcbd20a106d508b09ad5e6892534b33f9ab8fb78efbb25f037b9d0` |

Reviewer 01a0ff49. phase-1 took 6 adversarial rounds, phase-2 took 3. The through-line of every round: **claim only
what the artifact proves** — optimistic code branches driven to conservative `unknown`; the real-machine completion
read archived rather than cited from memory; conclusions bounded to the measured timeline and the single probe.

## 3. Commits (12, oldest first)

```
9b4e047 feat(herdr): optional herdr backend for spawn/resume + voice-path + stall sentinel (S14)
b2cbe63 fix(herdr): splitCommand strips shell quotes so herdr execFile gets the clean model arg
16bf8c8 test(herdr): update splitCommand expectation to unquoted
d0d886a fix(herdr): clear first-review 8 findings (1 P1 / 7 P2) — rev2
864d745 fix(herdr): rev3 — escalate-only sentinel, real codes, pane bind, 3-state submit, pre-record, jurisdiction despawn
c40137c fix(herdr): settledFrom — `working` is not settle, only proves submission
b6bf97d fix(herdr): rev4 — submit reject whitelist, verified-type settle, honest eval
755ecbd fix(herdr): rev5 — classifySubmit binds the agent_prompted receipt to the target
2fec558 fix(herdr): rev6 — classifySubmit requires POSITIVE target proof   ← phase-1 signed
1753e06 feat(herdr): R13 phase-2 real-machine verification — archive raw receipts + narrow to evidence
e9f777f docs(herdr): phase-2 archive correction — add input-ready->stalled->completed (09-11)
de4812a docs(herdr): phase-2 — limit conclusions to the timeline + evidence   ← phase-2 signed
```

## 4. Files

- `packages/bus/src/swarm/herdr.ts` (+384) — pure core (gates, name sanitation, escape-aware `scanCommand`/`splitCommand`, argv builders, receipt classifiers `classifyStart`/`classifySubmit`/`settledFrom`/`agentPaneId`+`paneBound`, `stripTui`, escalate-only `sentinelDecision`, `buildApprovalDoc`) + IO shell (`herdrServerReachable`/`herdrAgentStates`/`herdrLaunch`/`herdrPaneClose`/`herdrPrompt`/`herdrReadClean`/`herdrSendKeys`).
- `packages/bus/src/swarm/herdr.selftest.mts` (+152) — 83 pure-core selftests.
- `packages/bus/src/spawn.ts` (+56/-…) — herdr branch in `spawnAgent` (gated, pre-records before launch, honest handle update) + jurisdiction-only herdr despawn; `SpawnRecord`/`MainRecord` gain `backend`/`surfaceId`.
- `scripts/swarm-resume.ts` (+19) — dual-backend launch loop (herdr via `splitCommand`+`herdrLaunch`, else `buildAppleScript`).
- `docs/research/herdr-integration-eval.md` (+152) — design, rules, risks, §九–§十二 (review-fix + phase-2 ledger with the honest verification boundary).
- `docs/research/herdr-phase2-evidence/` — 13 raw real-machine receipt files + `SUMMARY.md`.

## 5. Test evidence (verify locally)

```
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # Node 22 for tsx
npx -y tsx packages/bus/src/swarm/herdr.selftest.mts     # 83 ok — all pass
npx -y tsx packages/bus/src/swarm/resume.selftest.mts    # 46 ok — all pass
npx -y -p typescript@5 tsc --noEmit -p packages/bus/tsconfig.json      # bus tsc = 0
npx -y -p typescript@5 tsc --noEmit -p scripts/tsconfig.json          # scripts tsc = 0
```

Reviewer additionally replayed the archived raw receipts (06/10/08 → yes/unknown/no, settled=false) and the existing
32 spawn-registry tests; both pass. No bug-class findings open.

## 6. Outstanding (NOT in this line — each needs its own ticket/review before enabling)

1. **Other agent kinds / conditions + a positive `--wait` settle signal.** Phase-2 verified one codex probe and
   obtained no verifiable `--wait` settle receipt, so `WAIT_SETTLE_TYPES` is empty and `herdrPrompt` does not rely on
   `--wait` (conservative — not a proof that no signal exists anywhere in 0.9.3). Filling `WAIT_SETTLE_TYPES` / re-enabling
   wait-settle needs new real-machine evidence + a fresh review.
2. **Live sentinel sweep wiring** (dispatcher cadence/patrol) — ticket **d7f6c917**. The sentinel *parts* (blocked
   detection → escalate-only decision → approval envelope) ship here; the whole S24 chain is not live yet.
3. **Formal merge / push / install** — a **separate gate (coordinator + user)**. This packet does not merge; timing
   (solo merge vs. batched with board-admission) is the user's call.

## 7. Merge mechanics (when the gate opens)

Branch is based on the current main tip (`b5fde65`), so it's a clean fast-forward-able 3-way merge. Standard flow:
`git checkout main && git merge --no-ff feat/herdr-backend` (or a PR if pushing). No relay/Worker changes, so no
`wrangler deploy`. No `version.ts` bump needed (internal swarm tooling, not a CLI release).
