// A sheet that puts every palette side by side on the same frames of the film, for choosing one.
//
//   node promo/palettes.mjs [--times 28.5,33.5,46,117]   → promo/out/配色方案.png
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const i = args.indexOf("--times");
const TIMES = (i >= 0 ? args[i + 1] : "28.5,33.5,46,117").split(",").map(Number);
const still = (t, id) => path.join(OUT, "stills", `t${t.toFixed(2).padStart(6, "0")}-${id}.png`);

const render = (id) => {
  const r = spawnSync("node", [path.join(HERE, "render.mjs"), "--stills", TIMES.join(","), "--palette", id], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
render("cinnabar");
const palettes = JSON.parse(readFileSync(path.join(OUT, "palettes.json"), "utf8"));
for (const id of Object.keys(palettes)) if (id !== "cinnabar") render(id);

const FW = 480, FH = 270, LABEL = 250, GAP = 14, PAD = 30;
const width = PAD * 2 + LABEL + TIMES.length * (FW + GAP);
const height = PAD * 2 + Object.keys(palettes).length * (FH + GAP);
const swatch = (c) => `<i style="background:${c}"></i>`;
const rows = Object.entries(palettes).map(([id, p], n) => `<div class="row">
  <div class="label"><b>${n + 1}. ${p.name}</b><span>${p.note}</span><div class="sw">${[p.bg, p.a, p.b, p.you, p.text].map(swatch).join("")}</div><div class="grad" style="background:linear-gradient(90deg in oklab,${p.g.join(",")})"></div><code>${id}</code></div>
  ${TIMES.map((t) => `<img src="${pathToFileURL(still(t, id)).href}">`).join("")}</div>`).join("");
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#e9e6df;font-family:"PingFang SC",system-ui;padding:${PAD}px;width:${width}px;box-sizing:border-box}
.row{display:flex;gap:${GAP}px;margin-bottom:${GAP}px;align-items:stretch}
.label{width:${LABEL}px;flex:none;display:flex;flex-direction:column;justify-content:center;gap:8px;color:#1d1b18}
.label b{font-size:30px}.label span{font-size:17px;color:#5d574f}.label code{font:14px Menlo;color:#8a8378}
.sw{display:flex;gap:6px;margin-top:4px}.sw i{width:30px;height:30px;border-radius:7px;display:block;box-shadow:0 0 0 1px rgba(0,0,0,.12)}
.grad{height:10px;border-radius:5px;width:174px}
img{width:${FW}px;height:${FH}px;border-radius:8px;display:block;box-shadow:0 2px 10px rgba(0,0,0,.18)}
</style><body>${rows}</body>`;
const dir = mkdtempSync(path.join(tmpdir(), "palettes-"));
const page = path.join(dir, "sheet.html");
writeFileSync(page, html);
const target = path.join(OUT, "配色方案.png");
const r = spawnSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-color-profile=srgb", `--user-data-dir=${dir}`, `--window-size=${width},${height}`, `--screenshot=${target}`, "--allow-file-access-from-files", pathToFileURL(page).href], { stdio: "ignore" });
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`palettes: ${Object.keys(palettes).length} → ${target}`);
