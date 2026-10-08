// Selftest for the pure arch-review core. IO (git/crypto) is locked by arch-review.integration.selftest.mts.
//   npx tsx packages/bus/src/swarm/arch-review.selftest.mts
import {
  ARCH_AXES, buildImportEdges, candidatePaths, checkDoneEvidence, contractCategory, contractSurfaceManifest,
  extractImports, fileInfo, findCycles, flagBoundaries, ioRootOf, isIoTainted, normalizeSpecifier,
  renderReviewSheet, resolveInSet, zoneOf,
} from "./arch-review.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };

// --- zone classification ---
{
  t("bus source -> bus", zoneOf("packages/bus/src/swarm/herdr.ts") === "bus");
  t("script -> script", zoneOf("scripts/swarm-dispatch.ts") === "script");
  t("selftest -> test (not bus)", zoneOf("packages/bus/src/swarm/herdr.selftest.mts") === "test");
  t(".test.mjs -> test", zoneOf("scripts/swarm-supervisor.test.mjs") === "test");
  t("doc -> doc", zoneOf("docs/swarm/x.md") === "doc");
  t("other -> other", zoneOf("package.json") === "other");
}

// --- AR3: lexically-correct import extraction (TypeScript preprocessor, not a regex) ---
{
  t("named import extracted", extractImports(`import { a } from "./x.js";`)[0] === "./x.js");
  t("export-from extracted", extractImports(`export { a } from "../y.js";`)[0] === "../y.js");
  t("bare import extracted", extractImports(`import "./side.js";`)[0] === "./side.js");
  t("bare import WITHOUT semicolon extracted (AR3)", extractImports(`import "./side.js"\nconst a=1`)[0] === "./side.js");
  t("require extracted", extractImports(`const x = require("node:fs");`)[0] === "node:fs");
  t("dynamic import WITH options extracted (AR3)", extractImports(`await import("./lazy.js", { with: { type: "json" } });`)[0] === "./lazy.js");
  t("multiline named import captured", extractImports(`import {\n a,\n b\n} from "./multi.js";`)[0] === "./multi.js");
  t("commented-out import ignored (AR3)", extractImports(`// import x from "./ghost.js";\nimport y from "./real.js";`).join(",") === "./real.js");
  t("block-commented import ignored (AR3)", extractImports(`/* import x from "./ghost.js"; */ import y from "./real.js";`).join(",") === "./real.js");
  t("import TEXT inside a string literal is NOT a dep (AR3)", extractImports('const s = "import x from \\"./ghost.js\\"";').length === 0);
  t("preimport() is NOT matched as an import (AR3)", extractImports(`preimport();\nimport z from "./z.js";`).join(",") === "./z.js");
  t("a REGEX literal is NOT an import (AR3 round-2)", extractImports(`const re = /import "node:fs"/;`).length === 0);
  t("divide then regex does not fabricate an import (AR3 round-2)", extractImports(`const a = b / c; const d = /x/;`).length === 0);
  t("import x = require(...) captured", extractImports(`import x = require("./eq.js");`)[0] === "./eq.js");
  t("template dynamic import (unresolvable) omitted", extractImports("await import(`./${v}.js`);").length === 0);
}

// --- AR4: IO taint matched on the builtin ROOT (submodules + /promises covered) ---
{
  t("ioRootOf strips node: and submodule", ioRootOf("node:dns/promises") === "dns");
  t("ioRootOf of a relative path is '.'", ioRootOf("./x.js") === ".");
  t("imports node:fs -> tainted", isIoTainted(`import { readFileSync } from "node:fs";`) === true);
  t("imports child_process -> tainted", isIoTainted(`import { execFileSync } from "child_process";`) === true);
  t("node:dns/promises -> tainted (AR4)", isIoTainted(`import dns from "node:dns/promises";`) === true);
  t("node:readline/promises -> tainted (AR4)", isIoTainted(`import { createInterface } from "node:readline/promises";`) === true);
  t("node:http2 -> tainted (AR4)", isIoTainted(`import http2 from "node:http2";`) === true);
  t("fs/promises -> tainted", isIoTainted(`import { readFile } from "fs/promises";`) === true);
  t("node:path alone is not IO-taint", isIoTainted(`import path from "node:path";`) === false);
  t("pure relative import -> not tainted", isIoTainted(`import { foo } from "./pure.js";`) === false);
}

