/**
 * F57 — content-filter-stuck session detection → SUCCESSION SUGGESTION (pure core; user ruling, coordinator-dispatched). When a
 * member's pane shows a platform content-filter block (detected by F44-⑩ screenIndicatesContentFilter, already live in
 * sentinel-denoise.ts), a seat can sit blocked for a long time before anyone notices (tonight's 5th manual-succession case). This
 * proposes a succession PLAN to the coordinator in SUGGESTION MODE and nothing more:
 *   - it NEVER spawns a shell, closes a pane, or injects a handoff — those are the coordinator's one-click action AFTER approval
 *     (R16: a spawn is a neighborhood/spend-adjacent act = a coordinator gate; a peer/automatic trigger would be laundering);
 *   - two CONSECUTIVE hits on the same pane escalate the suggestion to URGENT (③);
 *   - the injection step of the proposed plan CARRIES a readiness probe (read-screen for the input box, or herdr pane
 *     wait-output, before send-text) — an immediate send-text is swallowed by a not-yet-ready TUI (tonight's 5th case; same
 *     "a return value is not evidence" discipline as F53).
 *
 * PURE: no fs, no bus, no clock beyond injected values. The IO (herdr screen read, roster, in-review checklist, delivery) lives
 * in content-filter-succession-store.ts + the dispatcher sweep. Detection itself is REUSED verbatim from sentinel-denoise.ts
 * (screenIndicatesContentFilter); this module adds only the per-pane escalation + the plan/letter composition.
 */

/** ③ — same pane twice ⇒ URGENT. */
export const CF_SUCCESSION_URGENT_HITS = 2 as const;

/** Opt-in dormant flag. A NEW feature that proposes closing a pane + starting a replacement shell stays OFF until the
 *  coordinator/user explicitly enables it (mirrors autoscale-suggest / placement — dormant-ahead-of-use uses the opt-in form,
 *  NOT flagDefaultOn). ON only for an explicit 1|true|yes|on. Pure. */
export function contentFilterSuccessionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.SWARM_CF_SUCCESSION ?? "").trim());
}

/** Consecutive-hit count for a pane: a detection increments, a CLEAR resets to 0 (so "consecutive" is true consecutiveness —
 *  the caller must call this every sweep with the current detection, detected OR not, to get the reset). Pure. */
export function nextHitCount(prevCount: number, detected: boolean): number {
  if (!detected) return 0;
  return (Number.isInteger(prevCount) && prevCount >= 0 ? prevCount : 0) + 1;
}

export type CfSeverity = "none" | "normal" | "urgent";

/** 0 ⇒ none; 1..(urgentHits-1) ⇒ normal; ≥ urgentHits ⇒ urgent (③). Pure. */
export function hitSeverity(count: number, urgentHits: number = CF_SUCCESSION_URGENT_HITS): CfSeverity {
  if (!(Number.isFinite(count) && count > 0)) return "none";
  return count >= urgentHits ? "urgent" : "normal";
}

/** The seat's in-review checklist — FC-2 three-state so a read fault is NEVER folded to a confident "empty". */
export type ReviewChecklist = { items: readonly string[]; status: "read" | "unreadable" | "absent" };

/** The roster fields the plan + letter need (subset of resume.ts RosterMember). */
export type RosterLike = { member: string; tool: string; cwd: string; role?: string | null; title?: string };

/** Best-effort reviewer short-id for a seat (to attribute review-report dirs, whose names end in `-<reviewerShortId>`): the last
 *  `-`/`:`-separated segment of the title or member handle that looks like a short hex id (≥4 hex chars). "" when none — the store
 *  then returns an ABSENT checklist (never a false empty). Pure. */
export function reviewerIdOf(member: RosterLike): string {
  const cand = (member.title ?? member.member ?? "").trim();
  const seg = cand.split(/[-:]/).filter(Boolean).pop() ?? "";
  return /^[0-9a-f]{4,}$/i.test(seg) ? seg : "";
}

const indentBlock = (s: string, pad = "     "): string => s.split("\n").map((l) => pad + l).join("\n");

/**
 * ④ — the handoff-letter generator (pure): the structured version of a hand-written succession letter. It addresses the NEW
 * shell, states who it replaces + role/cwd, lists the in-review checklist (or an HONEST "unavailable, verify manually" when the
 * source was unreadable — FC-2, never a false "nothing to do"), and names the first action. Pure.
 */
