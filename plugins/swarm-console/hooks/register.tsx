/**
 * swarm-console mod — thin CC-mod wiring (docs/swarm/swarm-console-mod-brief.md). ALL logic lives in ./read.ts (pure, tested);
 * this file only subscribes to mod events and renders. Learned API grammar (empirically, gate §0 + .claude-plugin/types): `$` is
 * a CALL-ONLY proxy — always `$.noun.verb(...)` at the call site, NEVER read `$.noun` as a value / optional-chain it; `on("<event>",
 * [filter],hook)`; `next(e)` passes through; a `ui.render` hook returns the JSX from `$.ui.resolve(e)`. `$.env.get` is ASYNC
 * (await it or the path becomes "[object Promise]/..."); `$.fs.list` returns `{name}[]` objects; `$.ui.open` / `$.prompt.fill`
 * return Promises (await + check `.isPlaced` / `.isFilled`); `ui.render` CACHES per input, so a 60s `$.clock.every` +
 * `$.ui.invalidate("ui.render")` is what refreshes the band/pane from disk.
 *
 * Invariants (brief §4): READ-ONLY — the ONLY side effect is `$.prompt.fill` (prefill a decision answer the USER sends); the mod
 * NEVER writes files / sends on the bus / dispatches ("不代发"). FAIL-SOFT — every read is wrapped; a missing/corrupt/unreadable
 * projection renders a placeholder ("源未产" / "待裁:?" / unknown zone) and NEVER throws (a thrown error would break the host
 * session). A corrupt source is shown as UNKNOWN, never as a false-healthy zero/green (SCM-P2-1).
 */
import type { Register } from "claude-code";
import {
  parseGauge, parseDigest, parseBoardFile, sortBoard, parseDecisionMirror, parseRoster,
  bandSummary, decisionCards, decisionFingerprint, cardOptions, decisionPrefill,
  type BoardRow, type DecisionBatchView, type DecisionCard,
} from "./read.js";

const PANE_ID = "swarm-console";
const REFRESH_MS = 60_000; // brief §2: the mod gets no bus push, so poll the projections on a 60s clock (SCM-P2-3).

