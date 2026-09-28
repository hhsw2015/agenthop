#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// --skill-text: regenerate skill-text.ts only, without compiling the binaries.
if (process.argv.includes("--skill-text")) process.exit(0);

const targets = [
  ["bun-darwin-arm64", "agenthop-macos-arm64"],
  ["bun-darwin-x64", "agenthop-macos-x64"],
  ["bun-linux-x64", "agenthop-linux-x64"],
  ["bun-linux-arm64", "agenthop-linux-arm64"],
  ["bun-windows-x64", "agenthop-windows-x64.exe"],
];
mkdirSync(join(root, "dist"), { recursive: true });
for (const [target, name] of targets) {
  const result = spawnSync(
    "bun",
    ["build", "packages/cli/src/bin.ts", "--compile", `--target=${target}`, `--outfile=dist/${name}`],
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
