/**
 * swarm-console mod — PURE read/parse/format core (docs/swarm/swarm-console-mod-brief.md). No IO, no `claude-code` import, no
 * clock: every function takes already-read text (register.tsx supplies it via `$.fs.read`) and returns a fail-soft view model or a
 * formatted string. This is the unit-testable half; the TSX render + keycapture wiring lives in register.tsx / rows.tsx.
 *
 * Contract invariants (brief §4): READ-ONLY — nothing here writes; the ONLY mod side effect anywhere is `$.prompt.fill` in
 * register.tsx, which prefills a decision-answer the USER sends (the mod never writes decisions.json / sends on the bus). Every
 * parser is FAIL-SOFT: malformed / missing / wrong-schema input ⇒ null (caller renders a placeholder), NEVER throws (a thrown
 * error would break the host CC session).
 *
 * Field names mirror the frozen PRODUCERS (single source of truth, copied not re-invented):
 *   - gauge   : `~/.agenthop/console/bandwidth-gauge/gauge.json`  schema "bandwidth-gauge/v1"  (dual-bandwidth-store.ts)
 *   - digest  : `~/.agenthop/console/morning-digest/digest.json`  schema "morning-digest/v1"   (morning-digest-store.ts)
 *   - board   : `~/.agenthop/swarm/board/*.json`                  filename `<itemId>.json` (posted) or `<itemId>.<state>.<who>.json`
 *               (task-board.ts parseBoardItemName); body carries `itemId` (formal v2 board) OR `id` (coordinator board).
 *   - decisions: `~/.agenthop/swarm/console/decisions/<batchId>.json`  ENVELOPE "console-decisions/v1" { generatedAtSec, batch }
 *               where `.batch` is a verbatim decision-batch-v1 batch (console-projection.ts buildDecisionMirror).
 *   - roster  : `~/.agenthop/swarm/console/roster.json`          ENVELOPE "console-roster/v1" { generatedAtSec, seats[] }
 *               seats = { sid, tool, pane, alive: alive|dead|unknown, inflight } (console-projection.ts buildRosterProjection).
 */

// ── view models (what the panel/band render) ──────────────────────────────────────────────────────────────────────────────

/** SCM-P2-1: a corrupt/missing gauge must express UNKNOWN, never a false-healthy green. `zone:"unknown"` and `backlog:null` are
 *  the honest degrade; a readable gauge with a legit null ratio (no consumption yet) keeps ratio:null but a REAL zone. */
