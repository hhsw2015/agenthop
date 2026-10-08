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
// PURE CORE + THIN IO (the herdr.ts idiom): classification/extraction/rendering is pure and selftested; the
// git/fs/crypto wrappers at the bottom are exercised by live runs. Keeping the split is itself the boundary
// invariant this very tool checks for — the pure half below imports no node builtin.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ===================== PURE CORE (selftested) =====================

// ---- layer / zone classification ----
export type Zone = "script" | "test" | "doc" | "bus" | "other";

export function zoneOf(filePath: string): Zone {
  if (/\.(test|selftest)\.[cm]?[jt]s$/.test(filePath)) return "test";
  if (filePath.startsWith("scripts/")) return "script";
  if (filePath.endsWith(".md") || filePath.startsWith("docs/")) return "doc";
  if (filePath.startsWith("packages/bus/src/")) return "bus";
  return "other";
}

// node builtins whose DIRECT import makes a module IO-tainted (side-effecting), for the pure->IO boundary axis.
const IO_BUILTINS = new Set([
  "fs", "fs/promises", "child_process", "net", "http", "https", "dgram", "tls", "readline", "dns", "cluster",
]);

// Strip comments so a commented-out `import` line is never mistaken for a real edge (the `://` guard keeps URLs).
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Extract module specifiers from static imports/exports, bare imports, and require()/dynamic import().
export function extractImports(content: string): string[] {
  const src = stripComments(content);
  const out: string[] = [];
  const re =
    /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

export function isIoTainted(content: string): boolean {
  return extractImports(content).some((s) => IO_BUILTINS.has(s.replace(/^node:/, "")));
}

// Resolve a RELATIVE specifier to a repo-relative path (ESM `.js` specifier maps back to `.ts` source).
// Bare/external specifiers return null — they are not internal edges.
export function resolveSpecifier(fromPath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromPath.split("/").slice(0, -1);
  const stack = [...dir];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/").replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts");
}

export type FileInfo = { path: string; zone: Zone; ioTainted: boolean; imports: string[] };

export function fileInfo(filePath: string, content: string): FileInfo {
  return { path: filePath, zone: zoneOf(filePath), ioTainted: isIoTainted(content), imports: extractImports(content) };
}

export type Edge = { from: string; to: string; fromZone: Zone; toZone: Zone };

// Edges are kept ONLY when both endpoints are in the collected file set — an edge out of the batch is absent.
export function buildImportEdges(files: FileInfo[]): Edge[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const edges: Edge[] = [];
  for (const f of files) {
    for (const spec of f.imports) {
      const to = resolveSpecifier(f.path, spec);
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
  if (/\.(ts|mts)$/.test(filePath)) return "shared-type";
  return "other";
}

export type ManifestRow = { path: string; sha256: string; category: ContractCategory };

export function contractSurfaceManifest(entries: { path: string; sha256: string }[]): ManifestRow[] {
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
      "inputs; the reviewer fills each axis verdict. A CONFIRMED finding is REMAIN and BLOCKS the batch merge; a " +
      "drift finding opens a convergence follow-up. The tool flags candidates only — it never pronounces a verdict.",
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
      input.manifest.map((r) => [`\`${r.path}\``, r.category, `\`${r.sha256.slice(0, 16)}…\``]),
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

// ===================== THIN IO (exercised by live runs, not the selftest) =====================

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function gitBatchDiff(repo: string, base: string, head: string): { commits: string[]; changedFiles: string[] } {
  const commits = git(repo, ["log", "--format=%h %s", `${base}..${head}`]).trim().split("\n").filter(Boolean);
  const changedFiles = git(repo, ["diff", "--name-only", `${base}...${head}`]).trim().split("\n").filter(Boolean);
  return { commits, changedFiles };
}

function readSafe(repo: string, rel: string): string {
  try {
    return readFileSync(`${repo}/${rel}`, "utf8");
  } catch {
    return "";
  }
}

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
    (p) => /\.(ts|mts)$/.test(p) && (p.startsWith("packages/bus/src/") || p.startsWith("scripts/")),
  );
  const infos = srcFiles
    .map((p) => ({ p, content: readSafe(repo, p) }))
    .filter((x) => x.content !== "")
    .map((x) => fileInfo(x.p, x.content));
  const edges = buildImportEdges(infos);
  const flags = flagBoundaries(infos, edges);
  const contractPaths = opts.contractPaths ?? DEFAULT_CONTRACT_SURFACE;
  const manifest = contractSurfaceManifest(
    contractPaths.map((p) => ({ path: p, sha256: sha256(readSafe(repo, p)) })),
  );
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
  return { sheet, infos, edges, flags, manifest, doneFlags, commits, changedFiles };
}
