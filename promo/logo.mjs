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

// Profile backgrounds: the two agents with the name on the line between them, the direct line the
// film's opening ends on. Paper where the platform puts the profile's text beside the image; ink
// where it lays white text over it (小红书, B站). Each keeps its content inside the part that platform
// never crops or covers.
const PAPER = { ...LIGHT, bg: "#F3EEE5", sub: "#3B352E", muted: "#7B7166", glow: ["rgba(195,64,42,.10)", "rgba(46,90,108,.09)"], grid: "rgba(42,29,16,.07)" };
const INK = { ...DARK, bg: "#1D1A16", sub: "#D9D0C3", muted: "#9D9387", glow: ["rgba(224,102,74,.18)", "rgba(141,180,196,.13)"], grid: "rgba(255,243,227,.06)" };
const CJK = "'PingFang SC','Noto Sans SC',system-ui";
let gid = 0;
/** One of the two agents: three dots in a ring, in that agent's colour. */
const agent = (col, bg, s) => `<div style="width:${s}px;height:${s}px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;gap:${Math.round(s * 0.09)}px;border:${Math.max(2, Math.round(s / 44))}px solid color-mix(in srgb,${col} 60%,transparent);background:color-mix(in srgb,${col} 12%,${bg})">${`<i style="width:${Math.round(s * 0.13)}px;height:${Math.round(s * 0.13)}px;border-radius:50%;background:${col};display:block"></i>`.repeat(3)}</div>`;
/** A dashed stretch of the line, fading towards the name in the middle. The gradient is in user units:
 * a horizontal line has no height, and a bounding-box gradient would leave it unpainted. */
const dash = (len, col, s, towards) => {
  const id = `g${++gid}`, sw = Math.max(3, Math.round(s / 24)), [o0, o1] = towards === "in" ? [1, 0.25] : [0.25, 1];
  return `<svg width="${len}" height="${sw * 2}" style="flex:none;overflow:visible"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${len}" y2="0"><stop offset="0" stop-color="${col}" stop-opacity="${o0}"/><stop offset="1" stop-color="${col}" stop-opacity="${o1}"/></linearGradient></defs><line x1="${sw}" y1="${sw}" x2="${len - sw}" y2="${sw}" stroke="url(#${id})" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${sw * 3.4} ${sw * 2.6}"/></svg>`;
};
/** The banner: glows and the dot grid of the film, the row centred on (cx, cy), text lines under it. */
function banner({ w, h, c, cx, cy, size, lines }) {
  const s = Math.round(size * 1.15), gap = Math.round(size * 0.42), len = Math.round(size * 1.7);
  const row = `${agent(c.a, c.bg, s)}${dash(len, c.a, s, "in")}<div style="display:flex;align-items:center;gap:${Math.round(size * 0.2)}px"><svg width="${Math.round(size * 1.15)}" height="${Math.round(size * 1.15)}" viewBox="0 0 64 64" style="overflow:visible;position:relative;top:${Math.round(size * 0.053)}px">${mark(c)}</svg><span class="word" style="--fs:${size}px;color:${c.word}">AgentHop</span></div>${dash(len, c.b, s, "out")}${agent(c.b, c.bg, s)}`;
  let y = cy + s / 2 + size * 0.5;
  const text = lines.map(([t, px, col, weight = 500, font = CJK]) => { const el = `<div style="position:absolute;left:${cx}px;top:${Math.round(y)}px;transform:translateX(-50%);text-align:center;font:${weight} ${px}px ${font};color:${col};white-space:nowrap">${t}</div>`; y += px * 1.75; return el; }).join("");
  return page(w, h, `<div style="position:absolute;inset:0;background:radial-gradient(circle at 12% 8%,${c.glow[0]},transparent 50%),radial-gradient(circle at 90% 96%,${c.glow[1]},transparent 52%)"></div>
    <div style="position:absolute;inset:0;background-image:radial-gradient(${c.grid} ${size / 40}px,transparent ${size / 34}px);background-size:${Math.round(size * 0.5)}px ${Math.round(size * 0.5)}px"></div>
    <div style="position:absolute;left:${cx}px;top:${cy}px;transform:translate(-50%,-50%);display:flex;align-items:center;gap:${gap}px">${row}</div>${text}`, c.bg);
}
const EN_FONT = "system-ui,-apple-system,'Helvetica Neue',sans-serif";

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
  // X: the profile photo covers the lower left, and up to 60px can go at the top and bottom.
  { file: "banner-x-1500x500.png", w: 1500, h: 500, html: banner({ w: 1500, h: 500, c: PAPER, cx: 820, cy: 200, size: 72, lines: [
    ["Let your agent talk directly to theirs", 32, PAPER.sub, 500, EN_FONT],
    ["One pairing code · End-to-end encrypted · No public IP needed · Open source", 20, PAPER.muted, 400, EN_FONT]] }) },
  // 抖音: shown cropped top and bottom; only the middle band of about 400px is certain.
  { file: "banner-douyin-1125x633.png", w: 1125, h: 633, html: banner({ w: 1125, h: 633, c: PAPER, cx: 562, cy: 250, size: 58, lines: [
    ["让你的 Agent 和对方的 Agent 直接对话", 30, PAPER.sub],
    ["一个配对码 · 端到端加密 · 不需要公网地址 · 开源", 20, PAPER.muted, 400]] }) },
  // 小红书 and B站 lay the name and bio over the image in white, so these are dark, with the content
  // kept to the upper middle.
  { file: "banner-xiaohongshu-1000x800.png", w: 1000, h: 800, html: banner({ w: 1000, h: 800, c: INK, cx: 500, cy: 210, size: 50, lines: [
    ["让你的 Agent 和对方的 Agent 直接对话", 26, INK.sub]] }) },
  { file: "banner-bilibili-3840x1080.png", w: 3840, h: 1080, html: banner({ w: 3840, h: 1080, c: INK, cx: 1920, cy: 430, size: 150, lines: [
    ["让你的 Agent 和对方的 Agent 直接对话", 72, INK.sub],
    ["一个配对码 · 端到端加密 · 不需要公网地址 · 开源", 44, INK.muted, 400]] }) },
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