export type GaugeZone = "green" | "amber" | "red" | "unknown";
export type GaugeView = { zone: GaugeZone; ratio: number | null; backlog: number | null };
export type DigestSectionView = { title: string; lines: string[] };
export type DigestView = { date: string; sections: DigestSectionView[] };
export type BoardRow = { id: string; state: string; owner: string; title: string; goal: string };
export type DecisionItemView = { id: string; kind: string; summary: string; suggestedAction: string; evidenceRef?: string; hardGate: boolean };
export type DecisionBatchView = { batchId: string; owner: string; items: DecisionItemView[] };
/** console-roster/v1 seat. `alive` is the producer's FC-2 r3 three-state; `inflight` = live waits this seat owns. */
export type SeatAlive = "alive" | "dead" | "unknown";
export type RosterSeat = { sid: string; tool: string; pane: string | null; alive: SeatAlive; inflight: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Parse untrusted JSON WITHOUT throwing (a throw in a mod hook breaks the host session). */
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

// ── (1) bandwidth gauge  (console/bandwidth-gauge/gauge.json · bandwidth-gauge/v1) ──
export function parseGauge(text: string): GaugeView | null {
  const o = safeJson(text);
  if (!isObj(o) || o.schema !== "bandwidth-gauge/v1") return null;
  // SCM-P2-1: an unrecognized zone degrades to "unknown" (NOT green — a corrupt field must never read as a healthy swarm).
  const zone: GaugeZone = o.zone === "green" || o.zone === "amber" || o.zone === "red" ? o.zone : "unknown";
  const ratio = typeof o.ratio === "number" && Number.isFinite(o.ratio) ? o.ratio : null;
  // SCM-P2-1: a non-numeric backlog is UNKNOWN (null), never a false 0 ("nothing queued").
  const backlog = typeof o.backlog === "number" && Number.isFinite(o.backlog) ? o.backlog : null;
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

// ── (3) board  (swarm/board/<itemId>.json posted | <itemId>.<state>.<who>.json) — state+owner from the FILENAME, identity/goal from body ──
/**
 * Parse one board FILENAME to { state, owner }. Mirrors task-board.ts parseBoardItemName / delegation-observer.parseBoardFile:
 *   - `<itemId>.json`              (1 segment)  ⇒ state "posted", owner "" (SCM-P2-1: these were WRONGLY rejected before).
 *   - `<itemId>.<state>.<who>.json`(>=3 segs)   ⇒ the LAST two dot-segments are state + who (itemId is dot-free by convention).
 *   - `<itemId>.<state>.json`      (2 segments) ⇒ state, owner "".
 * The itemId itself is read from the BODY (parseBoardFile), so we only need state+owner here.
 */
export function parseBoardName(name: string): { state: string; owner: string } | null {
  if (!name.endsWith(".json")) return null;
  const parts = name.slice(0, -".json".length).split(".");
  if (parts.length === 1) return parts[0] ? { state: "posted", owner: "" } : null; // posted/unclaimed
  if (parts.length === 2) return parts[1] ? { state: parts[1], owner: "" } : null;
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
  // SCM-P2-1: the formal v2 board writes `itemId`; the coordinator board writes `id`. Accept either as the row identity.
  const id = str(o.itemId) || str(o.id);
  if (id === "") return null;
  // owner from the filename is authoritative; a posted file has none, so fall back to the body's postedBy.
  const owner = nm.owner || str(o.postedBy) || str(o.origin);
  return { id, state: nm.state, owner, title: str(o.title), goal: str(o.goal) };
}
/** Sort board rows deterministically (by state, then id) for a stable table. Pure. */
export function sortBoard(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── (4) decisions mirror (swarm/console/decisions/<batchId>.json · ENVELOPE console-decisions/v1) ──
/**
 * SCM-P2-1: a parsed batch carries a COMPLETENESS flag. `complete:false` means some of the batch could not be represented (the
 * `items` field was not an array, or an entry was a non-object / had no id, so it was dropped). The caller keeps the items it
 * COULD read but must surface that the count is not fully known — a dropped item must never silently shrink a confident total.
 */
export type BatchParse = { view: DecisionBatchView; complete: boolean };
/** Parse one decisions file: the console-decisions/v1 ENVELOPE, extract `.batch`, then validate the inner decision-batch-v1.
 *  A wrong/missing envelope schema ⇒ null (whole file is UNKNOWN = the caller counts it as unread, never as 0), never a throw. */
export function parseDecisionMirror(text: string): BatchParse | null {
  const o = safeJson(text);
  if (!isObj(o) || o.schema !== "console-decisions/v1") return null; // SCM-N1: validate the envelope before trusting .batch
  if (!isObj(o.batch)) return null;
  return parseBatch(o.batch);
}
/** Validate an already-parsed decision-batch-v1 object (the envelope's `.batch`). Exported for the selftest. */
export function parseBatch(o: Record<string, unknown>): BatchParse | null {
  const batchId = str(o.batchId);
  if (batchId === "") return null;
  // SCM-P2-1: a missing/non-array `items`, or any entry we cannot represent, makes the batch INCOMPLETE (we keep what we read).
  let complete = Array.isArray(o.items);
  const itemsRaw = Array.isArray(o.items) ? o.items : [];
  const items: DecisionItemView[] = [];
  for (const it of itemsRaw) {
    if (!isObj(it)) { complete = false; continue; }
    const id = str(it.id);
    if (id === "") { complete = false; continue; }
    items.push({ id, kind: str(it.kind), summary: str(it.summary), suggestedAction: str(it.suggestedAction), evidenceRef: typeof it.evidenceRef === "string" ? it.evidenceRef : undefined, hardGate: it.hardGate === true });
  }
  return { view: { batchId, owner: str(o.owner), items }, complete };
}

// ── (5) roster (swarm/console/roster.json · ENVELOPE console-roster/v1) ──
export function parseRoster(text: string): RosterSeat[] | null {
  const o = safeJson(text);
  if (!isObj(o) || o.schema !== "console-roster/v1") return null; // SCM-N1: console-roster/v1 envelope, seats = {sid,tool,pane,alive,inflight}
  const seatsRaw = Array.isArray(o.seats) ? o.seats : null;
  if (seatsRaw === null) return null;
  const seats: RosterSeat[] = [];
  for (const s of seatsRaw) {
    if (!isObj(s)) continue;
    const sid = str(s.sid);
    if (sid === "") continue;
    const alive: SeatAlive = s.alive === "alive" || s.alive === "dead" || s.alive === "unknown" ? s.alive : "unknown";
    const inflight = typeof s.inflight === "number" && Number.isFinite(s.inflight) && s.inflight > 0 ? Math.floor(s.inflight) : 0;
    seats.push({ sid, tool: str(s.tool), pane: s.pane == null ? null : String(s.pane), alive, inflight });
  }
  return seats;
}

// ── band summary (one line above the prompt): seats · pending decisions · bandwidth zone. Fail-soft placeholders for unproduced/unknown sources. ──
/** Pending-decisions view: `null` = the whole dir is UNKNOWN (absent/unreadable). Otherwise `known` = items in fully-read batches,
 *  `unknown` = files/batches we could not fully read (unreadable, corrupt, wrong-schema, or incomplete). SCM-P2-1. */
export type PendingView = { known: number; unknown: number } | null;
/** Format the pending segment: `待裁:?` (dir unknown) · `待裁:N` (all read, exact) · `待裁:N+U?` (N confirmed, U unread/corrupt). */
export function pendingLabel(p: PendingView): string {
  if (p === null) return "待裁:?";
  return p.unknown > 0 ? `待裁:${p.known}+${p.unknown}?` : `待裁:${p.known}`;
}
const ZONE_GLYPH: Record<GaugeZone, string> = { green: "●", amber: "◆", red: "✕", unknown: "?" };
export function bandSummary(input: { roster: RosterSeat[] | null; pending: PendingView; gauge: GaugeView | null }): string {
  const seats = input.roster === null
    ? "席:源未产"
    : `席:${input.roster.filter((s) => s.alive === "alive").length}/${input.roster.length}`;
  const band = input.gauge === null ? "带宽:源未产" : `带宽:${ZONE_GLYPH[input.gauge.zone]}${input.gauge.zone}${input.gauge.ratio !== null ? `(${input.gauge.ratio.toFixed(2)})` : ""}`;
  return `蜂群 ${seats} · ${pendingLabel(input.pending)} · ${band}`;
}

// ── decision cards + answer prefill (keycapture → $.prompt.fill). Carries the FROZEN decisions.json fields as an agent-actionable
//    instruction the USER sends; the mod itself never writes decisions.json / sends (brief §4). ──
export type Verdict = "approve" | "reject" | "defer";
export type ApprovalScope = "once" | "this-chat" | "always";
/** Options a card offers to the digit keys (1..N). hardGate items never offer a broad scope (approve is always "once"); defer always available. */
export type DecisionOption = { key: number; label: string; verdict: Verdict; scope?: ApprovalScope };
export function cardOptions(item: DecisionItemView): DecisionOption[] {
  const opts: DecisionOption[] = [{ key: 1, label: "批准(once)", verdict: "approve", scope: "once" }];
  if (!item.hardGate) opts.push({ key: 2, label: "批准(this-chat)", verdict: "approve", scope: "this-chat" });
  opts.push({ key: opts.length + 1, label: "驳回", verdict: "reject" });
  opts.push({ key: opts.length + 1, label: "暂缓", verdict: "defer" });
  return opts.map((o, i) => ({ ...o, key: i + 1 }));
}

/**
 * SCM-P2-2: a FINGERPRINT of the decision content the user actually SAW. The keycapture round-trips (batchId,itemId,fp) through
 * the Client; on the way back the host re-reads the batches and refuses to prefill unless the SAME (batchId,itemId) still exists
 * with the SAME fingerprint — so a list that changed between render and keystroke forces a re-selection instead of silently
 * prefilling a different item that happens to sit at the same index. Deterministic, pure. NUL-separated so fields can't collide.
 */
export function decisionFingerprint(item: DecisionItemView): string {
  // SCM-P2-2: bind EVERY field the card shows / that shapes the decision — summary, suggestedAction, evidenceRef, hardGate.
  // JSON.stringify of a fixed-order array is UNAMBIGUOUS: each string is quoted + escaped, so no value (even one containing the
  // old U+0000 separator) can collide across fields. `evidenceRef ?? null` distinguishes "absent" from an empty string.
  return JSON.stringify([item.summary, item.suggestedAction, item.evidenceRef ?? null, item.hardGate]);
}

/** One card as the Client renders + keys it: the SEEN identity + fingerprint + the resolved options. Pushed to rows.tsx via props. */
export type DecisionCard = { batchId: string; itemId: string; summary: string; suggestedAction: string; evidenceRef?: string; hardGate: boolean; fp: string; options: DecisionOption[] };
/** Flatten batches → cards in a stable order (batch order, item order). Each card carries everything the Client needs to post a
 *  self-describing, index-independent decision. SCM-P3-1: ALL items become cards (the Client scrolls; no 9-item cap here). */
export function decisionCards(batches: readonly DecisionBatchView[]): DecisionCard[] {
  const out: DecisionCard[] = [];
  for (const b of batches) {
    for (const it of b.items) {
      // the card is passed VERBATIM as Client props (JsonValue) — it must hold NO `undefined` value (the mod runtime refuses
      // "props holds undefined"). So evidenceRef is emitted ONLY when present (conditional spread, never `evidenceRef: undefined`).
      out.push({
        batchId: b.batchId, itemId: it.id, summary: it.summary, suggestedAction: it.suggestedAction,
        ...(it.evidenceRef !== undefined ? { evidenceRef: it.evidenceRef } : {}),
        hardGate: it.hardGate, fp: decisionFingerprint(it), options: cardOptions(it),
      });
    }
  }
  return out;
}

export function decisionPrefill(batchId: string, item: DecisionItemView, opt: DecisionOption): string {
  const scope = opt.scope ? ` scope=${opt.scope}` : "";
  // an agent-actionable line carrying exactly the frozen decisions.json fields; the coordinator's own session writes it via the
  // decision-batch tools (mod does not write / send). Not a mod command — plain text the user reviews and sends.
  return `记录呈批决定(走既有 decision-batch,勿改其它项):batch=${batchId} item=${item.id} verdict=${opt.verdict}${scope} — ${item.summary}`;
}
