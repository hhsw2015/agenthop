// Real-process child for the record-temp WRITE-COMPLETENESS gate (DO-R8-P1-1). It patches the RECORD temp's writeSync to force SHORT
// writes (cap bytes/call) or a mid-write throw, around the UNMODIFIED enqueueQueue, so the test can prove a partial write never
// publishes a truncated record and a mid-write failure leaves no torn residue. It targets ONLY the record temp fd (captured at its
// openSync — path `*.json.tmp-*`) so the cred write and every other fd are untouched. A real capped write returns the REAL byte count
// (not a faked value). No negative-control mutant is needed: the positive gate fails if the complete-write loop is reverted to a
// single return-ignoring writeSync (the partial body then publishes). argv: <tgQueueModulePath> <root> <mode: cap|throw> <cap bytes>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const [modulePath, root, mode, capStr] = process.argv.slice(2) as [string, string, string, string];
const dir = path.join(root, "q");
const cap = Number(capStr);
const realOpen = fs.openSync, realWrite = fs.writeSync;
let recordFd = -1, recWritten = 0;
fs.openSync = ((p: fs.PathLike, ...a: unknown[]) => { const fd = (realOpen as (...x: unknown[]) => number)(p, ...a); if (/\.json\.tmp-/.test(String(p))) recordFd = fd; return fd; }) as typeof fs.openSync;
fs.writeSync = ((fd: number, data: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
  if (fd === recordFd && Buffer.isBuffer(data) && typeof offset === "number" && typeof length === "number") {
    if (mode === "throw" && recWritten >= cap) throw Object.assign(new Error("injected mid-write EIO"), { code: "EIO" });
    const n = (realWrite as (...x: unknown[]) => number)(fd, data, offset, Math.min(length, cap), position); // REAL short write (capped length ⇒ real byte count)
    recWritten += n; return n;
  }
  return (realWrite as (...x: unknown[]) => number)(fd, data, offset, length, position);
}) as typeof fs.writeSync;
syncBuiltinESMExports();

const { enqueueQueue } = await import(pathToFileURL(modulePath).href);
const payload = { v: "你好🌍émoji-" + "x".repeat(300) }; // multi-byte UTF-8 (byte length > char length) + large ⇒ many write iterations
const result = enqueueQueue(dir, payload, 1);
fs.openSync = realOpen; fs.writeSync = realWrite; syncBuiltinESMExports(); // un-patch before reporting
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ result, payload }));
