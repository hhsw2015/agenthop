# Architecture-integrity review sheet — rehearse-batch-20

- **Branch** `rehearse-batch-20`  **HEAD** `f7546569a61b1898dfdaf679c277acda0a4f4ed2`  **Base** `dec7dba87338518ca0dac57c3af840cfb19e4a60`
- **Reviewer** codex:Work-01a13284 (cross-family, independent)  **Author/tooling** coordinator fe0376cd
- **Spec** `docs/swarm/arch-integrity-review-design.md` (R22) + 32-eval C11

## What this is
A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.

## Diff set
57 commit(s), 41 changed file(s), `dec7dba87338518ca0dac57c3af840cfb19e4a60..f7546569a61b1898dfdaf679c277acda0a4f4ed2`.

```
f754656 build(swarm): regenerate presence artifacts with converged holder-lock (B20-1)
35d5013 Merge branch 'feat/batch20-tg-entry-reconcile' into rehearse-batch-20
62e5c92 fix(swarm): batch-20 reconcile tg-entry driver + selftests to converged lineages
b3611bd fix(swarm): adapt shell-succession to converged holder-lock API (reclaim folded into acquire, batch-20 integration)
d803e6e Merge branch 'feat/f57-content-filter-succession' into rehearse-batch-20
62b207f Merge branch 'feat/dialog-officer-seat' into rehearse-batch-20
67dac9e Merge branch 'feat/dialog-officer-bridge-triage' into rehearse-batch-20
b9d94d8 Merge branch 'feat/tg-bridge-proxy' into rehearse-batch-20
3eec82f Merge branch 'fix/single-flight-tristate' into rehearse-batch-20
e01e363 Merge branch 'feat/egress-ledger' into rehearse-batch-20
ccc0f5c Merge branch 'feat/retro-learn' into rehearse-batch-20
d0e18f3 Merge branch 'fix/succ1-stranded-adopt-lock' into rehearse-batch-20
11bfee2 fix(egress): r6 — EL-3-GATE pins the PRODUCTION call chain (public record path, not just the helper)
292d5c7 fix(egress): r5 — EL-3-GATE, a regression with teeth for the lstat->read TOCTOU window
95c53e0 fix(egress): r4 — EL-3 entry read FIFO-safe + EL-R3-DOC brief narrowing
fd14b16 fix(swarm): F57 r2 — evidence-honest generator (F57-1 identity+uncertainty, F57-2 hint-not-verdict)
09390d8 fix(egress): r3 — EL-R2-1/EL-3 (three-state + FIFO-safe lock read in single-flight)
7148818 feat(tg-bridge): dialog-officer bridge-triage r9 (rebased onto bridge r14)
42a34e6 fix(tg-bridge): r14 — DO-R8-P1-1: the record temp write must be COMPLETE before rename
75aa16b feat(swarm): F57 r1 — content-filter-stuck detection → succession SUGGESTION (pure core + store + selftest)
14c689b docs(swarm): retro-learn RL-R3-N1 nit — drop the stale Markdown-side-car comment above writeRetroReport
5864f10 docs(egress): sync brief §范围/§④ to the EL-4 append-lock change (single-flight, not holder-lock)
6e07083 fix(egress): address codex:Work EL-1/2/3/4 (fail-open never-throws, next-seq-from-max, lstat gate, single-flight lock)
6f7690c test(tg-bridge): r13 — DO-R6-P2-1 cross-process holder-lock concurrency regression gate
4e2f6ee fix(tg-bridge): r13 — TGP-10 layer 2: the record temp is O_EXCL, not plain "w"
7d259cf fix: dialog-officer ② r6 — forced-collision fixture with teeth + comment (happycapy DOS-CORE-P2-1/N1)
7d2783d feat(swarm): egress-ledger v1 — record-only hash-chained outbound-call accountability (gstack borrow ②)
8f7cf62 fix(swarm): retro-learn r4 — whole-dir-unreadable obligation, SHA version tag, synced comments
6f56c9f fix(swarm): single-flight DISP3-1 — atomic (link) restore, never clobber a racer's published lock
51a9fde fix(tg-bridge): r12 — shared tg-queue/holder-lock concurrency pass (TGP-10 + TGP-11)
81f8894 fix: dialog-officer ② r5 — exclusive temp creation (O_EXCL) closes DOS-CORE-P1-1
8a17975 fix(swarm): single-flight three-state lock-readability root fix (DISP-3)
f6a63c2 fix(swarm): retro-learn r3 — batch-scope honesty, incomplete-scan obligation, version-bound delivery, full arg validation
b0087ab fix(tg-bridge): r9–r11 — proven-primitive concurrency/durability pass (TGP-10/11/14/15, FC-7, DO-R4, audit)
0319115 fix: dialog-officer ② r4 — fixture lifecycle owns detached-child cleanup (happycapy DOS-R3-P2-1)
cd3deff fix(swarm): retro-learn r2 — window all axes, obligation water-mark, single JSON, real-process fixtures
95e8862 fix(swarm): SUCC-1 r5 — codex:Work r4 (SUCC1-3: recover a dead multi-token residue instead of permanent un-adoptability)
77c117f fix(swarm): SUCC-1 r4 — codex:Work r3 (sole-occupancy publish closes the mkdir->publish window; no generation sample)
0abb460 fix(tg-bridge): r8 — atomic identity cred, drain lock, 3-state prune, strict allowlist, honest contract + send audit
9873a25 fix: dialog-officer ② r3 — ENOENT-only mode default + crash fixtures with teeth (happycapy DOS-P2-2/P2-3)
4b5e188 docs(swarm): egress-ledger brief — pre-declare fail-open posture (gstack GSE-P2-5)
c5fe8e8 fix(swarm): SUCC-1 r3 — codex:Work r2 (generation-CAS reclaim closes the probe-then-adopt TOCTOU double-hold)
5e7a97f feat(swarm): retro-learn code — read-only retro+learn command ring (brief FROZEN @2b46959)
ded304b docs(tg-bridge): the two-sink delivery contract (coordinator ruling, r7 doc surface)
1140033 fix(tg-bridge): r7 — queue payload-binding + lifecycle hardening + allowlist read-error (DO-P1-2/P2-1/P2-3, DO-R2-P1-1)
2b46959 docs(swarm): retro-learn brief (design-first) — read-only retro+learn command ring over the record surfaces
8c57a6a fix: dialog-officer ② r2 — handle resolution + restrictive atomic write + real-process fixtures
757ea9b fix(tg-bridge): r6 — event-identity-in-commit recovery (TGP-4), claim-time (TGP-8), honest DONE (TGP-9)
03b9194 docs(swarm): egress-ledger v1 brief draft (frozen spec, pre-P1-clear)
8b8b5f6 fix(swarm): SUCC-1 r2 — reclaim a stranded adopt lock INSIDE acquireHolderLock (no ABA, single-winner) (codex:Work)
a524fbf fix(tg-bridge): r5 — event-bound receipt obligation + authoritative consumed source (TGP-4, TGP-7)
c1530fd feat(dialog-officer): piece ② seat establishment — roster role source + project + handle (additive)
2b26361 fix(swarm): SUCC-1 — reap a crash-stranded adopt lock so a sid is never un-adoptable forever (P2, infra audit)
415a97d fix(tg-bridge): ledger-derived receipt obligation + three-class fixtures (TGP-4, TGP-7)
26bf055 fix(tg-bridge): redact proxy creds, confirmed-publish offset, lossless event key, recorded-only receipt (TGP-1/3/4)
a1eb53d fix(tg-bridge): proxy lifecycle, durable+idempotent forward, enforced-scope receipt, inbox-wake, non-blocking ack (TGP-1..6)
f085e58 feat(tg-bridge): proxy support + inbound immediacy (receipt-wake, TG ack) + 25s long-poll
```

