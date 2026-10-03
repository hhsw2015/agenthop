#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The skill in both languages: install writes the one the program speaks (see lang.ts).
const skill = readFileSync(join(root, "skill/SKILL.md"), "utf8");
const skillZh = readFileSync(join(root, "skill/SKILL.zh-CN.md"), "utf8");
writeFileSync(
  join(root, "packages/cli/src/skill-text.ts"),
  `export const skillMarkdown = ${JSON.stringify(skill)};\nexport const skillMarkdownZh = ${JSON.stringify(skillZh)};\n`,
);

// The OpenCode bus plugin, embedded in the program like the skill so `install --mcp opencode` can
// write it to ~/.config/opencode/plugin/ with nothing to download. Built here so the committed
// opencode-plugin-text.ts always matches the plugin source.
const pluginOut = join(root, "packages/bus/dist-plugin/agenthop-bus.js");
const pluginBuild = spawnSync(
  "bun",
  ["build", "packages/bus/src/opencode-plugin.ts", "--target=bun", "--format=esm", "--external", "@opencode-ai/plugin", `--outfile=${pluginOut}`],
  { cwd: root, stdio: "inherit" },
);
if (pluginBuild.status !== 0) process.exit(pluginBuild.status ?? 1);
writeFileSync(
  join(root, "packages/cli/src/opencode-plugin-text.ts"),
  `export const opencodePluginJs = ${JSON.stringify(readFileSync(pluginOut, "utf8"))};\n`,
);

// The startup PRESENCE daemon, embedded like the skill/plugin so `install` can write it to ~/.agenthop/presence.mjs
// with nothing to download. It MUST be a NON-compiled bundle (a bun --compile binary exits without a controlling
// terminal; a bun/node script survives), run by the SessionStart hook via bun or node. --target=node so either works.
const presenceOut = join(root, "packages/bus/dist-presence/presence.mjs");
const presenceBuild = spawnSync(
  "bun",
  ["build", "packages/bus/src/presence-entry.ts", "--target=node", "--format=esm", `--outfile=${presenceOut}`],
  { cwd: root, stdio: "inherit" },
);
if (presenceBuild.status !== 0) process.exit(presenceBuild.status ?? 1);
writeFileSync(
  join(root, "packages/cli/src/presence-text.ts"),
  `export const presenceMjs = ${JSON.stringify(readFileSync(presenceOut, "utf8"))};\n`,
);

// --skill-text: regenerate the embedded texts only, without compiling the binaries.
if (process.argv.includes("--skill-text")) process.exit(0);

const targets = [
  ["bun-darwin-arm64", "agenthop-macos-arm64"],
  ["bun-darwin-x64", "agenthop-macos-x64"],
  ["bun-linux-x64", "agenthop-linux-x64"],
  ["bun-linux-arm64", "agenthop-linux-arm64"],
  ["bun-windows-x64", "agenthop-windows-x64.exe"],
];
mkdirSync(join(root, "dist"), { recursive: true });
// The released program is the ENHANCED entry (packages/bus/src/bin.ts): classic agenthop plus the
// session bus (the `mcp` server carries the bus tools) plus the `team` and `bus-bridge` commands. The
// classic packages/cli/src/bin.ts has none of those, so a build of it could not run the bus at all —
// the plugin's `agenthop bus-bridge` would fall through to the classic create-session path.
for (const [target, name] of targets) {
  const result = spawnSync(
    "bun",
    ["build", "packages/bus/src/bin.ts", "--compile", `--target=${target}`, `--outfile=dist/${name}`],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// `agenthop update` refuses a program whose hash is not in here.
const sums = targets
  .map(([, name]) => `${createHash("sha256").update(readFileSync(join(root, "dist", name))).digest("hex")}  ${name}`)
  .join("\n");
writeFileSync(join(root, "dist", "SHA256SUMS"), `${sums}\n`);
console.log(sums);

// Ship the OpenCode bus plugin as a release asset too. It is already embedded in the binary (install
// --mcp opencode writes it), but publishing it is handy for manual installs and transparency. Not in
// SHA256SUMS, which lists only the self-update targets `agenthop update` verifies.
copyFileSync(join(root, "packages/bus/dist-plugin/agenthop-bus.js"), join(root, "dist", "agenthop-bus.js"));
