// A copy of the finished film small enough for the GitHub README. A video plays inline there only when it is
// uploaded as an attachment, and on a free plan an attachment can be at most 10 MB. So: 30 fps, two passes at
// a bitrate worked out from the film's length, and the grain smoothed away first, since at this rate the
// encoder would otherwise spend its bits redrawing noise. The file's name is shown above the player, and GitHub
// drops whatever in it is not ASCII, hence the English one.
//
//   node promo/github.mjs [--lang en]    → promo/out[/en]/AgentHop.mp4
import { spawnSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EN = process.argv.join(" ").includes("--lang en");
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out", ...(EN ? ["en"] : []));
const LIMIT = 10e6; // bytes: the stricter reading of "10 MB"
const AUDIO_KBPS = 96;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

const film = path.join(OUT, EN ? "agenthop-promo.mp4" : "agenthop-宣传片.mp4");
const copy = path.join(OUT, "AgentHop.mp4");
const seconds = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", film]));
// Aim at 92% of the limit: the average lands a little over what x264 is asked for, and the container adds some.
const videoKbps = Math.floor(((LIMIT * 0.92 * 8) / seconds / 1000 - AUDIO_KBPS) / 1.04);
const log = path.join(OUT, "github-pass");
const encode = [
  "-hide_banner", "-loglevel", "error", "-y", "-i", film, "-vf", "fps=30,hqdn3d=3:3:6:6,format=yuv420p",
  "-c:v", "libx264", "-preset", "slower", "-tune", "animation", "-b:v", `${videoKbps}k`, "-passlogfile", log,
];
run("ffmpeg", [...encode, "-pass", "1", "-an", "-f", "mp4", "/dev/null"]);
run("ffmpeg", [...encode, "-pass", "2", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-movflags", "+faststart", copy]);
for (const f of [`${log}-0.log`, `${log}-0.log.mbtree`]) rmSync(f, { force: true });
const size = statSync(copy).size;
if (size > LIMIT) throw new Error(`${copy} is ${size} bytes, over the ${LIMIT}-byte limit`);
console.log(`github copy: ${copy}\n${(size / 1e6).toFixed(2)} MB, video ${videoKbps} kbps, audio ${AUDIO_KBPS} kbps`);
