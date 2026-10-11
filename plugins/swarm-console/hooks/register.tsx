/**
 * swarm-console mod — thin CC-mod wiring (docs/swarm/swarm-console-mod-brief.md). ALL logic lives in ./read.ts (pure, tested);
 * this file only subscribes to mod events and renders. Learned API grammar (empirically, gate §0): `$` is a CALL-ONLY proxy —
 * always `$.noun.verb(...)` at the call site, NEVER read `$.noun` as a value / optional-chain it; `on("<event>",[filter],hook)`;
 * `next(e)` passes through; a `ui.render` hook returns the JSX from `$.ui.resolve(e)`.
 *
 * Invariants (brief §4): READ-ONLY — the ONLY side effect is `$.prompt.fill` (prefill a decision answer the USER sends); the mod
 * NEVER writes files / sends on the bus / dispatches ("不代发"). FAIL-SOFT — every read is wrapped; a missing/corrupt projection
 * renders a "源未产"/"—" placeholder and NEVER throws (a thrown error would break the host session). Unproduced dependency
 * projections (decisions, roster) degrade to placeholders until their producers land.
 */
import type { Register } from "claude-code";
import {
  parseGauge, parseDigest, parseBoardFile, sortBoard, parseDecisionBatch, parseRoster,
  bandSummary, cardOptions, decisionPrefill, type BoardRow, type DecisionBatchView, type DecisionItemView,
} from "./read.js";

