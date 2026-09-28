// Renders promo/index.html frame by frame in headless Chrome and encodes it with ffmpeg.
//
//   node promo/render.mjs --stills 3,10.5,24     PNGs of single frames, for checking the picture
//   node promo/render.mjs [--fps 60] [--workers 4] [--from 0 --to 90]
//   node promo/render.mjs --cover                the covers, 16:9 and 3:4 (Chinese only)
//   --palette <id>                               any palette from PALETTES in index.html
//   --lang en                                    the English cut; everything goes to out/en
//
// Every frame is a pure function of time (the page exposes seek(t)), so frames can be rendered
// in any order and split across several browsers, then joined without a seam.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const EN = opt("lang", "zh") === "en";
const OUT = path.join(HERE, "out", ...(EN && !args.includes("--cover") ? ["en"] : []));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = Number(opt("fps", 60));
const WORKERS = Number(opt("workers", 4));
const PALETTE = opt("palette", "");
const EXTRA = args.includes("--measure") ? "&measure" : "";
mkdirSync(OUT, { recursive: true });

class Browser {
  static async launch(port) {
    const dir = mkdtempSync(path.join(tmpdir(), "promo-chrome-"));
    const proc = spawn(CHROME, [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
      "--hide-scrollbars", "--mute-audio", "--force-color-profile=srgb", "--font-render-hinting=none",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--window-size=1920,1080", "about:blank",
    ], { stdio: "ignore" });
    let targets;
    for (let i = 0; i < 100; i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = targets.find((t) => t.type === "page");
    const b = new Browser(proc, dir, page.webSocketDebuggerUrl);
    await b.open();
    return b;
  }
  constructor(proc, dir, url) { this.proc = proc; this.dir = dir; this.url = url; this.id = 0; this.waiting = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = this.waiting.get(m.id); if (w) { this.waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); } };
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  async load(query = "", width = 1920, height = 1080) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send("Page.enable");
    await this.send("Page.navigate", { url: `${pathToFileURL(path.join(HERE, "index.html")).href}?render${PALETTE ? `&palette=${PALETTE}` : ""}${EN ? "&lang=en" : ""}${EXTRA}${query}` });
    for (let i = 0; i < 200; i++) {
      try {
        if (await this.eval("window.__ready === true")) {
          // A fallback face would not fail anything; it would just quietly put the wrong wordmark in every frame.
          if (!(await this.eval("window.__brandFont === true"))) throw new Error("brand font (Manrope) did not load");
          return;
        }
      } catch (error) { if (/brand font/.test(error.message)) throw error; }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("page never became ready");
  }
  async frame(t) {
    await this.eval(`seek(${t})`);
    const { data } = await this.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    return Buffer.from(data, "base64");
  }
  close() { this.ws.close(); this.proc.kill("SIGKILL"); setTimeout(() => rmSync(this.dir, { recursive: true, force: true }), 500); }
}

function encoder(file, fps) {
  const ff = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-g", String(fps * 2), "-movflags", "+faststart", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
  const write = (buf) => new Promise((resolve) => (ff.stdin.write(buf) ? resolve() : ff.stdin.once("drain", resolve)));
  return { write, end: () => { ff.stdin.end(); return done; } };
}

if (args.includes("--cover")) {
  const b = await Browser.launch(9421);
  for (const [kind, width, height, name] of [["16x9", 1920, 1080, "agenthop-封面.png"], ["3x4", 1080, 1440, "agenthop-封面-竖版.png"]]) {
    await b.load(`&cover=${kind}`, width, height);
    const { data } = await b.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  }
  b.close();
  console.log(`covers → ${OUT}`);
  process.exit(0);
}

if (args.includes("--stills")) {
  const times = opt("stills", "").split(",").filter(Boolean).map(Number);
  const b = await Browser.launch(9420);
  await b.load();
  mkdirSync(path.join(OUT, "stills"), { recursive: true });
  for (const t of times) writeFileSync(path.join(OUT, "stills", `t${t.toFixed(2).padStart(6, "0")}${PALETTE ? `-${PALETTE}` : ""}.png`), await b.frame(t));
  writeFileSync(path.join(OUT, "cues.json"), JSON.stringify({ duration: await b.eval("window.__meta.DUR"), cues: await b.eval("window.__cues") }));
  writeFileSync(path.join(OUT, "palettes.json"), JSON.stringify(await b.eval("window.__meta.palettes"), null, 1));
  b.close();
  console.log(`stills: ${times.length} → ${path.join(OUT, "stills")}`);
  process.exit(0);
}

// The film's length is whatever the page says it is.
const DURATION = Number(readFileSync(path.join(HERE, "index.html"), "utf8").match(/const DUR = ([\d.]+)/)[1]);
const from = Number(opt("from", 0)), to = Number(opt("to", DURATION));
const total = Math.round((to - from) * FPS);
const chunk = Math.ceil(total / WORKERS);
const started = Date.now();
let doneFrames = 0;
const parts = [];
await Promise.all(Array.from({ length: WORKERS }, async (_, k) => {
  const a = k * chunk, b = Math.min(total, a + chunk);
  if (a >= b) return;
  const file = path.join(OUT, `part-${k}.mp4`);
  parts[k] = file;
  const browser = await Browser.launch(9430 + k);
  await browser.load();
  if (k === 0) writeFileSync(path.join(OUT, "cues.json"), JSON.stringify({ duration: await browser.eval("window.__meta.DUR"), cues: await browser.eval("window.__cues") }));
  const enc = encoder(file, FPS);
  for (let i = a; i < b; i++) {
    await enc.write(await browser.frame(from + i / FPS));
    doneFrames++;
    if (doneFrames % 300 === 0) {
      const s = (Date.now() - started) / 1000;
      console.log(`${doneFrames}/${total} frames, ${(doneFrames / s).toFixed(1)} fps, ~${Math.round((total - doneFrames) / (doneFrames / s))} s left`);
    }
  }
  await enc.end();
  browser.close();
}));
writeFileSync(path.join(OUT, "parts.txt"), parts.filter(Boolean).map((p) => `file '${p}'`).join("\n"));
await new Promise((resolve, reject) => {
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(OUT, "parts.txt"), "-c", "copy", "-movflags", "+faststart", path.join(OUT, "video-silent.mp4")], { stdio: "inherit" });
  ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`concat exited ${code}`))));
});
for (const p of parts.filter(Boolean)) rmSync(p, { force: true });
console.log(`video: ${path.join(OUT, "video-silent.mp4")} (${total} frames in ${Math.round((Date.now() - started) / 1000)} s)`);
