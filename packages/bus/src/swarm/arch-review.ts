// Architecture-integrity review TOOLING (P1③ / R22, S14 T5-3).
//
// WHY THIS EXISTS: every increment PR is locally reasonable, yet the MERGED architecture drifts — a pure
// module quietly gains IO, one concern gets solved twice, two increments assume incompatible shapes of a
// shared entity. A per-PR correctness review never sees it, because the drift only appears ACROSS merges.
// This module is the TOOLING that packages a batch's cross-cutting review INPUTS for an independent
// (cross-family, codex-seat) reviewer: the diff set, the contract surface (hashed, so drift is detectable),
// a who-imports-whom import map with candidate boundary flags, and the 32-eval C11 "is every `done` bound to
// SHA evidence" check. It then renders the S19-style review sheet the reviewer fills; REMAIN blocks the batch.
//
// THE TOOL NEVER PRONOUNCES A VERDICT. A candidate flag is EVIDENCE for the reviewer, not a finding — the
// import map is built from the diff'd files alone, so an edge to a file outside the batch is simply absent,
// never a pass. Correctness is the reviewer's; this is collection + rendering only.
//
// RESULTS ARE A FUNCTION OF THE SHA, NOT THE WORKING TREE (round-1 AR1): every file's content is read from
// the git object at `head` via `git show <head>:<path>`, so a dirty tree or a different checkout cannot change
// the pack. A path absent at `head` is UNAVAILABLE, not an empty file (AR1/AR2).
//
// PURE CORE + THIN IO (the herdr.ts idiom): classification/extraction/rendering is pure and selftested (import
// extraction delegates to the TypeScript preprocessor, which is lexically correct); the git/crypto wrappers at
// the bottom are exercised by the integration selftest and live runs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as ts from "typescript";

// ===================== PURE CORE (selftested) =====================

// ---- layer / zone classification ----
export type Zone = "script" | "test" | "doc" | "bus" | "other";

export function zoneOf(filePath: string): Zone {
  if (/\.(test|selftest)\.[cm]?[jt]sx?$/.test(filePath)) return "test";
  if (filePath.startsWith("scripts/")) return "script";
  if (filePath.endsWith(".md") || filePath.startsWith("docs/")) return "doc";
  if (filePath.startsWith("packages/bus/src/")) return "bus";
  return "other";
}

// node builtins whose DIRECT import makes a module IO-tainted, matched on the builtin ROOT so a submodule like
// `fs/promises`, `dns/promises`, `readline/promises`, `http2` is covered without enumerating each (AR4).
const IO_BUILTIN_ROOTS = new Set([
  "fs", "child_process", "net", "http", "http2", "https", "dgram", "tls", "dns", "readline", "cluster", "inspector", "repl",
]);

export function ioRootOf(spec: string): string {
  return spec.replace(/^node:/, "").split("/")[0] ?? "";
}

// Lexically-correct import extraction via the TypeScript preprocessor: it ignores strings, comments, regex and
// template literals, and captures static import/export-from, bare imports, require(), and a resolvable literal
// dynamic import("..."). A non-literal dynamic import (template/variable) has no knowable target and is omitted
// (AR3). This is a real scanner, not a regex over raw text.
export function extractImports(content: string): string[] {
  return ts.preProcessFile(content, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true).importedFiles.map((f) => f.fileName);
}

export function isIoTainted(content: string): boolean {
  return extractImports(content).some((s) => IO_BUILTIN_ROOTS.has(ioRootOf(s)));
}

// Normalize a RELATIVE specifier to a repo-relative path, keeping its own extension. Bare/external -> null.
export function normalizeSpecifier(fromPath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const stack = fromPath.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

// Candidate SOURCE paths for a normalized import path: the literal path, compiled->source extension swaps
// (.js->.ts/.tsx, .mjs->.mts, .cjs->.cts), and bare/extensionless + index resolution. The swaps are ADDED,
// never forced — a real `.mjs` in the batch resolves to itself (AR5). Most specific first.
const SRC_EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];
export function candidatePaths(normalized: string): string[] {
  const out: string[] = [normalized];
  if (/\.js$/.test(normalized)) out.push(normalized.replace(/\.js$/, ".ts"), normalized.replace(/\.js$/, ".tsx"));
  if (/\.mjs$/.test(normalized)) out.push(normalized.replace(/\.mjs$/, ".mts"));
  if (/\.cjs$/.test(normalized)) out.push(normalized.replace(/\.cjs$/, ".cts"));
  const noext = normalized.replace(/\.[cm]?[jt]sx?$/, "");
  for (const e of SRC_EXTS) {
    out.push(noext + e);
    out.push(`${noext}/index${e}`);
  }
  return [...new Set(out)];
}