// --- AR5: resolve against the REAL batch files (compiled-suffix swaps added, never forced) ---
{
  const set = new Set([
    "packages/bus/src/swarm/b.ts",
    "packages/bus/src/inbox.ts",
    "scripts/hook.mjs",
  ]);
  t("normalize parent specifier", normalizeSpecifier("packages/bus/src/swarm/a.ts", "../inbox.js") === "packages/bus/src/inbox.js");
  t("normalize bare -> null", normalizeSpecifier("x/a.ts", "node:fs") === null);
  t("explicit .js maps to compatible sources (.js/.ts/.tsx), NO index (AR5)", (() => { const c = candidatePaths("a/b.js"); return c.includes("a/b.ts") && c.includes("a/b.js") && c.includes("a/b.tsx") && !c.some((x) => x.includes("index")); })());
  t("explicit .mjs maps ONLY to .mjs/.mts (AR5 round-2)", JSON.stringify(candidatePaths("a/b.mjs")) === JSON.stringify(["a/b.mjs", "a/b.mts"]));
  t("extensionless path gets source exts + an index candidate", candidatePaths("a/b").includes("a/b.ts") && candidatePaths("a/b").includes("a/b/index.ts"));
  t("sibling .js resolves to the .ts in the set", resolveInSet("packages/bus/src/swarm/a.ts", "./b.js", set) === "packages/bus/src/swarm/b.ts");
  t("parent .js resolves", resolveInSet("packages/bus/src/swarm/a.ts", "../inbox.js", set) === "packages/bus/src/inbox.ts");
  t("a real .mjs resolves to itself, NOT forced to .mts (AR5)", resolveInSet("scripts/a.ts", "./hook.mjs", set) === "scripts/hook.mjs");
  t("bare specifier -> null", resolveInSet("scripts/a.ts", "node:fs", set) === null);
  t("target outside the set -> null (never fabricated)", resolveInSet("packages/bus/src/swarm/a.ts", "./missing.js", set) === null);
  // AR5 round-2: an out-of-batch .mjs must NOT mis-match an in-batch .ts or dep/index.mts
  t("out-of-batch .mjs does NOT mis-map to an in-batch .ts/index (AR5 round-2)", resolveInSet("packages/bus/src/swarm/a.ts", "./dep.mjs", new Set(["packages/bus/src/swarm/dep.ts", "packages/bus/src/swarm/dep/index.mts"])) === null);
  // AR5 round-2: `..` above the repo root returns null, never folded back inside
  t("'..' above repo root -> null (no fold-back) (AR5 round-2)", normalizeSpecifier("a/b.ts", "../../../x.js") === null);
  t("exactly-to-root traversal still resolves", normalizeSpecifier("packages/bus/src/swarm/a.ts", "../../../../scripts/x.js") === "scripts/x.js");
}

// --- import edges: only kept when both ends are in the set ---
{
  const files = [
    fileInfo("packages/bus/src/swarm/a.ts", `import { b } from "./b.js"; import { x } from "./missing.js";`),
    fileInfo("packages/bus/src/swarm/b.ts", `export const b = 1;`),
  ];
  const edges = buildImportEdges(files);
  t("edge a->b kept", edges.length === 1 && edges[0]!.from.endsWith("a.ts") && edges[0]!.to.endsWith("b.ts"));
  t("edge to a file outside the set is ABSENT (never a pass)", !edges.some((e) => e.to.endsWith("missing.ts")));
}

// --- boundary candidate flags ---
{
  const pureImportsIo = [
    fileInfo("packages/bus/src/swarm/pure.ts", `import { w } from "./io.js";`),
    fileInfo("packages/bus/src/swarm/io.ts", `import { readFileSync } from "node:fs"; export const w = 1;`),
  ];
  t("pure module importing an IO module is flagged", flagBoundaries(pureImportsIo, buildImportEdges(pureImportsIo)).some((f) => f.kind === "pure-imports-io"));

  // AR5: a bus module importing a real .mjs SCRIPT is collected, resolved, and flagged
  const busImportsMjsScript = [
    fileInfo("packages/bus/src/swarm/c.ts", `import "../../../../scripts/hook.mjs";`),
    fileInfo("scripts/hook.mjs", `export const s = 1;`),
  ];
  t("bus importing a .mjs script (wrong direction) is flagged (AR5)", flagBoundaries(busImportsMjsScript, buildImportEdges(busImportsMjsScript)).some((f) => f.kind === "bus-imports-script"));

  const clean = [
    fileInfo("packages/bus/src/swarm/p1.ts", `import { p2 } from "./p2.js";`),
    fileInfo("packages/bus/src/swarm/p2.ts", `export const p2 = 1;`),
  ];
  t("a clean pure->pure edge raises no flag", flagBoundaries(clean, buildImportEdges(clean)).length === 0);

  // allowed directions must NOT flag
  const allowed = [
    fileInfo("scripts/driver.ts", `import { c } from "../packages/bus/src/swarm/core.js";`),
    fileInfo("packages/bus/src/swarm/core.ts", `export const c = 1;`),
  ];
  t("script->bus raises no flag (allowed)", !flagBoundaries(allowed, buildImportEdges(allowed)).some((f) => f.kind === "bus-imports-script"));
}

