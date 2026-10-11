/**
 * sanitized-read-io — the COORDINATOR-side hardened read + result-tmpfile IO (Phase 1: path reads, `cat`). The coordinator runs
 * the read in ITS OWN controlled process — no subprocess, no shell, no member env — and writes the bytes to a 0600 result file;
 * the member's rewrite (`builtin command /bin/cat <result>`) reads THAT, not the original path.
 *
 * Hardening (SR-P1-1, coordinator ruling A) — the read is ASYNC (fs.promises, SR-P2-1: never block the dispatcher sweep) and the
 * OPEN fd is BOUND to a within-cwd path WITHOUT a link-following re-stat (a `realpath`+`stat` re-resolve is defeated by a mid-op
 * component swap — the review's SR-P1-1):
 *   - open the final with O_NOFOLLOW | O_NONBLOCK (symlinked FINAL ⇒ ELOOP ⇒ reject; O_NONBLOCK so a FIFO/device can't block),
 *   - fstat the OPEN handle (reject a non-regular file: dir / fifo / device / socket),
 *   - BIND (fdWithinCwd): Linux ⇒ readlink /proc/self/fd/<fd> = the kernel's real path of the open fd (not re-resolvable) ⇒ a
 *     direct within-cwd + credential check; non-Linux (macOS, no /proc) ⇒ incremental lstat-walk from realCwd rejecting ANY
 *     symlink component (never follow), then an inode-recheck (lstat == handle dev+ino) to catch a swap during walk/open,
 *   - read up to MAX_BYTES from that SAME handle (truncated marker if more).
 * Residual (coordinator-ruled NON-DIFFERENTIAL, the same-uid active-race class): the macOS lstat-walk is not openat-atomic — a
 * member that ACTIVELY races directory-component swaps across the walk→recheck→read can still steer the read (NO inode reuse
 * needed; the external file's inode is unchanged). Accepted scope exclusion — a same-uid member can read the target directly
 * anyway, so this bypasses only the user's look, never privilege/reachability (see the brief's residual section).
 */
import { readdirSync, statSync, unlinkSync, promises as fsp, constants as FS } from "node:fs";
import { join, isAbsolute, sep, relative } from "node:path";
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
 * SR-P1-1: bind an OPEN handle to a path provably WITHIN cwd, WITHOUT a link-following re-stat (which a mid-op swap defeats).
 * Linux uses the kernel's own record of the fd; macOS falls back to a symlink-rejecting incremental walk + inode-recheck. Pure of
 * the read itself (only resolution facts). Returns ok or a reject reason.
 */
async function fdWithinCwd(handle: fsp.FileHandle, abs: string, realCwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Linux: /proc/self/fd/<fd> is a symlink to the fd's REAL path (kernel-provided, not re-resolvable) — the sound binding.
  try {
    const kpath = await fsp.readlink(`/proc/self/fd/${handle.fd}`);
    if (!withinCwd(kpath, realCwd)) return { ok: false, reason: "escape-cwd" };
    if (SECRET_RE.test(kpath.toLowerCase())) return { ok: false, reason: "credential-path" };
    return { ok: true };
  } catch { /* no /proc (macOS/BSD) ⇒ incremental lstat-walk below */ }
  const rel = relative(realCwd, abs);
  const parts = rel.split(sep).filter((s) => s.length > 0);
  // SR-R2-P3-1: escape = an actual `..` PATH COMPONENT (or absolute), NOT a name that merely starts with ".." (e.g. a real `..note`).
  if (isAbsolute(rel) || parts.some((p) => p === "..")) return { ok: false, reason: "escape-cwd" };
  let cur = realCwd;
  for (const part of parts) {
    cur = join(cur, part);
    let ls: Awaited<ReturnType<typeof fsp.lstat>>;
    try { ls = await fsp.lstat(cur); } catch { return { ok: false, reason: "walk-lstat-failed" }; }
    if (ls.isSymbolicLink()) return { ok: false, reason: "symlink-component" }; // NEVER follow a symlink in the cwd→target chain
  }
  if (SECRET_RE.test(abs.toLowerCase())) return { ok: false, reason: "credential-path" };
  // inode-recheck: the handle we hold MUST be this symlink-free path (a swap during walk/open changes the inode).
  let ls2: Awaited<ReturnType<typeof fsp.lstat>>;
  try { ls2 = await fsp.lstat(abs); } catch { return { ok: false, reason: "recheck-lstat-failed" }; }
  const fst = await handle.stat();
  if (ls2.dev !== fst.dev || ls2.ino !== fst.ino) return { ok: false, reason: "toctou-inode-mismatch" };
  return { ok: true };
}