export function buildHandoffLetter(a: { member: RosterLike; checklist: ReviewChecklist; stuckReason: string; recoveredAtIso: string }): string {
  const who = a.member.title ?? a.member.member;
  const L: string[] = [];
  L.push(`[交接信] 你是 ${who}(${a.member.tool})的继任壳,接管于 ${a.recoveredAtIso}。`);
  L.push(`原因:前任在 ${a.stuckReason} 卡死(平台内容过滤),无法自行推进。`);
  L.push(`角色:${a.member.role ?? "(未记)"};工作目录:${a.member.cwd}。`);
  if (a.checklist.status !== "read") {
    L.push(`在判清单:不可自动获取(源 ${a.checklist.status})——请手动核对该席的审查队列后接续,勿假定为空。`);
  } else if (a.checklist.items.length === 0) {
    L.push(`在判清单:无在判项(或已清空)——按角色接续新来件。`);
  } else {
    L.push(`在判清单(${a.checklist.items.length} 项;逐项核对当前判卷状态,勿重判已签项):`);
    for (const it of a.checklist.items.slice(0, 20)) L.push(`  - ${it}`);
    if (a.checklist.items.length > 20) L.push(`  …(余 ${a.checklist.items.length - 20} 项见审查目录)`);
  }
  L.push(`第一步:核对上面每项的当前判卷状态,继续未完成的审查;恢复后向协调者 F53 证据式报到(bus-visible / inbox check-in,非 API 返回)。`);
  return L.join("\n");
}

export type SuccessionPlan = { severity: Exclude<CfSeverity, "none">; taskRef: string; title: string; text: string };

/**
 * ② — the SUGGESTION text proposing a succession plan to the coordinator. SUGGESTION MODE: it LISTS the steps; it executes none
 * of them (close / agent-start / inject are the coordinator's one-click after approval — R16, not automatic). Step 3's injection
 * CARRIES the readiness probe (read-screen for the input box, or herdr pane wait-output, before send-text). Pure.
 */
export function buildSuccessionPlan(a: {
  member: RosterLike; paneRef: string; agentStartCmd: string; handoffLetter: string;
  severity: Exclude<CfSeverity, "none">; hits: number; recoveredAtIso: string;
}): SuccessionPlan {
  const who = a.member.title ?? a.member.member;
  const urgent = a.severity === "urgent";
  const L: string[] = [];
  L.push(`${urgent ? "⚠URGENT " : ""}[F57 继任建议] ${who}(${a.member.tool})pane ${a.paneRef} 检出平台内容过滤卡死(连续 ${a.hits} 次命中${urgent ? ",已达升级阈" : ""})。建议模式:批准后一键执行;spawn 属 R16 邻域,绝不自动。`);
  L.push(`继任预案(协调者批准后执行,本建议不自动执行任何一步):`);
  L.push(`  1. 关旧 pane ${a.paneRef}:先确认前任确无在途未落盘写,再关。`);
  L.push(`  2. 新 tab 起壳(agent start):${a.agentStartCmd}`);
  L.push(`  3. 注入交接信——先就绪探测再注入:读屏见输入框特征(或 herdr pane wait-output)确认 TUI 就绪后才 send-text;否则首注会被未就绪 TUI 静默吞掉(今晚第 5 例实证,同 F53「返回非证据」)。交接信:`);
  L.push(indentBlock(a.handoffLetter));
  L.push(`  4. 验证:继任壳重上总线 + F53 证据式报到(bus-visible / inbox check-in);unknown/failed ⇒ 重注或重做,不以 agent start 的返回为据。`);
  L.push(`裁决:批准即按上执行;驳回则维持观察。`);
  return { severity: a.severity, taskRef: `f57-cf-succession:${a.paneRef}`, title: urgent ? "content-filter stuck (URGENT)" : "content-filter stuck", text: L.join("\n") };
}

/** Compose a per-pane suggestion from a detection outcome. null ⇒ no hit (count 0 ⇒ none) ⇒ the sweep delivers nothing. The
 *  caller holds the per-pane consecutive-hit counter (nextHitCount) and passes the CURRENT count. Pure. */
export function planContentFilterSuccession(a: {
  member: RosterLike; paneRef: string; agentStartCmd: string; checklist: ReviewChecklist;
  hitCount: number; stuckReason: string; recoveredAtIso: string; urgentHits?: number;
}): SuccessionPlan | null {
  const severity = hitSeverity(a.hitCount, a.urgentHits);
  if (severity === "none") return null;
  const handoffLetter = buildHandoffLetter({ member: a.member, checklist: a.checklist, stuckReason: a.stuckReason, recoveredAtIso: a.recoveredAtIso });
  return buildSuccessionPlan({ member: a.member, paneRef: a.paneRef, agentStartCmd: a.agentStartCmd, handoffLetter, severity, hits: a.hitCount, recoveredAtIso: a.recoveredAtIso });
}