## Contract surface (hashed — compare against the prior verdict to see drift)
| path | category | sha256 |
| --- | --- | --- |
| `docs/swarm/cluster-liveness-design.md` | spec-doc | `74c9f776cf4a0615…` |
| `docs/swarm/projection-schema.md` | spec-doc | `4fa065224caf51be…` |
| `docs/swarm/team-collab-design.md` | spec-doc | `cb7cb40a481eae17…` |
| `packages/bus/src/inbox.ts` | shared-type | `b20188312febf69a…` |
| `packages/bus/src/swarm/task-plan.ts` | shared-type | `7624dfb8346bcaf5…` |
| `packages/bus/src/swarm/control-log.ts` | shared-type | `e397d051f06f968d…` |
| `CLAUDE.md` | invariant-doc | `3d255bb7724bb892…` |

## Import map (who-imports-whom, batch files only)
| from | zone | to | zone |
| --- | --- | --- | --- |
| `packages/bus/src/swarm/content-filter-succession-store.ts` | bus | `packages/bus/src/swarm/content-filter-succession.ts` | bus |
| `packages/bus/src/swarm/content-filter-succession.selftest.mts` | test | `packages/bus/src/swarm/content-filter-succession.ts` | bus |
| `packages/bus/src/swarm/content-filter-succession.selftest.mts` | test | `packages/bus/src/swarm/content-filter-succession-store.ts` | bus |
| `packages/bus/src/swarm/content-filter-succession.selftest.mts` | test | `packages/bus/src/swarm/content-filter-succession.ts` | bus |
| `packages/bus/src/swarm/decision-batch-store.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/egress-ledger-store.ts` | bus | `packages/bus/src/swarm/single-flight.ts` | bus |
| `packages/bus/src/swarm/egress-ledger-store.ts` | bus | `packages/bus/src/swarm/egress-ledger.ts` | bus |
| `packages/bus/src/swarm/egress-ledger.selftest.mts` | test | `packages/bus/src/swarm/egress-ledger.ts` | bus |
| `packages/bus/src/swarm/egress-ledger.selftest.mts` | test | `packages/bus/src/swarm/egress-ledger-store.ts` | bus |
| `packages/bus/src/swarm/resume.selftest.mts` | test | `packages/bus/src/swarm/resume.ts` | bus |
| `packages/bus/src/swarm/retro-store.ts` | bus | `packages/bus/src/swarm/retro.ts` | bus |
| `packages/bus/src/swarm/retro.selftest.mts` | test | `packages/bus/src/swarm/retro.ts` | bus |
| `packages/bus/src/swarm/retro.selftest.mts` | test | `packages/bus/src/swarm/retro-store.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/shell-succession.selftest.mts` | test | `packages/bus/src/swarm/resume.ts` | bus |
| `packages/bus/src/swarm/shell-succession.ts` | bus | `packages/bus/src/swarm/resume.ts` | bus |
| `packages/bus/src/swarm/shell-succession.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `packages/bus/src/swarm/tg-entry.selftest.mts` | test | `packages/bus/src/swarm/tg-entry.ts` | bus |
| `packages/bus/src/swarm/tg-queue.ts` | bus | `packages/bus/src/swarm/holder-lock.ts` | bus |
| `scripts/egress.selftest.mts` | test | `scripts/egress.ts` | script |
| `scripts/egress.selftest.mts` | test | `packages/bus/src/swarm/egress-ledger.ts` | bus |
| `scripts/egress.ts` | script | `packages/bus/src/swarm/egress-ledger-store.ts` | bus |
| `scripts/egress.ts` | script | `packages/bus/src/swarm/egress-ledger.ts` | bus |
| `scripts/retro.ts` | script | `packages/bus/src/swarm/retro.ts` | bus |
| `scripts/retro.ts` | script | `packages/bus/src/swarm/retro-store.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/single-flight.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `scripts/swarm-dispatch.ts` | script | `packages/bus/src/swarm/shell-succession.ts` | bus |
| `scripts/swarm-resume.ts` | script | `packages/bus/src/swarm/resume.ts` | bus |
| `scripts/swarm-tg-entry.selftest.mts` | test | `scripts/swarm-tg-entry.ts` | script |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/tg-entry.ts` | bus |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/decision-batch-store.ts` | bus |
| `scripts/swarm-tg-entry.ts` | script | `packages/bus/src/swarm/tg-queue.ts` | bus |

