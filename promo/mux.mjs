// Joins out/video-silent.mp4 (picture only) and out/music.wav into the finished film, at -16 LUFS with a -1.5 dBTP
// ceiling: what most video sites normalise to, so it is neither turned down nor left quiet.
//
//   node promo/mux.mjs    → promo/out/agenthop-宣传片.mp4
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const run = (args) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
};

const measured = run(["-i", path.join(OUT, "music.wav"), "-af", "ebur128", "-f", "null", "-"]);
const integrated = Number(measured.match(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/)[1]);
const gain = -16 - integrated;
const film = path.join(OUT, "agenthop-宣传片.mp4");
run([
  "-y", "-i", path.join(OUT, "video-silent.mp4"), "-i", path.join(OUT, "music.wav"),
  "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.76:attack=1:release=60:level=false`,
  "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-shortest", "-movflags", "+faststart",
  "-metadata", "title=AgentHop 宣传片", film,
]);
const check = run(["-i", film, "-af", "ebur128=peak=true", "-f", "null", "-"]);
const I = check.match(/Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/)[1];
const tp = check.match(/True peak:[\s\S]*?Peak:\s+(-?[\d.]+) dBFS/)?.[1];
console.log(`film: ${film}\nloudness ${I} LUFS, true peak ${tp} dBFS (music was ${integrated} LUFS, +${gain.toFixed(2)} dB)`);
