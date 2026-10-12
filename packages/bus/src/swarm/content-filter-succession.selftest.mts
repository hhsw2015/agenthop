// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/content-filter-succession.selftest.mts
// F57 — content-filter-stuck detection → succession SUGGESTION. Pins the pure core (opt-in flag, consecutive-hit escalation,
// handoff-letter generator, succession-plan composer) + the FC-2 checklist read + the REUSED detection (screenIndicatesContentFilter).
// The hard boundary is asserted structurally: the plan is suggestion TEXT only — it names close/agent-start/inject as steps for the
// coordinator to execute after approval, and the module exports NO spawn/close/inject (R16). The 3 zero-bug fixture classes are
// adapted to F57's shape: it has NO new durable write face (delivery rides the dispatcher's existing notifyCoordinator; the hit
// counter is in-memory), so the classes map to determinism/idempotency, in-memory-counter restart reset, and consecutive-vs-clear.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  contentFilterSuccessionEnabled, nextHitCount, hitSeverity, reviewerIdOf, buildHandoffLetter, buildSuccessionPlan,
  planContentFilterSuccession, CF_SUCCESSION_URGENT_HITS, type RosterLike, type ReviewChecklist,
} from "./content-filter-succession.js";
import { readInReviewChecklist } from "./content-filter-succession-store.js";
import { screenIndicatesContentFilter } from "./sentinel-denoise.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "f57-selftest-"));
const member: RosterLike = { member: "codex:happycapy-01a127b6", tool: "codex", cwd: "/Users/wowdd1/Dev/happycapy", role: "review-seat", title: "happycapy-01a127b6" };
const readCl: ReviewChecklist = { items: ["fleet-recovery-8d091f3-review-01a127b6", "retro-learn-f6a63c2-review-01a127b6"], status: "read" };

