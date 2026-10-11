/**
 * sanitized-read-io — the COORDINATOR-side hardened read + result-tmpfile IO (Phase 1: path reads, `cat`). The coordinator runs
 * the read in ITS OWN controlled process — no subprocess, no shell, no member env — and writes the bytes to a 0600 result file;
 * the member's rewrite (`builtin command /bin/cat <result>`) reads THAT, not the original path. Hardening (TOCTOU-closing):
 *   - realpath the PARENT dir (resolves parent symlinks ⇒ a symlinked parent escaping cwd is revealed and rejected),
 *   - open the FINAL component with O_NOFOLLOW (a symlinked final component ⇒ ELOOP ⇒ reject),
 *   - fstat the OPENED fd (reject a non-regular file),
 *   - confirm the resolved path is WITHIN the member's realpath'd cwd subtree (reject escapes),
 *   - reject a credential path (SECRET_RE, defense-in-depth beyond planSanitize's arg check),
 *   - read up to MAX_BYTES from that same fd (truncated marker if more).
 * Uses the REAL fs directly (the security IS the real O_NOFOLLOW/realpath behavior; selftests exercise real temp fixtures).
 * Residual (brief ⑤): the realpath(parent)→open window is not openat-atomic; a parent-dir swap race is lower-order (the
 * coordinator reads once, within its own cwd scope) and noted — Phase 1 accepts it.
 */
import { openSync, fstatSync, readSync, closeSync, realpathSync, mkdirSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, constants as FS } from "node:fs";
import { join, dirname, basename, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { SECRET_RE } from "./approval-delegation.js";
import { type SanitizeSpec, SANITIZED_READ_MAX_BYTES, SANITIZED_READ_TRUNCATION_MARKER, SANITIZED_READ_DIRNAME } from "./sanitized-read.js";

export type ReadResult = { ok: true; bytes: Buffer; truncated: boolean } | { ok: false; reason: string };

/** The coordinator-owned result dir (~/.agenthop/swarm/sanitized-read). The member hook validates a result path is under it. */
export function sanitizedReadDir(home: string): string {
  return join(home, ".agenthop", "swarm", SANITIZED_READ_DIRNAME);
}

/** Is absolute path `p` within the `cwd` subtree (both already realpath'd)? Segment-prefix check — no ".." escape possible since
 *  both are realpaths (symlinks + ".." already resolved out). */
function withinCwd(p: string, cwd: string): boolean {
  const a = p.endsWith(sep) ? p.slice(0, -1) : p;
  const c = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd;
  return a === c || a.startsWith(c + sep);
}

/**
 * HARDENED path read (Phase 1 `cat`). Returns the file bytes (capped) or a reject reason. TOCTOU-closing: the member never execs
 * this read — the coordinator does ONE realpath+O_NOFOLLOW-open+fstat+read in its controlled process. `cwd` is the member's
 * verified ABSOLUTE cwd (from the S11 request).
 */
export function resolveAndRead(spec: SanitizeSpec, cwd: string): ReadResult {
  if (spec.readKind !== "cat") return { ok: false, reason: `unsupported readKind ${spec.readKind}` }; // Phase 1 guard (table grows later)
  let realCwd: string;
  try { realCwd = realpathSync(cwd); } catch { return { ok: false, reason: "cwd-unresolvable" }; }
  const abs = isAbsolute(spec.targetArg) ? spec.targetArg : join(realCwd, spec.targetArg);
  let parent: string;
  try { parent = realpathSync(dirname(abs)); } catch { return { ok: false, reason: "parent-unresolvable" }; } // missing/escaping parent
  const finalPath = join(parent, basename(abs));
  if (!withinCwd(finalPath, realCwd)) return { ok: false, reason: "escape-cwd" };   // resolved target is outside the member's cwd
  if (SECRET_RE.test(finalPath)) return { ok: false, reason: "credential-path" };   // ④ defense-in-depth on the RESOLVED path
  let fd: number;
  try { fd = openSync(finalPath, FS.O_RDONLY | FS.O_NOFOLLOW); }                     // a symlinked FINAL component ⇒ ELOOP ⇒ throw
  catch (e) { return { ok: false, reason: `open-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` }; } // ELOOP / ENOENT / EACCES …
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not-regular-file" };              // dir / fifo / device / socket
    const buf = Buffer.alloc(SANITIZED_READ_MAX_BYTES);
    let total = 0;
    while (total < SANITIZED_READ_MAX_BYTES) {
      const n = readSync(fd, buf, total, SANITIZED_READ_MAX_BYTES - total, total);
      if (n === 0) break;
      total += n;
    }
    // truncated iff there is MORE than the cap: the file is larger than what we read, OR a byte remains past the cap.
    let truncated = false;
    if (total >= SANITIZED_READ_MAX_BYTES) { try { truncated = fstatSync(fd).size > SANITIZED_READ_MAX_BYTES; } catch { truncated = true; } }
    return { ok: true, bytes: buf.subarray(0, total), truncated };
  } catch (e) {
    return { ok: false, reason: `read-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` };
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

/** Write the sanitized bytes (+ the truncation marker if truncated — NEVER silent) to a 0600 file in the coordinator-owned result
 *  dir (mkdir 0700). Atomic (tmp + rename). Returns the absolute result path the member's rewrite will `cat`. */
export function writeSanitizedResult(home: string, bytes: Buffer, truncated: boolean, rand: () => string = () => randomBytes(12).toString("hex")): string {
  const dir = sanitizedReadDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${rand()}.out`;
  const finalPath = join(dir, name);
  const tmp = `${finalPath}.tmp-${randomBytes(4).toString("hex")}`;
  const payload = truncated ? Buffer.concat([bytes, Buffer.from(SANITIZED_READ_TRUNCATION_MARKER)]) : bytes;
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, finalPath);
  return finalPath;
}

/** Best-effort GC: unlink result files older than `maxAgeSec` (they are one-shot — read once by the member, then stale). Never
 *  throws (GC is damage-control; a failure must not break the sweep). */
export function gcSanitizedResults(home: string, maxAgeSec: number, nowMs: number = Date.now()): void {
  const dir = sanitizedReadDir(home);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; } // no dir yet ⇒ nothing to GC
  for (const n of names) {
    const p = join(dir, n);
    try { if (nowMs - statSync(p).mtimeMs > maxAgeSec * 1000) unlinkSync(p); } catch { /* vanished / unreadable ⇒ skip */ }
  }
}
