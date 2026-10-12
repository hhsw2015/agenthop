/**
 * swarm-console mod — Client module for the decision cards + keycapture (docs/swarm/swarm-console-mod-brief.md §3). Mounted by the
 * pane as `<Client module="./rows.tsx" props={{cards}} />`. It owns a CURSOR over ALL awaiting-ruling decision cards (SCM-P3-1:
 * browse every item, not just the first 9 — the window scrolls), shows each card's summary + suggestedAction + evidenceRef +
 * numbered options, and on a digit forwards the SEEN decision `{batchId,itemId,fp,verdict,scope}` back via `surface.post`. That
 * arrives at `on("ui.message")` in register.tsx, which re-reads + validates the fingerprint and PREFILLS the answer (the user
 * sends it; nothing here writes or dispatches). Keys are captured by the mod surface (`surface.onKey`), not raw stdin, and only on
 * terminal/desktop; on phone/Remote the user reads the options and types the answer (this module just captures no keys — fail-soft).
 */
import type { ClientModule } from "claude-code";
import type { DecisionCard } from "./read.js";

type Props = { cards: DecisionCard[] };
type State = { cursor: number };

const WINDOW = 8; // visible cards around the cursor (the list scrolls past this)
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const Rows: ClientModule<Props, State> = (props, surface) => {
  const cards = Array.isArray(props?.cards) ? props.cards : [];
  const n = cards.length;
  if (surface.state === undefined || surface.state === null) surface.setState({ cursor: 0 });

  surface.onKey((ev: { key?: string }) => {
    try {
      if (n === 0) return;
      const key = String(ev?.key ?? "");
      const cur = clamp(Number(surface.state?.cursor ?? 0), 0, n - 1);
      if (key === "ArrowDown" || key === "j") { surface.setState({ cursor: clamp(cur + 1, 0, n - 1) }); return; }
      if (key === "ArrowUp" || key === "k") { surface.setState({ cursor: clamp(cur - 1, 0, n - 1) }); return; }
      if (/^[1-9]$/.test(key)) {
        const card = cards[cur];
        const opt = card?.options?.find((o) => o.key === Number(key));
        // omit `scope` when undefined (reject/defer): a post payload must be JsonValue (no `undefined` values). Host validates + prefills.
        if (card && opt) surface.post(opt.scope ? { batchId: card.batchId, itemId: card.itemId, fp: card.fp, verdict: opt.verdict, scope: opt.scope } : { batchId: card.batchId, itemId: card.itemId, fp: card.fp, verdict: opt.verdict });
      }
    } catch { /* a bad key event never breaks the session */ }
  });

  const { Box, Text } = surface.elements;
  try {
    if (n === 0) return <Box><Text>（无待裁呈批可操作）</Text></Box>;
    const cur = clamp(Number(surface.state?.cursor ?? 0), 0, n - 1);
    const start = clamp(cur - Math.floor(WINDOW / 2), 0, Math.max(0, n - WINDOW));
    const visible = cards.slice(start, start + WINDOW);

    // Build a FLAT child array of <Text> lines only (no nested Box, no null children — the engine rejects an invalid tree and
    // draws its own fallback). The focused card expands to extra indented lines right after its header.
    const lines: Array<{ key: string; text: string }> = [{ key: "hdr", text: `↑↓/jk 移动 · 数字键=预填答复(你自己发送) · ${cur + 1}/${n}` }];
    for (let i = 0; i < visible.length; i++) {
      const c = visible[i]!;
      const idx = start + i;
      const focused = idx === cur;
      lines.push({ key: `c${idx}`, text: `${focused ? "▶" : " "} ${idx + 1}. ${trunc(c.summary, 72)}` });
      if (focused) {
        lines.push({ key: `c${idx}-a`, text: `    建议:${trunc(c.suggestedAction || "-", 72)}` });
        if (c.evidenceRef) lines.push({ key: `c${idx}-e`, text: `    证据:${trunc(c.evidenceRef, 72)}` });
        lines.push({ key: `c${idx}-o`, text: `    ${c.options.map((o) => `${o.key}=${o.label}`).join("  ")}` });
      }
    }
    return <Box flexDirection="column">{lines.map((l) => <Text key={l.key}>{l.text}</Text>)}</Box>;
  } catch {
    return <Box><Text>呈批渲染失败(fail-soft)</Text></Box>;
  }
};

export default Rows;
