/**
 * swarm-console mod — PURE read/parse/format core (docs/swarm/swarm-console-mod-brief.md). No IO, no `claude-code` import, no
 * clock: every function takes already-read text (register.tsx supplies it via `$.fs.read`) and returns a fail-soft view model or a
 * formatted string. This is the unit-testable half; the TSX render + keycapture wiring lives in register.tsx / rows.tsx.
 *
 * Contract invariants (brief §4): READ-ONLY — nothing here writes; the ONLY mod side effect anywhere is `$.prompt.fill` in
 * register.tsx, which prefills a decision-answer the USER sends (the mod never writes decisions.json / sends on the bus). Every
 * parser is FAIL-SOFT: malformed / missing / wrong-schema input ⇒ null (caller renders a "—" / "源未产" placeholder), NEVER throws
 * (a thrown error would break the host CC session). Field names mirror the frozen producers: bandwidth-gauge/v1,
 * morning-digest/v1, the board `<id>.<state>.<owner>.json` files, and the decision-batch DecisionBatch/DecisionItem schema
 * (packages/bus/src/swarm/decision-batch.ts — the single source of truth; copied, not re-invented).
 */

// ── view models (what the panel/band render) ──────────────────────────────────────────────────────────────────────────────

export type GaugeView = { zone: "green" | "amber" | "red"; ratio: number | null; backlog: number };
export type DigestSectionView = { title: string; lines: string[] };
export type DigestView = { date: string; sections: DigestSectionView[] };
export type BoardRow = { id: string; state: string; owner: string; title: string; goal: string };
export type DecisionItemView = { id: string; kind: string; summary: string; suggestedAction: string; evidenceRef?: string; hardGate: boolean };
export type DecisionBatchView = { batchId: string; owner: string; items: DecisionItemView[] };
export type RosterSeat = { name: string; state: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Parse untrusted JSON WITHOUT throwing (a throw in a mod hook breaks the host session). */
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

// ── (1) bandwidth gauge  (console/bandwidth-gauge/gauge.json · bandwidth-gauge/v1) ──
export function parseGauge(text: string): GaugeView | null {
  const o = safeJson(text);
  if (!isObj(o) || o.schema !== "bandwidth-gauge/v1") return null;
  const zone = o.zone === "amber" || o.zone === "red" ? o.zone : "green";
  const ratio = typeof o.ratio === "number" && Number.isFinite(o.ratio) ? o.ratio : null;
  const backlog = typeof o.backlog === "number" && Number.isFinite(o.backlog) ? o.backlog : 0;
  return { zone, ratio, backlog };
}

// ── (2) morning digest  (console/morning-digest/digest.json · morning-digest/v1) ──
export function parseDigest(text: string): DigestView | null {
  const o = safeJson(text);
  if (!isObj(o) || o.schema !== "morning-digest/v1") return null;
  const secsRaw = Array.isArray(o.sections) ? o.sections : [];
  const sections: DigestSectionView[] = [];
  for (const s of secsRaw) {
    if (!isObj(s)) continue;
    const lines = Array.isArray(s.lines) ? s.lines.filter((l): l is string => typeof l === "string") : [];
    sections.push({ title: str(s.title), lines });
  }
  return { date: str(o.date), sections };
}

// ── (3) board  (swarm/board/<id>.<state>.<owner>.json) — state + owner come from the FILENAME, id/title/goal from the content ──
/** Parse one board filename `<id>.<state>.<owner>.json` ⇒ { state, owner } (null if it is not that shape). The id prefix is
 *  authoritative from the JSON body; the filename's last two dot-segments before `.json` are state and owner. */
export function parseBoardName(name: string): { state: string; owner: string } | null {
  if (!name.endsWith(".json")) return null;
  const base = name.slice(0, -5);
  const parts = base.split(".");
  if (parts.length < 3) return null; // need at least <id>.<state>.<owner>
  const owner = parts[parts.length - 1] ?? "";
  const state = parts[parts.length - 2] ?? "";
  if (owner === "" || state === "") return null;
  return { state, owner };
}
export function parseBoardFile(name: string, text: string): BoardRow | null {
  const nm = parseBoardName(name);
  if (nm === null) return null;
  const o = safeJson(text);
  if (!isObj(o)) return null;
  const id = str(o.id);
  if (id === "") return null;
  return { id, state: nm.state, owner: nm.owner, title: str(o.title), goal: str(o.goal) };
}
/** Sort board rows deterministically (by state, then id) for a stable table. Pure. */
export function sortBoard(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── (4) decisions projection (DEPENDENCY: console/decisions/*.json, producer by 90b58f9c) — DecisionBatch/DecisionItem schema ──
export function parseDecisionBatch(text: string): DecisionBatchView | null {
  const o = safeJson(text);
  if (!isObj(o)) return null;
  const batchId = str(o.batchId);
  if (batchId === "") return null;
  const itemsRaw = Array.isArray(o.items) ? o.items : [];
  const items: DecisionItemView[] = [];
  for (const it of itemsRaw) {
    if (!isObj(it)) continue;
    const id = str(it.id);
    if (id === "") continue;
    items.push({ id, kind: str(it.kind), summary: str(it.summary), suggestedAction: str(it.suggestedAction), evidenceRef: typeof it.evidenceRef === "string" ? it.evidenceRef : undefined, hardGate: it.hardGate === true });
  }
  return { batchId, owner: str(o.owner), items };
}

// ── roster (DEPENDENCY: console/roster.json, producer by 90b58f9c) ──
export function parseRoster(text: string): RosterSeat[] | null {
  const o = safeJson(text);
  if (!isObj(o)) return null;
  const seatsRaw = Array.isArray(o.seats) ? o.seats : null;
  if (seatsRaw === null) return null;
  const seats: RosterSeat[] = [];
  for (const s of seatsRaw) { if (isObj(s) && typeof s.name === "string" && s.name !== "") seats.push({ name: s.name, state: str(s.state) || "unknown" }); }
  return seats;
}

// ── band summary (one line above the prompt): seats · pending decisions · bandwidth zone. Fail-soft placeholders for unproduced sources. ──
const ZONE_GLYPH: Record<GaugeView["zone"], string> = { green: "●", amber: "◆", red: "✕" };
export function bandSummary(input: { roster: RosterSeat[] | null; pendingDecisions: number | null; gauge: GaugeView | null }): string {
  const seats = input.roster === null ? "席:源未产" : `席:${input.roster.filter((s) => s.state !== "unknown" && s.state !== "gone").length}/${input.roster.length}`;
  const pend = input.pendingDecisions === null ? "待裁:源未产" : `待裁:${input.pendingDecisions}`;
  const band = input.gauge === null ? "带宽:—" : `带宽:${ZONE_GLYPH[input.gauge.zone]}${input.gauge.zone}${input.gauge.ratio !== null ? `(${input.gauge.ratio.toFixed(2)})` : ""}`;
  return `蜂群 ${seats} · ${pend} · ${band}`;
}

// ── decision-answer prefill (keycapture → $.prompt.fill). Carries the FROZEN decisions.json fields (batchId/id/verdict/scope) as
//    an agent-actionable instruction the USER sends; the mod itself never writes decisions.json / sends (brief §4). ──
export type Verdict = "approve" | "reject" | "defer";
export type ApprovalScope = "once" | "this-chat" | "always";
/** Options a card offers to the digit keys (1..N). hardGate items never offer a broad scope (always-once); defer always available. */
export type DecisionOption = { key: number; label: string; verdict: Verdict; scope?: ApprovalScope };
export function cardOptions(item: DecisionItemView): DecisionOption[] {
  const opts: DecisionOption[] = [{ key: 1, label: "批准(once)", verdict: "approve", scope: "once" }];
  if (!item.hardGate) opts.push({ key: 2, label: "批准(this-chat)", verdict: "approve", scope: "this-chat" });
  opts.push({ key: opts.length + 1, label: "驳回", verdict: "reject" });
  opts.push({ key: opts.length + 1, label: "暂缓", verdict: "defer" });
  return opts.map((o, i) => ({ ...o, key: i + 1 }));
}
export function decisionPrefill(batchId: string, item: DecisionItemView, opt: DecisionOption): string {
  const scope = opt.scope ? ` scope=${opt.scope}` : "";
  // an agent-actionable line carrying exactly the frozen decisions.json fields; the coordinator's own session writes it via the
  // decision-batch tools (mod does not write / send). Not a mod command — plain text the user reviews and sends.
  return `记录呈批决定(走既有 decision-batch,勿改其它项):batch=${batchId} item=${item.id} verdict=${opt.verdict}${scope} — ${item.summary}`;
}