// Resolve a specifier to the REAL file present in the batch set; null if it resolves outside the set.
export function resolveInSet(fromPath: string, spec: string, paths: ReadonlySet<string>): string | null {
  const norm = normalizeSpecifier(fromPath, spec);
  if (norm === null) return null;
  for (const c of candidatePaths(norm)) if (paths.has(c)) return c;
  return null;
}

export type FileInfo = { path: string; zone: Zone; ioTainted: boolean; imports: string[] };

export function fileInfo(filePath: string, content: string): FileInfo {
  return { path: filePath, zone: zoneOf(filePath), ioTainted: isIoTainted(content), imports: extractImports(content) };
}

export type Edge = { from: string; to: string; fromZone: Zone; toZone: Zone };

// Edges are kept ONLY when both endpoints are in the collected file set — an edge out of the batch is absent.
export function buildImportEdges(files: FileInfo[]): Edge[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const paths = new Set(files.map((f) => f.path));
  const edges: Edge[] = [];
  for (const f of files) {
    for (const spec of f.imports) {
      const to = resolveInSet(f.path, spec, paths);
      if (!to) continue;
      const tf = byPath.get(to);
      if (!tf) continue;
      edges.push({ from: f.path, to, fromZone: f.zone, toZone: tf.zone });
    }
  }
  return edges;
}

export type BoundaryFlag = { kind: "pure-imports-io" | "bus-imports-script" | "import-cycle"; detail: string };

export function findCycles(edges: Edge[]): string[][] {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on-stack, 2 done
  const stack: string[] = [];
  const dfs = (n: string): void => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const s = state.get(m) ?? 0;
      if (s === 0) dfs(m);
      else if (s === 1) {
        const i = stack.indexOf(m);
        if (i >= 0) cycles.push([...stack.slice(i), m]);
      }
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of nodes) if ((state.get(n) ?? 0) === 0) dfs(n);
  return cycles;
}

// Candidate flags (reviewer confirms) — wrong-direction edges and pure->IO imports within the bus layer.
export function flagBoundaries(files: FileInfo[], edges: Edge[]): BoundaryFlag[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const flags: BoundaryFlag[] = [];
  for (const e of edges) {
    const from = byPath.get(e.from);
    const to = byPath.get(e.to);
    if (!from || !to) continue;
    if (e.fromZone === "bus" && e.toZone === "bus" && !from.ioTainted && to.ioTainted)
      flags.push({ kind: "pure-imports-io", detail: `${e.from} (pure) imports ${e.to} (IO-tainted)` });
    if (e.fromZone === "bus" && e.toZone === "script")
      flags.push({ kind: "bus-imports-script", detail: `${e.from} imports script ${e.to} (wrong direction)` });
  }
  for (const c of findCycles(edges)) flags.push({ kind: "import-cycle", detail: c.join(" -> ") });
  return flags;
}

// ---- C11: every `done` declaration must be bound to a commit SHA ----
export type DoneClaim = { node: string; sha?: string };
export type DoneFlag = { node: string; ok: boolean; reason: string };
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function checkDoneEvidence(claims: DoneClaim[]): DoneFlag[] {
  return claims.map((c) => {
    const sha = (c.sha ?? "").trim();
    if (!sha) return { node: c.node, ok: false, reason: "done claim carries no SHA" };
    if (!SHA_RE.test(sha)) return { node: c.node, ok: false, reason: `not a commit SHA: ${sha}` };
    return { node: c.node, ok: true, reason: `bound to ${sha}` };
  });
}

// ---- contract surface manifest (hashed, so a shared-entity shape change is visible across increments) ----
export type ContractCategory = "spec-doc" | "shared-type" | "invariant-doc" | "other";

export function contractCategory(filePath: string): ContractCategory {
  if (/(^|\/)(CLAUDE\.md$|memory\/)/.test(filePath)) return "invariant-doc";
  if (filePath.endsWith(".md")) return "spec-doc";
  if (/\.(ts|mts|cts)$/.test(filePath)) return "shared-type";
  return "other";
}

// sha256 === null means the path was UNAVAILABLE at head (missing / unreadable), NOT an empty file (AR2).
export type ManifestRow = { path: string; sha256: string | null; category: ContractCategory };