### Candidate boundary flags (reviewer confirms — evidence, not findings)
_(none auto-detected; the reviewer still judges the axes below)_

## C11 — done bound to SHA evidence
| node | ok | reason |
| --- | --- | --- |
| SUCC-1 | yes | bound to 95e8862d7a1dcb9f3539a918f9efbc9e418b3d04 |
| retro-learn | yes | bound to 14c689b7bf4a0792dcbc5cb80588d4290fef407a |
| egress-ledger | yes | bound to 11bfee265dab4c69aa2026714ac47d4f8df43544 |
| DISP-3 | yes | bound to 6f56c9f004dbd5055859ddcd4d6f8b7fc2393356 |
| TG-bridge-r14 | yes | bound to 42a34e69e494fe7016073a02f2ed03fb8fb62b01 |
| item1-r9 | yes | bound to 7148818cabdb0843fbd3e6ec6636bf2559d0405b |
| item2-r6 | yes | bound to 7d259cf44e621b29ae5b2f838347a45dd957dddf |
| F57-r2 | yes | bound to fd14b16ed4f4fc0f333f1bb0a71ee96256e82edd |
| tg-entry-reconcile | yes | bound to 62e5c9279b9a178ec19fe911f82d154a5a239d39 |
| B20-1-artifacts | yes | bound to f7546569a61b1898dfdaf679c277acda0a4f4ed2 |

