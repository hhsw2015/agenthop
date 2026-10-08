// Integration selftest for the IO layer: the pack is a function of the SHA, NOT the working tree (round-1 AR1),
// and a path absent at head is UNAVAILABLE, not an empty-file hash (AR2). Uses a throwaway git repo.
//   npx tsx packages/bus/src/swarm/arch-review.integration.selftest.mts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectArchReviewPack, sha256 } from "./arch-review.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };
const g = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const repo = mkdtempSync(join(tmpdir(), "arch-review-it-"));
try {
  g(repo, ["init", "-q"]);
  g(repo, ["config", "user.email", "t@t"]);
  g(repo, ["config", "user.name", "t"]);
  g(repo, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, "packages/bus/src/swarm"), { recursive: true });

  // base: pure.ts imports pure dep.ts (no IO anywhere)
  writeFileSync(join(repo, "packages/bus/src/swarm/pure.ts"), `import { w } from "./dep.js";\nexport const p = w;\n`);
  writeFileSync(join(repo, "packages/bus/src/swarm/dep.ts"), `export const w = 1;\n`);
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "base"]);
  const base = g(repo, ["rev-parse", "HEAD"]).trim();

  // head: touch BOTH files so both are in the diff; dep is STILL pure at head (the committed truth)
  writeFileSync(join(repo, "packages/bus/src/swarm/pure.ts"), `// head\nimport { w } from "./dep.js";\nexport const p = w;\n`);
  const depAtHead = `export const w = 2;\n`;
  writeFileSync(join(repo, "packages/bus/src/swarm/dep.ts"), depAtHead);
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "head still pure"]);
  const head = g(repo, ["rev-parse", "HEAD"]).trim();

  // DIRTY the working tree AFTER head: dep now imports node:fs (uncommitted). Must NOT affect the pack.
  writeFileSync(join(repo, "packages/bus/src/swarm/dep.ts"), `import { readFileSync } from "node:fs";\nexport const w = 3;\n`);

  const pack = collectArchReviewPack({
    repo, base, head, branch: "b", reviewer: "r", author: "a",
    contractPaths: ["packages/bus/src/swarm/dep.ts", "docs/none.md"],
  });

  t("AR1: the pure->dep edge is present (analysis actually ran)", pack.edges.some((e) => e.from.endsWith("pure.ts") && e.to.endsWith("dep.ts")));
  t("AR1: the DIRTY working-tree node:fs import does NOT appear (read from head object)", !pack.flags.some((f) => f.kind === "pure-imports-io"));
  t("AR1: contract hash is of the HEAD content, not the dirty tree", pack.manifest.find((r) => r.path.endsWith("dep.ts"))!.sha256 === sha256(depAtHead));

  const none = pack.manifest.find((r) => r.path === "docs/none.md")!;
  t("AR2: a path absent at head is UNAVAILABLE (null), not an empty-string hash", none.sha256 === null && none.sha256 !== sha256(""));
  t("AR2: unavailableContracts lists it", pack.unavailableContracts.includes("docs/none.md"));

  // a committed EMPTY file still hashes normally (empty != unavailable)
  writeFileSync(join(repo, "packages/bus/src/swarm/empty.ts"), ``);
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "add empty"]);
  const head2 = g(repo, ["rev-parse", "HEAD"]).trim();
  const pack2 = collectArchReviewPack({
    repo, base: head, head: head2, branch: "b", reviewer: "r", author: "a",
    contractPaths: ["packages/bus/src/swarm/empty.ts"],
  });
  t("AR2: a real empty file hashes normally (not unavailable)", pack2.manifest[0]!.sha256 === sha256(""));

  // AR2 round-2: a DIRECTORY (git tree object) at the contract path is unavailable, not a hashed tree listing
  mkdirSync(join(repo, "docs/adir"), { recursive: true });
  writeFileSync(join(repo, "docs/adir/inner.md"), "inner\n");
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "add dir"]);
  const head3 = g(repo, ["rev-parse", "HEAD"]).trim();
  const pack3 = collectArchReviewPack({
    repo, base: head2, head: head3, branch: "b", reviewer: "r", author: "a",
    contractPaths: ["docs/adir"],
  });
  t("AR2: a directory object is unavailable, NOT a hashed tree listing (round-2)", pack3.manifest[0]!.sha256 === null && pack3.unavailableContracts.includes("docs/adir"));

  console.log("all arch-review integration selftests passed");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