export function contractSurfaceManifest(entries: { path: string; sha256: string | null }[]): ManifestRow[] {
  return entries.map((e) => ({ path: e.path, sha256: e.sha256, category: contractCategory(e.path) }));
}

// ---- the review axes (design R22 + 32-eval C11) ----
export const ARCH_AXES = [
  { id: "boundary", title: "Module boundary drift", probe: "IO in a pure module; a script reaching into bus internals; a pure->IO import" },
  { id: "duplicate", title: "Duplicate implementation", probe: "one concern solved twice (two board parsers; two liveness paths) — name convergence candidates" },
  { id: "contract", title: "Contract conflict", probe: "two increments assuming incompatible shapes of a SHARED entity (control-log, WaitRecord, projection schema, InboxMsg, TaskPlan/TaskSpec)" },
  { id: "dependency", title: "Dependency direction", probe: "import cycles or wrong-direction edges (bus->scripts, pure->IO) — the key graph invariant" },
  { id: "gate", title: "Gate / invariant consistency", probe: "each new env gate follows the strict pattern; dormant-ahead-of-use and verified-only boundaries hold across increments" },
  { id: "done-sha", title: "Done bound to SHA evidence (32-eval C11)", probe: "every `done` declaration in the batch is bound to a commit SHA; a self-reported done with no SHA is REMAIN" },
] as const;

export type ReviewSheetInput = {
  branch: string;
  base: string;
  head: string;
  reviewer: string;
  author: string;
  commits: string[];
  changedFiles: string[];
  manifest: ManifestRow[];
  edges: Edge[];
  flags: BoundaryFlag[];
  doneFlags: DoneFlag[];
};

