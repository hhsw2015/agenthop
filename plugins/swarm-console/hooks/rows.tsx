/**
 * swarm-console mod — Client module for keycapture (docs/swarm/swarm-console-mod-brief.md §3). Mounted by the pane as
 * `<ui.Client module="./rows.tsx" props={{count}} />`. It owns only a CURSOR over the (≤9) decision rows and forwards a chosen
 * digit back to the host via `surface.post`, which arrives at `on("ui.message")` in register.tsx — which then PREFILLS the answer
 * (the user sends it; nothing here writes or dispatches). Keys are captured by the mod surface (`surface.onKey`), not raw stdin.
 * Keycapture works on terminal/desktop surfaces only; on phone/Remote the pane still shows the numbered options as plain text and
 * the user types the answer — this module simply captures no keys there (fail-soft, no throw).
 */
import type { ClientModule } from "claude-code";

type Props = { count: number };
type State = { cursor: number };

export const Rows: ClientModule<Props, State> = (props, surface) => {
  const count = Math.max(0, Math.min(9, Number(props?.count ?? 0)));
  if (surface.state === undefined || surface.state === null) surface.setState({ cursor: 0 });

  surface.onKey((ev: { key?: string }) => {
    try {
      const key = String(ev?.key ?? "");
      const cur = Math.max(0, Math.min(count - 1, Number(surface.state?.cursor ?? 0)));
      if (count === 0) return;
      if (key === "ArrowDown" || key === "j") { surface.setState({ cursor: Math.min(count - 1, cur + 1) }); return; }
      if (key === "ArrowUp" || key === "k") { surface.setState({ cursor: Math.max(0, cur - 1) }); return; }
      if (/^[1-9]$/.test(key)) { surface.post({ key, cursor: cur }); return; } // host prefill-maps (digit, cursor) → decision answer
    } catch { /* a bad key event never breaks the session */ }
  });

  const { Box, Text } = surface.elements;
  const cur = Math.max(0, Math.min(Math.max(count - 1, 0), Number(surface.state?.cursor ?? 0)));
  if (count === 0) return <Box><Text>（无待裁呈批可操作）</Text></Box>;
  return <Box><Text>{`▶ 选中第 ${cur + 1}/${count} 项 · ↑↓/jk 移动 · 数字键选项=预填答复(你自己发送)`}</Text></Box>;
};

export default Rows;
