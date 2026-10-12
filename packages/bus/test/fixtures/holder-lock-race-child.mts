// Real-process child for the holder-lock cross-process concurrency regression gate (DO-R6-P2-1). It monkey-patches fs to insert
// NAMED scheduling gates (a busy-wait on a <role>.<gate>.go file) around the UNMODIFIED acquireHolderLock, so the orchestrator can
// drive an EXACT late-publish ABA / cleanup-fault interleaving across real processes — the window where the ② post-publish
// sole-ownership verify is the actual safety, which a single-process terminal-state test cannot reach. The holder-lock module path
// is argv[0] so the orchestrator's NEGATIVE CONTROL can point this child at a ②-stripped copy. No production source edits: the
// barriers live only in this child's fs wrappers (made visible to the imported module via syncBuiltinESMExports).
//
// argv: <holderLockModulePath> <root> <role> <comma-separated gate list> <action: once|hold|linger>
//   gates fire at: "mkdir" (after mkdirSync lockDir), "publish" (after writeFileSync a token into lockDir), "read-N" (Nth readdirSync
//   of lockDir), "release" (auto-added for hold/linger — held until <role>.release.go).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports as syncESM } from "node:module";

const [modulePath, root, role, gateList, action] = process.argv.slice(2) as [string, string, string, string, string];
const site = { lockDir: path.join(root, "lock"), intentDir: path.join(root, "intents"), intentPrefix: "hold." };
const realWrite = fs.writeFileSync, realReaddir = fs.readdirSync, realMkdir = fs.mkdirSync, realRm = fs.rmSync;
const gates = new Set((gateList ?? "").split(",").filter(Boolean));
const seen = new Set<string>();
const errors: { op: string; code?: string }[] = [];
let reads = 0;

const mark = (n: string, data: Record<string, unknown> = {}): void => { realWrite(path.join(root, `${role}.${n}.json`), JSON.stringify({ pid: process.pid, ...data })); };
function gate(n: string, data: Record<string, unknown> = {}): void {
  mark(n, data);
  if (!gates.has(n) || seen.has(n)) return;
  seen.add(n);
  const end = Date.now() + 45000; // generous: this child competes with the whole parallel vitest pool for CPU (event-driven ⇒ the normal path still returns in ms)
  while (!fs.existsSync(path.join(root, `${role}.${n}.go`))) {
    if (Date.now() > end) throw new Error(`bounded gate timeout ${role}.${n}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // ~5ms sleep without a hot spin
  }
}
// Wrap the fs ops acquireHolderLock uses on the LOCK DIR, inserting a gate after each real call.
fs.mkdirSync = ((p: fs.PathLike, ...a: unknown[]) => { const r = (realMkdir as (...x: unknown[]) => unknown)(p, ...a); if (String(p) === site.lockDir) gate("mkdir"); return r; }) as typeof fs.mkdirSync;
fs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...a: unknown[]) => { const r = (realWrite as (...x: unknown[]) => unknown)(p, ...a); if (path.dirname(String(p)) === site.lockDir) gate("publish", { token: path.basename(String(p)) }); return r; }) as typeof fs.writeFileSync;
fs.readdirSync = ((p: fs.PathLike, ...a: unknown[]) => { const r = (realReaddir as (...x: unknown[]) => unknown)(p, ...a); if (String(p) === site.lockDir) gate(`read-${++reads}`, { names: r }); return r as string[]; }) as typeof fs.readdirSync;
fs.rmSync = ((p: fs.PathLike, ...a: unknown[]) => { try { return (realRm as (...x: unknown[]) => unknown)(p, ...a); } catch (e) { errors.push({ op: "rm", code: (e as NodeJS.ErrnoException).code }); throw e; } }) as typeof fs.rmSync;
syncESM();

const { acquireHolderLock, releaseHolderLock } = await import(pathToFileURL(modulePath).href);
try {
  const token: string | null = acquireHolderLock(site);
  mark("result", { token, errors });
  if ((token && action === "hold") || action === "linger") { gates.add("release"); gate("release"); }
  if (token) releaseHolderLock(site, token);
} catch (e) { mark("error", { code: (e as NodeJS.ErrnoException).code, message: (e as Error).message, errors }); process.exitCode = 1; }