try {
  // ── flag (opt-in dormant) ───────────────────────────────────────────────────────────────────────────────────────
  t("enabled: OFF by default (opt-in dormant)", !contentFilterSuccessionEnabled({}) && !contentFilterSuccessionEnabled({ SWARM_CF_SUCCESSION: "0" }) && !contentFilterSuccessionEnabled({ SWARM_CF_SUCCESSION: "off" }));
  t("enabled: ON only for explicit 1|true|yes|on", contentFilterSuccessionEnabled({ SWARM_CF_SUCCESSION: "1" }) && contentFilterSuccessionEnabled({ SWARM_CF_SUCCESSION: "true" }) && contentFilterSuccessionEnabled({ SWARM_CF_SUCCESSION: "on" }));

  // ── detection REUSE: the codex "This content can't be shown" signature already matches the live anchor ────────────
  t("detection: codex 'This content can't be shown' ⇒ content-filter (reused anchor, live)", screenIndicatesContentFilter("… This content can't be shown. Daybreak …"));
  t("detection: typographic apostrophe variant also matches (normalized)", screenIndicatesContentFilter("This content can’t be shown"));
  t("detection: an unrelated screen ⇒ false", !screenIndicatesContentFilter("normal prompt, nothing blocked here"));

  // ── consecutive-hit escalation (③) ──────────────────────────────────────────────────────────────────────────────
  t("nextHitCount: detect increments, clear resets", nextHitCount(0, true) === 1 && nextHitCount(1, true) === 2 && nextHitCount(5, false) === 0 && nextHitCount(-3, true) === 1);
  t("hitSeverity: 0 none, 1 normal, ≥2 urgent", hitSeverity(0) === "none" && hitSeverity(1) === "normal" && hitSeverity(2) === "urgent" && hitSeverity(9) === "urgent");
  t("hitSeverity: urgent threshold constant is 2", CF_SUCCESSION_URGENT_HITS === 2);

  // ── reviewerIdOf (checklist attribution) ────────────────────────────────────────────────────────────────────────
  t("reviewerIdOf: title/member hex suffix extracted", reviewerIdOf(member) === "01a127b6" && reviewerIdOf({ member: "codex:Work-01a1208e", tool: "codex", cwd: "/x" }) === "01a1208e");
  t("reviewerIdOf: no hex suffix ⇒ '' (⇒ absent checklist, never a false attribution)", reviewerIdOf({ member: "plain-name", tool: "claude", cwd: "/x", title: "coordinator" }) === "");

  // ── ④ handoff-letter generator (pure) ───────────────────────────────────────────────────────────────────────────
  t("buildHandoffLetter: lists checklist items + role/cwd + F53 report step", (() => {
    const s = buildHandoffLetter({ member, checklist: readCl, stuckReason: "pane %42", recoveredAtIso: "2026-10-13T00:00:00Z" });
    return s.includes("继任壳") && s.includes("review-seat") && s.includes(member.cwd) && s.includes("fleet-recovery-8d091f3-review-01a127b6") && s.includes("F53") && s.includes("勿重判已签项");
  })());
  t("buildHandoffLetter: FC-2 — unreadable checklist ⇒ 'verify manually', NEVER a false 'nothing to do'", (() => {
    const s = buildHandoffLetter({ member, checklist: { items: [], status: "unreadable" }, stuckReason: "x", recoveredAtIso: "T" });
    return s.includes("不可自动获取") && s.includes("unreadable") && s.includes("手动核对") && !s.includes("无在判项");
  })());
  t("buildHandoffLetter: genuinely empty (read, 0 items) ⇒ '无在判项' (distinct from unreadable)", buildHandoffLetter({ member, checklist: { items: [], status: "read" }, stuckReason: "x", recoveredAtIso: "T" }).includes("无在判项"));

  // ── ② succession-plan composer (suggestion text; readiness-probe injection) ──────────────────────────────────────
  t("buildSuccessionPlan: lists close/agent-start/inject/verify + readiness probe + suggestion-mode + R16", (() => {
    const p = buildSuccessionPlan({ member, paneRef: "%42", agentStartCmd: "codex resume 01a127b6", handoffLetter: "LETTER", severity: "normal", hits: 1, recoveredAtIso: "T" });
    return p.text.includes("关旧 pane %42") && p.text.includes("codex resume 01a127b6") && p.text.includes("就绪探测") && p.text.includes("wait-output") && p.text.includes("建议模式") && p.text.includes("R16") && p.text.includes("LETTER") && p.taskRef === "f57-cf-succession:%42";
  })());
  t("buildSuccessionPlan: urgent ⇒ ⚠URGENT prefix + urgent title", (() => {
    const p = buildSuccessionPlan({ member, paneRef: "%42", agentStartCmd: "c", handoffLetter: "L", severity: "urgent", hits: 2, recoveredAtIso: "T" });
    return p.severity === "urgent" && p.text.startsWith("⚠URGENT") && p.title.includes("URGENT");
  })());

  // ── planContentFilterSuccession (compose) ───────────────────────────────────────────────────────────────────────
  t("plan: hitCount 0 ⇒ null (no hit, nothing delivered)", planContentFilterSuccession({ member, paneRef: "%1", agentStartCmd: "c", checklist: readCl, hitCount: 0, stuckReason: "x", recoveredAtIso: "T" }) === null);
  t("plan: hitCount 1 ⇒ normal suggestion; 2 ⇒ urgent", (() => {
    const n = planContentFilterSuccession({ member, paneRef: "%1", agentStartCmd: "codex resume x", checklist: readCl, hitCount: 1, stuckReason: "x", recoveredAtIso: "T" });
    const u = planContentFilterSuccession({ member, paneRef: "%1", agentStartCmd: "codex resume x", checklist: readCl, hitCount: 2, stuckReason: "x", recoveredAtIso: "T" });
    return n?.severity === "normal" && u?.severity === "urgent" && n.text.includes("codex resume x") && n.text.includes("fleet-recovery-8d091f3-review-01a127b6");
  })());

  // ── STORE: readInReviewChecklist FC-2 three-state ───────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(scratch, "reviews-"));
    mkdirSync(path.join(dir, "fleet-recovery-8d091f3-review-01a127b6"), { recursive: true });
    mkdirSync(path.join(dir, "retro-learn-f6a63c2-review-01a127b6"), { recursive: true });
    mkdirSync(path.join(dir, "other-ticket-review-99999999"), { recursive: true });
    const r = readInReviewChecklist(dir, "01a127b6");
    t("store: readInReviewChecklist reads dirs carrying the reviewer id (not others)", r.status === "read" && r.items.length === 2 && r.items.every((i) => i.includes("01a127b6")));
    t("store: absent dir ⇒ absent", readInReviewChecklist(path.join(scratch, "nope"), "01a127b6").status === "absent");
    t("store: blank reviewerId ⇒ absent (never a false attribution)", readInReviewChecklist(dir, "  ").status === "absent");
    const f = path.join(scratch, "a-file"); writeFileSync(f, "x");
    t("store: unreadable (ENOTDIR) ⇒ unreadable (NOT empty)", readInReviewChecklist(f, "01a127b6").status === "unreadable");
  }

  // ── HARD BOUNDARY: the module exports NO execution face (suggestion only; R16) ───────────────────────────────────
  {
    const mod = await import("./content-filter-succession.js");
    const names = Object.keys(mod);
    const forbidden = names.filter((n) => /spawn|close|inject|kill|launch|exec|despawn/i.test(n));
    t("hardening: content-filter-succession exports NO spawn/close/inject/exec face (suggestion-only, R16)", forbidden.length === 0);
  }

  // ── ZERO-BUG FIXTURES (adapted to F57: no new durable write face) ────────────────────────────────────────────────
  // FIXTURE 1 — restart-reset: the hit counter is in-memory; a dispatcher restart = a fresh counter (0). A stuck pane then
  // re-accrues from 0 (first post-restart detection is NORMAL, not a stale URGENT); urgent still needs 2 consecutive.
  {
    let c = 0; c = nextHitCount(c, true); c = nextHitCount(c, true); // pre-restart: 2 ⇒ urgent
    const preUrgent = hitSeverity(c) === "urgent";
    c = 0; // ← restart: counter reset
    c = nextHitCount(c, true); // first detection after restart
    t("fixture[restart-reset]: fresh counter ⇒ first post-restart hit is NORMAL (no stale urgent)", preUrgent && hitSeverity(c) === "normal");
    c = nextHitCount(c, true);
    t("fixture[restart-reset]: re-accrual to urgent still needs 2 consecutive", hitSeverity(c) === "urgent");
  }
  // FIXTURE 2 — idempotency: identical inputs ⇒ byte-identical suggestion text + stable taskRef ⇒ the dispatcher's notifyCoordinator
  // dedups (same taskRef\0text), so a re-run of the sweep on an unchanged stuck pane does NOT re-spam the coordinator.
  {
    const mk = () => planContentFilterSuccession({ member, paneRef: "%7", agentStartCmd: "codex resume 01a127b6", checklist: readCl, hitCount: 2, stuckReason: "pane %7", recoveredAtIso: "2026-10-13T00:00:00Z" });
    const a = mk(), b = mk();
    t("fixture[idem]: identical inputs ⇒ byte-identical plan text + stable taskRef (⇒ notifyCoordinator dedups)", a !== null && b !== null && a.text === b.text && a.taskRef === b.taskRef);
  }
  // FIXTURE 3 — consecutive-vs-clear: a hit interrupted by a CLEAR resets the counter, so a later single hit is NORMAL (not urgent)
  // — "consecutive" is true consecutiveness, never a stale accumulation across a recovery.
  {
    let c = 0;
    c = nextHitCount(c, true);  // hit
    c = nextHitCount(c, false); // CLEAR ⇒ reset
    c = nextHitCount(c, true);  // hit again (not consecutive with the first)
    t("fixture[consecutive]: a clear between hits resets ⇒ the later lone hit is NORMAL, not URGENT", hitSeverity(c) === "normal");
    c = nextHitCount(c, true);  // now 2 consecutive
    t("fixture[consecutive]: two uninterrupted hits ⇒ URGENT", hitSeverity(c) === "urgent");
  }
  // FIXTURE (real-ish) — a complete stuck scenario yields a plan with ALL four steps + readiness probe + agent-start + the letter.
  {
    const p = planContentFilterSuccession({ member, paneRef: "%42", agentStartCmd: "codex --dangerously-skip-permissions resume 01a127b6", checklist: readCl, hitCount: 2, stuckReason: "pane %42", recoveredAtIso: "2026-10-13T01:00:00Z" });
    const ok = p !== null && ["关旧 pane", "agent start", "就绪探测再注入", "wait-output", "验证", "F53"].every((s) => p.text.includes(s)) && p.text.includes("codex --dangerously-skip-permissions resume 01a127b6") && p.text.includes(member.cwd);
    t("fixture[complete-plan]: urgent stuck ⇒ 4-step plan with readiness probe + agent-start cmd + embedded letter", ok);
  }

  console.log("\nF57 content-filter-succession selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
