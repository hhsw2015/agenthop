/**
 * sanitized-read-io — the COORDINATOR-side hardened read + result-tmpfile IO (Phase 1b: path reads `cat`/`head`/`tail`/`wc`/`ls`/
 * `stat`). The coordinator runs the read in ITS OWN controlled process — no subprocess, no shell, no member env — and writes the
 * produced bytes to a 0600 result file; the member's rewrite (`builtin command /bin/cat <result>`) reads THAT, not the original
 * path (so EVERY form reduces to the member cat-ing the coordinator's result — the verdict seam is form-agnostic). The six forms
 * share ONE hardening: open+bind the fd within cwd (below), then a per-`readKind` producer (`produce`) transforms the SAME bound
 * handle (content: cat/head/tail/wc; metadata: stat) or lists the bound directory (ls) — never re-opening the member's path.
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
import { readdirSync, statSync, unlinkSync, promises as fsp, constants as FS, type Stats } from "node:fs";
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
 * HARDENED path read (Phase 1b: cat/head/tail/wc/ls/stat), ASYNC (SR-P2-1: never blocks the dispatcher sweep). Opens + binds the
 * fd within cwd (SR-P1-1), then a per-`readKind` producer makes the output bytes; returns them (capped) or a reject reason. `cwd`
 * is the member's verified ABSOLUTE cwd (from the S11 request).
 */
export async function resolveAndRead(spec: SanitizeSpec, cwd: string): Promise<ReadResult> {
  let realCwd: string;
  try { realCwd = await fsp.realpath(cwd); } catch { return { ok: false, reason: "cwd-unresolvable" }; }
  const abs = isAbsolute(spec.targetArg) ? spec.targetArg : join(realCwd, spec.targetArg);
  const wantDir = spec.readKind === "ls";
  // ls opens a DIRECTORY (O_DIRECTORY ⇒ ENOTDIR on a non-dir); the content/metadata forms open a regular file. BOTH carry
  // O_NOFOLLOW (a symlinked final component ⇒ ELOOP ⇒ reject) + O_NONBLOCK (a FIFO/device can't wedge the open).
  const flags = FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | (wantDir ? FS.O_DIRECTORY : 0);
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(abs, flags); }
  catch (e) { return { ok: false, reason: `open-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` }; } // ELOOP / ENOENT / ENOTDIR / EACCES …
  try {
    const fst = await handle.stat();
    if (wantDir) { if (!fst.isDirectory()) return { ok: false, reason: "not-directory" }; }
    else if (!fst.isFile()) return { ok: false, reason: "not-regular-file" };    // dir / fifo / device / socket
    const bind = await fdWithinCwd(handle, abs, realCwd);
    if (!bind.ok) return bind; // outside cwd / credential / swapped ⇒ reject (SR-P1-1)
    return await produce(spec, handle, fst, abs);
  } catch (e) {
    return { ok: false, reason: `read-failed:${(e as NodeJS.ErrnoException)?.code ?? "?"}` };
  } finally {
    try { await handle.close(); } catch { /* best-effort */ }
  }
}

const NL = 0x0a;
const DEFAULT_LINES = 10; // head/tail default — BARE forms only (coordinator ruling: -n N is a later form-table increment)

/**
 * The per-`readKind` producer — the Phase-1b form table. Runs AFTER the fd is bound within cwd (SR-P1-1): every form transforms
 * the SAME bound handle (content/metadata) or lists the bound directory, never re-opening the member's path.
 */
async function produce(spec: SanitizeSpec, handle: fsp.FileHandle, fst: Stats, abs: string): Promise<ReadResult> {
  const cap = SANITIZED_READ_MAX_BYTES;
  switch (spec.readKind) {
    case "cat": case "head": {
      const { buf, over } = await readFromStart(handle, cap);
      if (spec.readKind === "cat") return { ok: true, bytes: buf, truncated: over };
      const sliced = firstNLines(buf, DEFAULT_LINES);
      // head is complete once its N lines are in hand; truncated ONLY if the cap cut before the Nth line (slice == whole window).
      return { ok: true, bytes: sliced, truncated: over && sliced.length === buf.length };
    }
    case "tail": {
      const over = fst.size > cap;                               // read the END window so tail is faithful on a large file
      const buf = await readRange(handle, over ? fst.size - cap : 0, Math.min(fst.size, cap));
      const sliced = lastNLines(buf, DEFAULT_LINES);
      // the last N lines are faithful if they fit the window; truncated only if the (size-limited) window held < N lines.
      return { ok: true, bytes: sliced, truncated: over && sliced.length === buf.length };
    }
    case "wc": {
      const { lines, words, bytes } = await countAll(handle); // counts the WHOLE file (the cap bounds OUTPUT, not input)
      return { ok: true, bytes: Buffer.from(`${lines} ${words} ${bytes} ${spec.targetArg}\n`), truncated: false };
    }
    case "stat": return { ok: true, bytes: Buffer.from(formatStat(fst, spec.targetArg)), truncated: false };
    case "ls": return await listDir(handle, abs, cap);
  }
}