## Axis verdicts (reviewer fills; REMAIN blocks the batch)
### Module boundary drift
- _Probe:_ IO in a pure module; a script reaching into bus internals; a pure->IO import
- **Verdict:** PASS — 四个纯核与完整运行时依赖闭包的前轮判定沿用；766 个非产物 blob 未变。新生成物等于已验证的最终源码标准构建结果。

### Duplicate implementation
- _Probe:_ one concern solved twice (two board parsers; two liveness paths) — name convergence candidates
- **Verdict:** PASS — single-flight 取 egress 超集，holder 取已签 r12；无新增第三权威。两锁及审计面收敛观察保持，不计 REMAIN。

### Contract conflict
- _Probe:_ two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)
- **Verdict:** PASS — B20-1 CLOSED：raw=embedded=前轮已验证标准构建期望字节，提交安装输入含已签 holder 恢复。七个指定共享契约面保持。

### Dependency direction
- _Probe:_ import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant
- **Verdict:** PASS — 全树生产图 245 节点/438 边、较 base 新增 21 边；0 环/0 bus→scripts/0 未解析本地运行时边。手写模块不变，沿用前轮封存全图；34 条 pack 边仅为批内视图。

### Gate / invariant consistency
- _Probe:_ each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments
- **Verdict:** PASS — B20-1 CLOSED：实际 writePresenceBundle 私有写出精确新 payload，复写幂等且无 .new。F57/egress dormant、TG opt-in、unknown/HOLD、b361 持锁与 finally 边界保持。未扩签到 live 接线。

### Done bound to SHA evidence (32-eval C11)
- _Probe:_ every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN
- **Verdict:** PASS — 57 提交/41 文件；原九项固定 SHA 及签收范围、祖先关系沿用，新增产物修复绑定 f754656。原 39 项来源核验保持，两份生成物本轮验证。10 项 done 证 SHA 绑定；happycapy 已明确签收本固定 SHA 的整批六轴。

## REMAIN (open, blocking)
None. **0 P1 / 0 P2 / 0 P3; 0 CONFIRMED / 0 REMAIN; 0 nit. B20-1 CLOSED.**

**DUAL-VOICE-CLEARED** for fixed `f7546569a61b1898dfdaf679c277acda0a4f4ed2`. Primary codex:Work-01a13284 and independent peer codex:happycapy-01a13274 agree on all six whole-batch axes: 0 objections / 0 reopened. B20-1 CLOSED. Existing per-item votes are preserved. Coordinator and user merge gates remain; no merge/install/enable executed.

Dual-signoff addendum: `/Users/wowdd1/Work/review-reports/batch20-dual-signoff-f754656-01a13284.md`. Peer report SHA256: `2a982e4a087a68e22bbb3eed63f9aab8f8a1b280a096eff59a14448d3f2fc957`. Peer manifest: 1584 entries verified. Original primary PENDING-PEER report remains sealed as historical evidence.

Report: `/Users/wowdd1/Work/review-reports/batch20-artifact-review-f754656-01a13284.md`. Core evidence: `/Users/wowdd1/Work/review-reports/batch20-f754656-review-01a13284`. Prior fixed `35d5013` report remains sealed with its historical 1 REMAIN.

Current checks: bus/scripts/CLI tsc 0, private actual writePresenceBundle 0. Reuse verified source tests (58 scripts/1601 bus) and 12 artifact controls by exact byte binding; no fresh full suite/build claimed. Process automation remains unverified: only two artifacts changed; PROGRESS #754 proposes eventual scripting.