// --- cycle detection ---
{
  const cyc = [
    fileInfo("packages/bus/src/swarm/a.ts", `import { b } from "./b.js";`),
    fileInfo("packages/bus/src/swarm/b.ts", `import { a } from "./a.js";`),
  ];
  const edges = buildImportEdges(cyc);
  t("a<->b cycle detected", findCycles(edges).length >= 1);
  t("cycle surfaces as an import-cycle flag", flagBoundaries(cyc, edges).some((f) => f.kind === "import-cycle"));
  const acyclic = buildImportEdges([
    fileInfo("packages/bus/src/swarm/a.ts", `import { b } from "./b.js";`),
    fileInfo("packages/bus/src/swarm/b.ts", `export const b = 1;`),
  ]);
  t("acyclic graph has no cycle", findCycles(acyclic).length === 0);
}

// --- C11 done-evidence ---
{
  const flags = checkDoneEvidence([
    { node: "n1", sha: "2df0b86" },
    { node: "n2" },
    { node: "n3", sha: "  " },
    { node: "n4", sha: "not-a-sha-zz" },
    { node: "n5", sha: "436a1cfd12859a0a2fa3363ec6e22fc852004d1c" },
  ]);
  t("valid short SHA ok", flags[0]!.ok === true);
  t("missing SHA -> NOT ok", flags[1]!.ok === false && flags[1]!.reason.includes("no SHA"));
  t("blank SHA -> NOT ok", flags[2]!.ok === false);
  t("non-hex -> NOT ok", flags[3]!.ok === false && flags[3]!.reason.includes("not a commit SHA"));
  t("valid long SHA ok", flags[4]!.ok === true);
}

// --- contract surface manifest (AR2: null = unavailable, distinct from an empty-file hash) ---
{
  t("CLAUDE.md -> invariant-doc", contractCategory("CLAUDE.md") === "invariant-doc");
  t("memory path -> invariant-doc", contractCategory("docs/memory/x.md") === "invariant-doc");
  t("spec md -> spec-doc", contractCategory("docs/swarm/projection-schema.md") === "spec-doc");
  t("ts -> shared-type", contractCategory("packages/bus/src/inbox.ts") === "shared-type");
  const m = contractSurfaceManifest([{ path: "CLAUDE.md", sha256: "abc" }, { path: "docs/gone.md", sha256: null }]);
  t("present file keeps its hash", m[0]!.category === "invariant-doc" && m[0]!.sha256 === "abc");
  t("unavailable file keeps null (not an empty hash)", m[1]!.sha256 === null && m[1]!.category === "spec-doc");
}

// --- review sheet rendering (deterministic; all axes + sections present) ---
{
  const sheet = renderReviewSheet({
    branch: "feat/x", base: "c3439cd", head: "deadbee", reviewer: "codex 01a0ead5", author: "bus-pen d7f6c917",
    commits: ["deadbee feat: a"], changedFiles: ["packages/bus/src/swarm/a.ts"],
    manifest: [
      { path: "CLAUDE.md", sha256: "abcdef0123456789aa", category: "invariant-doc" },
      { path: "docs/gone.md", sha256: null, category: "spec-doc" },
    ],
    edges: [{ from: "packages/bus/src/swarm/a.ts", to: "packages/bus/src/swarm/b.ts", fromZone: "bus", toZone: "bus" }],
    flags: [{ kind: "pure-imports-io", detail: "a imports b" }],
    doneFlags: [{ node: "n1", ok: false, reason: "done claim carries no SHA" }],
  });
  t("header carries branch/head/base", sheet.includes("feat/x") && sheet.includes("c3439cd") && sheet.includes("deadbee"));
  t("every axis rendered", ARCH_AXES.every((a) => sheet.includes(a.title)));
  t("C11 axis present", sheet.includes("32-eval C11"));
  t("REMAIN blocking section present", sheet.includes("## REMAIN (open, blocking)"));
  t("a failing done flag is shown in bold NO", sheet.includes("**NO**"));
  t("an unavailable contract renders (unavailable), not a hash (AR2)", sheet.includes("**(unavailable)**"));
  const again = renderReviewSheet({
    branch: "feat/x", base: "c3439cd", head: "deadbee", reviewer: "codex 01a0ead5", author: "bus-pen d7f6c917",
    commits: ["deadbee feat: a"], changedFiles: ["packages/bus/src/swarm/a.ts"],
    manifest: [
      { path: "CLAUDE.md", sha256: "abcdef0123456789aa", category: "invariant-doc" },
      { path: "docs/gone.md", sha256: null, category: "spec-doc" },
    ],
    edges: [{ from: "packages/bus/src/swarm/a.ts", to: "packages/bus/src/swarm/b.ts", fromZone: "bus", toZone: "bus" }],
    flags: [{ kind: "pure-imports-io", detail: "a imports b" }],
    doneFlags: [{ node: "n1", ok: false, reason: "done claim carries no SHA" }],
  });
  t("deterministic (same input -> same output)", sheet === again);
}

console.log("all arch-review selftests passed");