const envHome = async ($: any): Promise<string> => { try { return String((await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")) ?? ""); } catch { return ""; } };
const root = async ($: any): Promise<string> => `${await envHome($)}/.agenthop`;

/** Read one file fail-soft (≤4MiB via $.fs.read; null on any fault). */
async function readText($: any, path: string): Promise<string | null> {
  try { const t = await $.fs.read(path); return typeof t === "string" ? t : null; } catch { return null; }
}
/** List a dir's entry NAMES, DISCRIMINATING absent/unreadable (⇒ null, UNKNOWN) from confirmed-empty (⇒ []). `$.fs.list`
 *  returns `{name}[]` objects; a throw (ENOENT / EACCES / not a dir) is the unknown state the band must not read as "0". */
async function listDirStrict($: any, path: string): Promise<string[] | null> {
  try {
    const xs = await $.fs.list(path);
    if (!Array.isArray(xs)) return null;
    return xs.map((x: unknown) => (typeof x === "string" ? x : String((x as any)?.name ?? ""))).filter(Boolean);
  } catch { return null; }
}

async function loadBoard($: any): Promise<BoardRow[]> {
  const names = await listDirStrict($, `${await root($)}/swarm/board`);
  if (names === null) return [];
  const dir = `${await root($)}/swarm/board`;
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
async function loadRoster($: any) { const t = await readText($, `${await root($)}/swarm/console/roster.json`); return t === null ? null : parseRoster(t); }

/**
 * Dependency projection (90b58f9c): `~/.agenthop/swarm/console/decisions/<batchId>.json` — each a console-decisions/v1 ENVELOPE.
 * Returns null when the dir is ABSENT/UNREADABLE (⇒ band shows "待裁:?" UNKNOWN, SCM-P2-1), [] when the dir is confirmed-empty
 * (⇒ "待裁:0"). A per-file parse fault just drops that file (fail-soft).
 */
async function loadDecisions($: any): Promise<DecisionBatchView[] | null> {
  const dir = `${await root($)}/swarm/console/decisions`;
  const names = await listDirStrict($, dir);
  if (names === null) return null; // UNKNOWN (dir absent/unreadable) — never a false "0 awaiting"
  const out: DecisionBatchView[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const t = await readText($, `${dir}/${name}`);
    if (t === null) continue;
    const b = parseDecisionMirror(t);
    if (b !== null) out.push(b);
  }
  return out;
}
const pendingCount = (batches: DecisionBatchView[] | null): number | null => (batches === null ? null : batches.reduce((n, b) => n + b.items.length, 0));

export const register: Register = (on) => {
  // register /swarm + start the 60s refresh clock. If any API is unavailable we simply skip it (fail-soft, no throw).
  on("session.start", ($: any, e: any, next: any) => {
    try { $.command.register({ name: "swarm", description: "打开蜂群主控面板(只读:board/gauge/晨报/呈批)" }); } catch { /* command API unavailable ⇒ band still renders */ }
    // SCM-P2-3: ui.render caches per input; the mod gets no bus push, so invalidate on a 60s clock to pull fresh projections.
    try { $.clock.every(REFRESH_MS, () => { try { $.ui.invalidate("ui.render"); } catch { /* no ui ⇒ nothing to refresh */ } }); } catch { /* no clock ⇒ static render */ }
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

  // ── /swarm opens the pane (command.run must RETURN a {text} response; await ui.open and check isPlaced, SCM-P2-4) ──
  on("command.run", { command: "swarm" }, async ($: any, e: any, next: any) => {
    try {
      const opened = await $.ui.open({ id: PANE_ID, title: "蜂群主控(只读)" });
      if (opened && opened.isPlaced === false) return { text: "蜂群主控:终端太窄,面板放不下(拉宽窗口后再 /swarm)。" };
      return { text: "蜂群主控面板已打开(只读:board/gauge/晨报/呈批;呈批聚焦面板后数字键预填答复,你自己发送)。" };
    } catch { return next(e); }
  });

  // ── the pane ──
  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($: any, e: any, next: any) => {
    // SCM-P2-4: resolve the element table ONCE. If even that throws there is nothing to render with — defer to the engine via
    // next(e) rather than calling $.ui.resolve again inside a catch, where a second throw would ESCAPE the handler.
    let R: any;
    try { R = $.ui.resolve(e); } catch { return next(e); }
    const { Box, Text, Client } = R;
    try {
      const [board, gauge, digest, decisions] = await Promise.all([loadBoard($), loadGauge($), loadDigest($), loadDecisions($)]);
      const gaugeLine = gauge === null
        ? "带宽:源未产"
        : `带宽 ${gauge.zone}${gauge.ratio !== null ? ` ratio=${gauge.ratio.toFixed(2)}` : ""} · backlog=${gauge.backlog === null ? "?" : gauge.backlog}`;
      const boardRows = board.length === 0
        ? [<Text key="b0">board:源未产/空</Text>]
        : board.slice(0, 40).map((r, i) => <Text key={`b${i}`}>{`${r.state.padEnd(10)} ${r.owner.slice(0, 10).padEnd(10)} ${r.id}`}</Text>);
      const digestRows = digest === null
        ? [<Text key="d0">晨报:源未产</Text>]
        : digest.sections.slice(0, 6).map((s, i) => <Text key={`d${i}`}>{`· ${s.title}: ${s.lines.slice(0, 2).join(" / ")}`}</Text>);
      const cards: DecisionCard[] = decisionCards(decisions ?? []);
      const decHeader = decisions === null ? "— 待裁呈批(源未产/未读) —" : `— 待裁呈批(${cards.length}) —`;
      // 呈批 cards are the only INTERACTIVE, time-sensitive part — put them at the top so they need no scroll; board + digest follow.
      return (
        <Box flexDirection="column">
          <Text>── 蜂群主控(只读;呈批聚焦面板后数字键预填答复,你自己发送)──</Text>
          <Text>{gaugeLine}</Text>
          <Text>{decHeader}</Text>
          <Client key="rows" module="./rows.tsx" width="100%" props={{ cards }} />
          <Text>— board —</Text>
          <Box flexDirection="column">{boardRows}</Box>
          <Text>— 晨报 —</Text>
          <Box flexDirection="column">{digestRows}</Box>
        </Box>
      );
    } catch { return <Box><Text>蜂群主控:读取投影失败(fail-soft)</Text></Box>; }
  });

  // ── keycapture from rows.tsx: the Client posts the SEEN decision {batchId,itemId,fp,verdict,scope}; the host re-reads, VALIDATES
  //    the item still exists with the SAME fingerprint, then PREFILLS (user sends; mod never writes/dispatches). SCM-P2-2/P2-4. ──
  on("ui.message", async ($: any, e: any, next: any) => {
    try {
      if (String(e?.requestId ?? "") !== PANE_ID || e?.element !== "rows") return next(e);
      const d = e && typeof e.data === "object" && e.data !== null ? e.data : {};
      const batchId = String((d as any).batchId ?? "");
      const itemId = String((d as any).itemId ?? "");
      const fp = String((d as any).fp ?? "");
      const verdict = String((d as any).verdict ?? "");
      const scope = (d as any).scope === undefined || (d as any).scope === null ? undefined : String((d as any).scope);
      if (batchId === "" || itemId === "" || verdict === "") return next(e);

      const decisions = await loadDecisions($);
      const batch = (decisions ?? []).find((b) => b.batchId === batchId);
      const item = batch?.items.find((it) => it.id === itemId);
      if (!item) { toast($, "该呈批条目已不在(可能已裁/已变),请重开 /swarm 重选。"); return next(e); }
      // SCM-P2-2: the list may have changed between render and keystroke — refuse unless the SEEN content still matches.
      if (decisionFingerprint(item) !== fp) { toast($, "该呈批条目内容已变,请重选(勿按旧列表的位置)。"); return next(e); }
      // bind to an option actually OFFERED for THIS item (so a hardGate item can never get a broad scope).
      const opt = cardOptions(item).find((o) => o.verdict === verdict && (o.scope ?? "") === (scope ?? ""));
      if (!opt) { toast($, "该选项对此条目不可用,请重选。"); return next(e); }

      const text = decisionPrefill(batchId, item, opt);
      const res = await $.prompt.fill({ text, mode: "replace" }); // SCM-P2-4: await + honor a refusal
      if (res && res.isFilled === false) toast($, `无法预填(无 composer),请手动发送:${text}`);
    } catch { /* fail-soft: a bad message never breaks the session */ }
    return next(e);
  });
};

function toast($: any, text: string): void { try { $.ui.toast(text); } catch { /* no toast surface ⇒ silent (fail-soft) */ } }
function isEmptyTree(t: unknown): boolean { return t === null || t === undefined || t === false; }