const PANE_ID = "swarm-console";
// NOTE (empirically learned, gate §0): `$.env.get` is ASYNC (returns a Promise) — it MUST be awaited, or the path becomes
// "[object Promise]/..." and every read fails. `$.fs.list` returns `{name}[]` objects (handled in listDir).
const envHome = async ($: any): Promise<string> => { try { return String((await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")) ?? ""); } catch { return ""; } };
const root = async ($: any): Promise<string> => `${await envHome($)}/.agenthop`;

/** Read one file fail-soft (≤4MiB via $.fs.read; null on any fault). */
async function readText($: any, path: string): Promise<string | null> {
  try { const t = await $.fs.read(path); return typeof t === "string" ? t : null; } catch { return null; }
}
async function listDir($: any, path: string): Promise<string[]> {
  try { const xs = await $.fs.list(path); return Array.isArray(xs) ? xs.map((x: unknown) => (typeof x === "string" ? x : String((x as any)?.name ?? ""))).filter(Boolean) : []; } catch { return []; }
}

async function loadBoard($: any): Promise<BoardRow[]> {
  const dir = `${await root($)}/swarm/board`;
  const names = await listDir($, dir);
  const rows: BoardRow[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const t = await readText($, `${dir}/${name}`);
    if (t === null) continue;
    const r = parseBoardFile(name, t);
    if (r !== null) rows.push(r);
  }
  return sortBoard(rows);
}
async function loadGauge($: any) { const t = await readText($, `${await root($)}/console/bandwidth-gauge/gauge.json`); return t === null ? null : parseGauge(t); }
async function loadDigest($: any) { const t = await readText($, `${await root($)}/console/morning-digest/digest.json`); return t === null ? null : parseDigest(t); }
async function loadRoster($: any) { const t = await readText($, `${await root($)}/console/roster.json`); return t === null ? null : parseRoster(t); }
/** Dependency projection (90b58f9c): console/decisions/*.json — each a DecisionBatch. Fail-soft: absent dir ⇒ [] (placeholder). */
async function loadDecisions($: any): Promise<DecisionBatchView[]> {
  const dir = `${await root($)}/console/decisions`;
  const names = await listDir($, dir);
  const out: DecisionBatchView[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const t = await readText($, `${dir}/${name}`);
    if (t === null) continue;
    const b = parseDecisionBatch(t);
    if (b !== null) out.push(b);
  }
  return out;
}
const pendingCount = (batches: DecisionBatchView[]): number => batches.reduce((n, b) => n + b.items.length, 0);
/** Flatten batches→(batch,item) in a stable order so a cursor index maps deterministically to one decision. */
function flatItems(batches: DecisionBatchView[]): { batchId: string; item: DecisionItemView }[] {
  const out: { batchId: string; item: DecisionItemView }[] = [];
  for (const b of batches) for (const it of b.items) out.push({ batchId: b.batchId, item: it });
  return out;
}

export const register: Register = (on) => {
  // register the /swarm command; if registration is unavailable we simply never open the pane (fail-soft, no throw).
  on("session.start", ($: any, e: any, next: any) => {
    try { $.command.register({ name: "swarm", description: "打开蜂群主控面板(只读:board/gauge/晨报/呈批)" }); } catch { /* command API unavailable ⇒ band still renders */ }
    return next(e);
  });

  // ── status band (one line above the prompt) ──
  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    const below = await next(e);
    try {
      const { Box, Text } = $.ui.resolve(e);
      const [gauge, roster, decisions] = await Promise.all([loadGauge($), loadRoster($), loadDecisions($)]);
      const line = bandSummary({ roster, pendingDecisions: pendingCount(decisions), gauge });
      const mine = <Box><Text>{line}</Text></Box>;
      return isEmptyTree(below) ? mine : <Box flexDirection="column">{mine}{below}</Box>;
    } catch { return below; } // band render must never break the prompt
  });

  // ── /swarm opens the pane (command.run must RETURN a {text} response, filtered on {command:"swarm"}) ──
  on("command.run", { command: "swarm" }, ($: any, e: any, next: any) => {
    try { $.ui.open({ id: PANE_ID, title: "蜂群主控(只读)" }); return { text: "蜂群主控面板已打开(只读:board/gauge/晨报/呈批;呈批数字键预填答复,你自己发送)。" }; } catch { return next(e); }
  });

  // ── the pane ──
  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($: any, e: any, next: any) => {
    try {
      const { Box, Text, Client } = $.ui.resolve(e);
      const [board, gauge, digest, decisions] = await Promise.all([loadBoard($), loadGauge($), loadDigest($), loadDecisions($)]);
      const gaugeLine = gauge === null ? "带宽:源未产" : `带宽 ${gauge.zone}${gauge.ratio !== null ? ` ratio=${gauge.ratio.toFixed(2)}` : ""} · backlog=${gauge.backlog}`;
      const boardRows = board.length === 0 ? [<Text key="b0">board:源未产/空</Text>] : board.slice(0, 40).map((r, i) => <Text key={`b${i}`}>{`${r.state.padEnd(10)} ${r.owner.slice(0, 10).padEnd(10)} ${r.id}`}</Text>);
      const digestRows = digest === null ? [<Text key="d0">晨报:源未产</Text>] : digest.sections.slice(0, 6).map((s, i) => <Text key={`d${i}`}>{`· ${s.title}: ${s.lines.slice(0, 2).join(" / ")}`}</Text>);
      const flat = flatItems(decisions);
      const decRows = flat.length === 0
        ? [<Text key="x0">呈批:源未产/无待裁(依赖 producer 90b58f9c)</Text>]
        : flat.slice(0, 9).map((f, i) => <Text key={`x${i}`}>{`[${i + 1}] ${f.item.summary}  ${cardOptions(f.item).map((o) => `${o.key}=${o.label}`).join(" ")}`}</Text>);
      return (
        <Box flexDirection="column">
          <Text>── 蜂群主控(只读;呈批数字键预填答复,你自己发送)──</Text>
          <Text>{gaugeLine}</Text>
          <Box flexDirection="column">{boardRows}</Box>
          <Text>— 晨报 —</Text>
          <Box flexDirection="column">{digestRows}</Box>
          <Text>— 待裁呈批 —</Text>
          <Box flexDirection="column">{decRows}</Box>
          <Client key="rows" module="./rows.tsx" width="100%" props={{ count: Math.min(flat.length, 9) }} />
        </Box>
      );
    } catch { const { Box, Text } = $.ui.resolve(e); return <Box><Text>蜂群主控:读取投影失败(fail-soft)</Text></Box>; }
  });

  // ── keycapture from rows.tsx: a digit on the focused decision ⇒ PREFILL the answer (user sends; mod never writes/dispatches) ──
  on("ui.message", async ($: any, e: any, next: any) => {
    try {
      // the Client's surface.post payload arrives under e.data, tagged with e.element = the Client's key ("rows") — the proven
      // claude-console form (NOT top-level e.key). An open pane captures the keyboard; focus the pane and a digit lands here.
      if (String(e?.requestId ?? "") !== PANE_ID || e?.element !== "rows") return next(e);
      const d = e && typeof e.data === "object" && e.data !== null ? e.data : {};
      const key = String((d as any).key ?? "");
      const cursor = Number((d as any).cursor ?? 0);
      const digit = /^[1-9]$/.test(key) ? Number(key) : 0;
      if (digit === 0) return next(e);
      const decisions = await loadDecisions($);
      const flat = flatItems(decisions);
      const target = flat[cursor];
      if (!target) return next(e);
      const opt = cardOptions(target.item).find((o) => o.key === digit);
      if (!opt) return next(e);
      $.prompt.fill({ text: decisionPrefill(target.batchId, target.item, opt), mode: "replace" });
    } catch { /* fail-soft: a bad message never breaks the session */ }
    return next(e);
  });
};

function isEmptyTree(t: unknown): boolean { return t === null || t === undefined || t === false; }
