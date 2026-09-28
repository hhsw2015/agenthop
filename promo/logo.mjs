// Exports the agenthop logo into promo/logo/: the mark as SVG, app icons, an avatar, favicons,
// wordmark lockups with transparent backgrounds, and a 1280×640 social card for the repository.
//
//   node promo/logo.mjs
//
// The mark is a pair of code brackets (the two agents) with the three dots of someone typing
// between them, set on an arc — the hop. Same geometry as the film (index.html: markSVG), and the
// film's palette ("paper" in PALETTES): cinnabar and ink-blue on paper, lightened for dark grounds.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "logo");
mkdirSync(OUT, { recursive: true });

const LIGHT = { a: "#C3402A", b: "#2E5A6C", dot: "#1D1A16", word: "#1D1A16", tile: "#F3EEE5" };
const DARK = { a: "#E0664A", b: "#8DB4C4", dot: "#F3EEE5", word: "#F3EEE5" };
const mark = (c) =>
  `<path d="M21 16 L8 32 L21 48" fill="none" stroke="${c.a}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M43 16 L56 32 L43 48" fill="none" stroke="${c.b}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="23.8" cy="35" r="3.5" fill="${c.dot}"/><circle cx="32" cy="27.5" r="4.9" fill="${c.dot}"/><circle cx="40.2" cy="35" r="3.5" fill="${c.dot}"/>`;
const svg = (body, view = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}">${body}</svg>\n`;
/** The mark on a rounded paper tile, scaled so it keeps the same margin at every size. */
const tile = (radius = 14.4) => `<rect width="64" height="64" rx="${radius}" fill="${LIGHT.tile}"/><g transform="translate(8.3 8.3) scale(0.74)">${mark(LIGHT)}</g>`;

writeFileSync(path.join(OUT, "agenthop-mark.svg"), svg(mark(DARK)));
writeFileSync(path.join(OUT, "agenthop-mark-light.svg"), svg(mark(LIGHT)));
writeFileSync(path.join(OUT, "favicon.svg"), svg(tile()));

// Everything with the wordmark needs the brand face, inlined for the same reason as in the film.
const font = readFileSync(path.join(HERE, "fonts", "Manrope-latin.woff2")).toString("base64");
const page = (w, h, body, bg = "transparent") => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Manrope";font-weight:700;src:url(data:font/woff2;base64,${font}) format("woff2")}
html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}
.lock{display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px}
.word{font:700 var(--fs) "Manrope";letter-spacing:-.03em;line-height:1.34}
</style></head><body>${body}</body></html>`;
const lockup = (c, size, height) => `<div class="lock" style="gap:${Math.round(size * 0.2)}px;--fs:${size}px${height ? `;height:${height}px` : ""}"><svg width="${Math.round(size * 1.15)}" height="${Math.round(size * 1.15)}" viewBox="0 0 64 64" style="overflow:visible;position:relative;top:${Math.round(size * 0.053)}px">${mark(c)}</svg><span class="word" style="color:${c.word}">AgentHop</span></div>`;

const shots = [
  ...[1024, 512, 180].map((n) => ({ file: `agenthop-icon-${n}.png`, w: n, h: n, html: page(n, n, `<svg width="${n}" height="${n}" viewBox="0 0 64 64">${tile()}</svg>`) })),
  ...[32, 16].map((n) => ({ file: `favicon-${n}.png`, w: n, h: n, html: page(n, n, `<svg width="${n}" height="${n}" viewBox="0 0 64 64">${tile(12)}</svg>`) })),
  { file: "agenthop-avatar-1024.png", w: 1024, h: 1024, html: page(1024, 1024, `<svg width="1024" height="1024" viewBox="0 0 64 64"><rect width="64" height="64" fill="${LIGHT.tile}"/><g transform="translate(11.2 11.2) scale(0.65)">${mark(LIGHT)}</g></svg>`) },
  { file: "agenthop-lockup-dark.png", w: 1800, h: 420, html: page(1800, 420, lockup(DARK, 200)) },
  { file: "agenthop-lockup-light.png", w: 1800, h: 420, html: page(1800, 420, lockup(LIGHT, 200)) },
  {
    file: "agenthop-social-1280x640.png", w: 1280, h: 640,
    html: page(1280, 640, `<div style="position:absolute;inset:0;background:radial-gradient(circle at 16% 10%,rgba(195,64,42,.10),transparent 55%),radial-gradient(circle at 86% 92%,rgba(46,90,108,.09),transparent 55%)"></div>
      <div style="position:absolute;left:0;right:0;top:150px">${lockup(LIGHT, 124, 200)}</div>
      <div style="position:absolute;left:0;right:0;top:392px;text-align:center;font:600 42px 'PingFang SC',system-ui;color:#1D1A16;letter-spacing:2px">让你的 Agent 和对方的 Agent 直接对话</div>
      <div style="position:absolute;left:0;right:0;top:470px;text-align:center;font:400 26px 'PingFang SC',system-ui;color:#7B7166;letter-spacing:1px">一个配对码 · 端到端加密 · 不需要公网地址 · 开源</div>`, "#F3EEE5"),
  },
];

const port = 9470;
const dir = mkdtempSync(path.join(tmpdir(), "logo-chrome-"));
const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable");
// Transparent where the page is transparent: the lockups and icons sit on whatever is behind them.
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
const tmp = path.join(dir, "shot.html");
for (const s of shots) {
  writeFileSync(tmp, s.html);
  await send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${pathToFileURL(tmp).href}?${s.file}` });
  for (let i = 0; i < 100; i++) {
    const r = await send("Runtime.evaluate", { expression: `document.readyState === "complete" && document.fonts.check('700 40px "Manrope"')`, returnByValue: true });
    if (r.result.value) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: s.w, height: s.h, scale: 1 } });
  writeFileSync(path.join(OUT, s.file), Buffer.from(data, "base64"));
}
ws.close();
chrome.kill("SIGKILL");
setTimeout(() => rmSync(dir, { recursive: true, force: true }), 300);
console.log(`logo: ${shots.length + 3} files → ${OUT}`);