/** Read up to `cap` bytes from offset 0. `over` = the file has MORE than `cap` bytes (⇒ the output is capped). */
async function readFromStart(handle: fsp.FileHandle, cap: number): Promise<{ buf: Buffer; over: boolean }> {
  const buf = Buffer.alloc(cap);
  let total = 0;
  while (total < cap) {
    const { bytesRead } = await handle.read(buf, total, cap - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  let over = false;
  if (total >= cap) { try { over = (await handle.stat()).size > cap; } catch { over = true; } }
  return { buf: buf.subarray(0, total), over };
}

/** Read `len` bytes from `start` (tail reads the file's END window). */
async function readRange(handle: fsp.FileHandle, start: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let total = 0;
  while (total < len) {
    const { bytesRead } = await handle.read(buf, total, len - total, start + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

/** First `n` newline-delimited lines of `buf` (head). Includes the nth line's trailing \n; the whole buf if it has < n newlines. */
function firstNLines(buf: Buffer, n: number): Buffer {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === NL && ++count === n) return buf.subarray(0, i + 1);
  return buf;
}

/** Last `n` newline-delimited lines of `buf` (tail). A single trailing \n terminates the last line (not a boundary before it). */
function lastNLines(buf: Buffer, n: number): Buffer {
  let i = buf.length - 1;
  if (i >= 0 && buf[i] === NL) i--;              // the final \n ends the last line — don't count it as a separator
  let count = 0;
  for (; i >= 0; i--) if (buf[i] === NL && ++count === n) return buf.subarray(i + 1);
  return buf;
}

/** wc over the WHOLE file (unbounded input — the cap is an OUTPUT bound; the count line is tiny). O(1) memory via chunks; the ④
 *  budget guards a runaway. Whitespace = wc's isspace set; `inWord` carries across chunks so a word split at a chunk edge isn't
 *  double-counted. */
async function countAll(handle: fsp.FileHandle): Promise<{ lines: number; words: number; bytes: number }> {
  const chunk = Buffer.alloc(65536);
  let lines = 0, words = 0, bytes = 0, inWord = false, pos = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    bytes += bytesRead;
    for (let i = 0; i < bytesRead; i++) {
      const b = chunk[i];
      if (b === NL) lines++;
      const ws = b === 0x20 || b === NL || b === 0x09 || b === 0x0b || b === 0x0c || b === 0x0d; // space \t \n \v \f \r
      if (ws) inWord = false; else if (!inWord) { inWord = true; words++; }
    }
  }
  return { lines, words, bytes };
}

/** A DEFINED, OS-independent stat format (coordinator ruling: faithful INFO, not byte-exact to native `stat` — OS formats differ,
 *  and the header line marks it sanitized so the member/model never parses it as native output). Metadata is from the BOUND fd
 *  (fstat — no re-resolve). */
function formatStat(fst: Stats, arg: string): string {
  const typ = fst.isFile() ? "regular file" : fst.isDirectory() ? "directory" : fst.isSymbolicLink() ? "symbolic link" : "special";
  return [
    "sanitized stat format",
    `  file: ${arg}`,
    `  type: ${typ}`,
    `  size: ${fst.size}`,
    `  mode: 0${(fst.mode & 0o7777).toString(8).padStart(4, "0")}`,
    `  uid: ${fst.uid}  gid: ${fst.gid}`,
    `  mtime: ${fst.mtime.toISOString()}`,
    `  ctime: ${fst.ctime.toISOString()}`,
    "",
  ].join("\n");
}

/** List a bound directory's entries (ls). SR-P1-1 soundness: Linux reads via /proc/self/fd/<fd> (the kernel's path of the OPEN
 *  dir — not re-resolvable); elsewhere readdir(abs) re-resolves (the accepted same-uid residual, same class as the macOS
 *  lstat-walk). Coordinator note: ls output contains FILENAMES ⇒ run the SAME SECRET_RE guard as a cat target — if ANY entry is a
 *  credential-named path, the whole `ls` escalates to the user (never a sanitized listing that reveals a credential's existence;
 *  the conservative v1 policy — a same-uid member could `ls` directly, so this bypasses only the user's look). Sorted, one/line. */
async function listDir(handle: fsp.FileHandle, abs: string, cap: number): Promise<ReadResult> {
  let names: string[];
  try { names = await fsp.readdir(`/proc/self/fd/${handle.fd}`); } // Linux: the fd's real dir, not re-resolvable
  catch { names = await fsp.readdir(abs); }                         // macOS/BSD (no /proc): re-resolve (accepted residual); a throw ⇒ resolveAndRead's catch ⇒ read-failed
  for (const n of names) if (SECRET_RE.test(n.toLowerCase())) return { ok: false, reason: "credential-entry" }; // same check as a cat target ⇒ escalate
  names.sort();
  const out = Buffer.from(names.length ? names.join("\n") + "\n" : "");
  return out.length > cap ? { ok: true, bytes: out.subarray(0, cap), truncated: true } : { ok: true, bytes: out, truncated: false };
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