const table = (header: string[], rows: string[][]): string => {
  const sep = header.map(() => "---");
  return [header, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
};

// Render the S19-style architecture-integrity review SHEET. Deterministic — no clock, no randomness.
export function renderReviewSheet(input: ReviewSheetInput): string {
  const { branch, base, head, reviewer, author } = input;
  const out: string[] = [];
  out.push(`# Architecture-integrity review sheet — ${branch}`);
  out.push("");
  out.push(`- **Branch** \`${branch}\`  **HEAD** \`${head}\`  **Base** \`${base}\``);
  out.push(`- **Reviewer** ${reviewer} (cross-family, independent)  **Author/tooling** ${author}`);
  out.push(`- **Spec** \`docs/swarm/arch-integrity-review-design.md\` (R22) + 32-eval C11`);
  out.push("");
  out.push("## What this is");
  out.push(
    "A CROSS-CUTTING review of the batch as a whole, not per-PR correctness. The tooling below collected the " +
      "inputs from the git objects at HEAD (not the working tree); the reviewer fills each axis verdict. A " +
      "CONFIRMED finding is REMAIN and BLOCKS the batch merge; a drift finding opens a convergence follow-up. The " +
      "tool flags candidates only — it never pronounces a verdict.",
  );
  out.push("");
  out.push("## Diff set");
  out.push(`${input.commits.length} commit(s), ${input.changedFiles.length} changed file(s), \`${base}..${head}\`.`);
  if (input.commits.length) {
    out.push("");
    out.push("```");
    out.push(...input.commits);
    out.push("```");
  }
  out.push("");
  out.push("## Contract surface (hashed — compare against the prior verdict to see drift)");
  out.push(
    table(
      ["path", "category", "sha256"],
      input.manifest.map((r) => [
        `\`${r.path}\``,
        r.category,
        r.sha256 === null ? "**(unavailable)**" : `\`${r.sha256.slice(0, 16)}…\``,
      ]),
    ),
  );
  out.push("");
  out.push("## Import map (who-imports-whom, batch files only)");
  if (input.edges.length) {
    out.push(table(["from", "zone", "to", "zone"], input.edges.map((e) => [`\`${e.from}\``, e.fromZone, `\`${e.to}\``, e.toZone])));
  } else {
    out.push("_(no internal edges among the batch's changed source files)_");
  }
  out.push("");
  out.push("### Candidate boundary flags (reviewer confirms — evidence, not findings)");
  if (input.flags.length) out.push(...input.flags.map((f) => `- **${f.kind}** — ${f.detail}`));
  else out.push("_(none auto-detected; the reviewer still judges the axes below)_");
  out.push("");
  out.push("## C11 — done bound to SHA evidence");
  if (input.doneFlags.length) {
    out.push(table(["node", "ok", "reason"], input.doneFlags.map((d) => [d.node, d.ok ? "yes" : "**NO**", d.reason])));
  } else {
    out.push("_(no done claims supplied; reviewer lists the batch's done declarations and confirms each binds a SHA)_");
  }
  out.push("");
  out.push("## Axis verdicts (reviewer fills; REMAIN blocks the batch)");
  for (const a of ARCH_AXES) {
    out.push(`### ${a.title}`);
    out.push(`- _Probe:_ ${a.probe}`);
    out.push("- **Verdict:** _(PASS | REMAIN — with the finding and its evidence)_");
    out.push("");
  }
  out.push("## REMAIN (open, blocking)");
  out.push("_(reviewer: list every REMAIN finding; the batch does not merge while any REMAIN stands)_");
  out.push("");
  return out.join("\n");
}

// ===================== THIN IO (exercised by the integration selftest + live runs) =====================

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Read a path's content at a FIXED commit (git object) — null if the path is absent/unreadable at that rev.
// Reading the OBJECT, never the working tree, is what makes the pack a function of the SHA (AR1).
export function gitShow(repo: string, rev: string, rel: string): string | null {
  try {
    // stderr ignored: an absent path at rev is the expected "unavailable" signal (caught below), not noise.
    return execFileSync("git", ["-C", repo, "show", `${rev}:${rel}`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function gitBatchDiff(repo: string, base: string, head: string): { commits: string[]; changedFiles: string[] } {
  const commits = git(repo, ["log", "--format=%h %s", `${base}..${head}`]).split("\n").filter(Boolean);
  // -z + core.quotepath=false: a machine-readable NUL-separated list, so non-ASCII paths are neither escaped
  // nor split mid-name (AR5).
  const raw = git(repo, ["-c", "core.quotepath=false", "diff", "--name-only", "-z", `${base}...${head}`]);
  const changedFiles = raw.split("\0").filter(Boolean);
  return { commits, changedFiles };
}

const SRC_FILE_RE = /\.[cm]?[jt]sx?$/; // .ts .tsx .mts .cts .js .jsx .mjs .cjs — collect compiled sources too (AR5)

export const DEFAULT_CONTRACT_SURFACE: readonly string[] = [
  "docs/swarm/cluster-liveness-design.md",
  "docs/swarm/projection-schema.md",
  "docs/swarm/team-collab-design.md",
  "packages/bus/src/inbox.ts",
  "packages/bus/src/swarm/task-plan.ts",
  "packages/bus/src/swarm/control-log.ts",
  "CLAUDE.md",
];

export type ArchReviewPack = {
  sheet: string;
  infos: FileInfo[];
  edges: Edge[];
  flags: BoundaryFlag[];
  manifest: ManifestRow[];
  doneFlags: DoneFlag[];
  commits: string[];
  changedFiles: string[];
  unavailableContracts: string[];
};

export function collectArchReviewPack(opts: {
  repo: string;
  base: string;
  head: string;
  branch: string;
  reviewer: string;
  author: string;
  contractPaths?: readonly string[];
  doneClaims?: DoneClaim[];
}): ArchReviewPack {
  const { repo, base, head } = opts;
  const { commits, changedFiles } = gitBatchDiff(repo, base, head);
  const srcFiles = changedFiles.filter(
    (p) => SRC_FILE_RE.test(p) && (p.startsWith("packages/bus/src/") || p.startsWith("scripts/")),
  );
  const infos = srcFiles
    .map((p) => ({ p, content: gitShow(repo, head, p) }))
    .filter((x): x is { p: string; content: string } => x.content !== null)
    .map((x) => fileInfo(x.p, x.content));
  const edges = buildImportEdges(infos);
  const flags = flagBoundaries(infos, edges);
  const contractPaths = opts.contractPaths ?? DEFAULT_CONTRACT_SURFACE;
  const contractEntries = contractPaths.map((p) => {
    const content = gitShow(repo, head, p);
    return { path: p, sha256: content === null ? null : sha256(content) };
  });
  const manifest = contractSurfaceManifest(contractEntries);
  const unavailableContracts = manifest.filter((r) => r.sha256 === null).map((r) => r.path);
  const doneFlags = checkDoneEvidence(opts.doneClaims ?? []);
  const sheet = renderReviewSheet({
    branch: opts.branch,
    base,
    head,
    reviewer: opts.reviewer,
    author: opts.author,
    commits,
    changedFiles,
    manifest,
    edges,
    flags,
    doneFlags,
  });
  return { sheet, infos, edges, flags, manifest, doneFlags, commits, changedFiles, unavailableContracts };
}
