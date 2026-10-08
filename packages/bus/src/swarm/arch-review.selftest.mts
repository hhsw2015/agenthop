// Selftest for the pure arch-review core. IO wrappers (git/fs/crypto) are exercised by live runs.
//   npx tsx packages/bus/src/swarm/arch-review.selftest.mts
import {
  ARCH_AXES, buildImportEdges, checkDoneEvidence, contractCategory, contractSurfaceManifest, extractImports,
  fileInfo, findCycles, flagBoundaries, isIoTainted, renderReviewSheet, resolveSpecifier, stripComments, zoneOf,
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

// --- comment stripping + import extraction (the edge the import map is built from) ---
{
  t("static import extracted", extractImports(`import { a } from "./x.js";`)[0] === "./x.js");
  t("export-from extracted", extractImports(`export { a } from "../y.js";`)[0] === "../y.js");
  t("bare import extracted", extractImports(`import "./side.js";`)[0] === "./side.js");
  t("require extracted", extractImports(`const x = require("node:fs");`)[0] === "node:fs");
  t("dynamic import extracted", extractImports(`await import("./lazy.js");`)[0] === "./lazy.js");
  t("multi-line import specifier captured", extractImports(`import {\n a,\n b\n} from "./multi.js";`)[0] === "./multi.js");
  t("commented-out import ignored", extractImports(`// import x from "./ghost.js";\nimport y from "./real.js";`).join(",") === "./real.js");
  t("block-commented import ignored", extractImports(`/* import x from "./ghost.js"; */ import y from "./real.js";`).join(",") === "./real.js");
  t("URL in a line comment is not eaten as code", stripComments(`const u = "http://x"; // note http://y`).includes("http://x"));
}

// --- IO taint (direct node-builtin import) ---
{
  t("imports node:fs -> tainted", isIoTainted(`import { readFileSync } from "node:fs";`) === true);
  t("imports child_process -> tainted", isIoTainted(`import { execFileSync } from "child_process";`) === true);
  t("pure module -> not tainted", isIoTainted(`import { foo } from "./pure.js";`) === false);
  t("node:path alone is not IO-taint (not a side-effecting builtin)", isIoTainted(`import path from "node:path";`) === false);
}

// --- specifier resolution (ESM .js specifier -> .ts source; bare -> null) ---
{
  t("sibling .js -> .ts", resolveSpecifier("packages/bus/src/swarm/a.ts", "./b.js") === "packages/bus/src/swarm/b.ts");
  t("parent dir resolves", resolveSpecifier("packages/bus/src/swarm/a.ts", "../inbox.js") === "packages/bus/src/inbox.ts");
  t(".mjs -> .mts", resolveSpecifier("scripts/a.ts", "./b.mjs") === "scripts/b.mts");
  t("bare specifier -> null (external, not an internal edge)", resolveSpecifier("scripts/a.ts", "node:fs") === null);
  t("package specifier -> null", resolveSpecifier("scripts/a.ts", "@opencode-ai/plugin") === null);
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
  const flags = flagBoundaries(pureImportsIo, buildImportEdges(pureImportsIo));
  t("pure module importing an IO module is flagged", flags.some((f) => f.kind === "pure-imports-io"));

  const busImportsScript = [
    fileInfo("packages/bus/src/swarm/c.ts", `import { s } from "../../../../scripts/tool.js";`),
    fileInfo("scripts/tool.ts", `export const s = 1;`),
  ];
  const f2 = flagBoundaries(busImportsScript, buildImportEdges(busImportsScript));
  t("bus importing a script (wrong direction) is flagged", f2.some((f) => f.kind === "bus-imports-script"));

  const clean = [
    fileInfo("packages/bus/src/swarm/p1.ts", `import { p2 } from "./p2.js";`),
    fileInfo("packages/bus/src/swarm/p2.ts", `export const p2 = 1;`),
  ];
  t("a clean pure->pure edge raises no flag", flagBoundaries(clean, buildImportEdges(clean)).length === 0);
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

// --- contract surface manifest ---
{
  t("CLAUDE.md -> invariant-doc", contractCategory("CLAUDE.md") === "invariant-doc");
  t("memory path -> invariant-doc", contractCategory("docs/memory/x.md") === "invariant-doc");
  t("spec md -> spec-doc", contractCategory("docs/swarm/projection-schema.md") === "spec-doc");
  t("ts -> shared-type", contractCategory("packages/bus/src/inbox.ts") === "shared-type");
  const m = contractSurfaceManifest([{ path: "CLAUDE.md", sha256: "abc" }, { path: "packages/bus/src/inbox.ts", sha256: "def" }]);
  t("manifest categorizes + passes the hash through", m[0]!.category === "invariant-doc" && m[1]!.sha256 === "def");
}

// --- review sheet rendering (deterministic; all axes + sections present) ---
{
  const sheet = renderReviewSheet({
    branch: "feat/x", base: "c3439cd", head: "deadbee", reviewer: "codex 01a0ead5", author: "bus-pen d7f6c917",
    commits: ["deadbee feat: a"], changedFiles: ["packages/bus/src/swarm/a.ts"],
    manifest: [{ path: "CLAUDE.md", sha256: "abcdef0123456789aa", category: "invariant-doc" }],
    edges: [{ from: "packages/bus/src/swarm/a.ts", to: "packages/bus/src/swarm/b.ts", fromZone: "bus", toZone: "bus" }],
    flags: [{ kind: "pure-imports-io", detail: "a imports b" }],
    doneFlags: [{ node: "n1", ok: false, reason: "done claim carries no SHA" }],
  });
  t("header carries branch/head/base", sheet.includes("feat/x") && sheet.includes("c3439cd") && sheet.includes("deadbee"));
  t("every axis rendered", ARCH_AXES.every((a) => sheet.includes(a.title)));
  t("C11 axis present", sheet.includes("32-eval C11"));
  t("REMAIN blocking section present", sheet.includes("## REMAIN (open, blocking)"));
  t("a failing done flag is shown in bold NO", sheet.includes("**NO**"));
  t("deterministic (same input -> same output)", sheet === renderReviewSheet({
    branch: "feat/x", base: "c3439cd", head: "deadbee", reviewer: "codex 01a0ead5", author: "bus-pen d7f6c917",
    commits: ["deadbee feat: a"], changedFiles: ["packages/bus/src/swarm/a.ts"],
    manifest: [{ path: "CLAUDE.md", sha256: "abcdef0123456789aa", category: "invariant-doc" }],
    edges: [{ from: "packages/bus/src/swarm/a.ts", to: "packages/bus/src/swarm/b.ts", fromZone: "bus", toZone: "bus" }],
    flags: [{ kind: "pure-imports-io", detail: "a imports b" }],
    doneFlags: [{ node: "n1", ok: false, reason: "done claim carries no SHA" }],
  }));
}

console.log("all arch-review selftests passed");
