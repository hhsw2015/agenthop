#!/usr/bin/env tsx
// swarm-arch-review — build the cross-cutting architecture-integrity review PACK for a batch, and render the
// S19-style review sheet an independent (cross-family, codex-seat) reviewer fills. REMAIN blocks the batch.
//
//   npx tsx scripts/swarm-arch-review.ts --base <sha> --head <sha> [--branch b] [--reviewer r] [--author a]
//                                        [--out docs/swarm/arch-integrity-review-sheet.md]
//                                        [--done node:sha,node2:sha2] [--repo .]
//
// The tool collects inputs (diff set + hashed contract surface + import map + C11 done-evidence) and FLAGS
// candidates; it never pronounces a verdict. See packages/bus/src/swarm/arch-review.ts for the why.
import { writeFileSync } from "node:fs";
import { collectArchReviewPack, type DoneClaim } from "../packages/bus/src/swarm/arch-review.js";

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const repo = arg("repo", process.cwd());
const base = arg("base");
const head = arg("head", "HEAD");
if (!base) {
  console.error("usage: swarm-arch-review --base <sha> [--head <sha>] [--branch b] [--reviewer r] [--out f] [--done node:sha,...]");
  process.exit(2);
}
const branch = arg("branch", "feat/arch-integrity-review");
const reviewer = arg("reviewer", "codex 01a0ead5");
const author = arg("author", "bus-pen");
const out = arg("out", "docs/swarm/arch-integrity-review-sheet.md");
const doneClaims: DoneClaim[] = arg("done")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const idx = s.lastIndexOf(":");
    return idx > 0 ? { node: s.slice(0, idx), sha: s.slice(idx + 1) } : { node: s };
  });

const pack = collectArchReviewPack({ repo, base, head, branch, reviewer, author, doneClaims });
writeFileSync(`${repo}/${out}`, pack.sheet);

const blocking = pack.doneFlags.filter((d) => !d.ok).length;
console.error(
  `arch-review pack: ${pack.commits.length} commit(s), ${pack.changedFiles.length} file(s), ` +
    `${pack.edges.length} edge(s), ${pack.flags.length} candidate flag(s), ` +
    `${blocking} done-claim(s) without a SHA. Sheet -> ${out}`,
);
for (const f of pack.flags) console.error(`  flag: ${f.kind} — ${f.detail}`);