/**
 * HARDENED path read (Phase 1 `cat`), ASYNC (SR-P2-1: never blocks the dispatcher sweep). Returns the file bytes (capped) or a
 * reject reason. `cwd` is the member's verified ABSOLUTE cwd (from the S11 request).
 */
export async function resolveAndRead(spec: SanitizeSpec, cwd: string): Promise<ReadResult> {
  if (spec.readKind !== "cat") return { ok: false, reason: `unsupported readKind ${spec.readKind}` }; // Phase 1 guard (table grows later)
  let realCwd: string;
  try { realCwd = await fsp.realpath(cwd); } catch { return { ok: false, reason: "cwd-unresolvable" }; }
  const abs = isAbsolute(spec.targetArg) ? spec.targetArg : join(realCwd, spec.targetArg);
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK); }
  catch (e) { return { ok: false, reason: `open-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` }; } // ELOOP / ENOENT / EACCES …
  try {
    const fst = await handle.stat();
    if (!fst.isFile()) return { ok: false, reason: "not-regular-file" }; // dir / fifo / device / socket
    const bind = await fdWithinCwd(handle, abs, realCwd);
    if (!bind.ok) return bind; // outside cwd / credential / swapped ⇒ reject (SR-P1-1)
    const buf = Buffer.alloc(SANITIZED_READ_MAX_BYTES);
    let total = 0;
    while (total < SANITIZED_READ_MAX_BYTES) {
      const { bytesRead } = await handle.read(buf, total, SANITIZED_READ_MAX_BYTES - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    // truncated iff the file is larger than the cap.
    let truncated = false;
    if (total >= SANITIZED_READ_MAX_BYTES) { try { truncated = (await handle.stat()).size > SANITIZED_READ_MAX_BYTES; } catch { truncated = true; } }
    return { ok: true, bytes: buf.subarray(0, total), truncated };
  } catch (e) {
    return { ok: false, reason: `read-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` };
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
  }
}

/** Write the sanitized bytes (+ the truncation marker if truncated — NEVER silent) to a 0600 file in the coordinator-owned result
 *  dir (mkdir 0700). Atomic (tmp + rename). Returns the absolute result path the member's rewrite will `cat`. ASYNC (SR-P2-1: a
 *  sync write would block the event loop so the budget timer could not fire); the dispatcher wraps read+write+build in ONE budget. */
export async function writeSanitizedResult(home: string, bytes: Buffer, truncated: boolean, rand: () => string = () => randomBytes(12).toString("hex")): Promise<string> {
  const dir = sanitizedReadDir(home);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `${rand()}.out`;
  const finalPath = join(dir, name);
  const tmp = `${finalPath}.tmp-${randomBytes(4).toString("hex")}`;
  const payload = truncated ? Buffer.concat([bytes, Buffer.from(SANITIZED_READ_TRUNCATION_MARKER)]) : bytes;
  await fsp.writeFile(tmp, payload, { mode: 0o600 }); // SR-P2-1: ASYNC — a sync write would block the event loop so the budget timer can't even fire
  await fsp.rename(tmp, finalPath);
  return finalPath;
}

/** Best-effort GC: unlink result files older than `maxAgeSec` (one-shot — read once by the member, then stale). Never throws. */
export function gcSanitizedResults(home: string, maxAgeSec: number, nowMs: number = Date.now()): void {
  const dir = sanitizedReadDir(home);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; } // no dir yet ⇒ nothing to GC
  for (const n of names) {
    const p = join(dir, n);
    try { if (nowMs - statSync(p).mtimeMs > maxAgeSec * 1000) unlinkSync(p); } catch { /* vanished / unreadable ⇒ skip */ }
  }
}
