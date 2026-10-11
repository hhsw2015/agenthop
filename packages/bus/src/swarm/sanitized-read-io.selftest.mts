// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/sanitized-read-io.selftest.mts
// Pins the coordinator-side HARDENED read against REAL temp fixtures (the security IS the real O_NOFOLLOW/realpath behavior):
// resolveAndRead (regular⇒bytes; symlink-final⇒reject; escape-cwd⇒reject; dir⇒reject; >1MiB⇒truncated; credential⇒reject) +
// writeSanitizedResult (0600, marker on truncate) + gcSanitizedResults.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, statSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndRead, writeSanitizedResult, gcSanitizedResults, sanitizedReadDir } from "./sanitized-read-io.js";
import { SANITIZED_READ_MAX_BYTES, type SanitizeSpec } from "./sanitized-read.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const cat = (targetArg: string) => ({ readKind: "cat" as const, targetArg });
const spec = (readKind: SanitizeSpec["readKind"], targetArg: string): SanitizeSpec => ({ readKind, targetArg });

const root = mkdtempSync(join(tmpdir(), "sr-io-"));
const CWD = join(root, "cwd");
mkdirSync(CWD, { recursive: true });

try {
  // 1. regular file ⇒ ok, exact bytes, not truncated
  writeFileSync(join(CWD, "notes.txt"), "hello sanitized\n");
  {
    const r = await resolveAndRead(cat("notes.txt"), CWD);
    t("regular file ⇒ ok + exact bytes + not truncated", r.ok === true && r.bytes.toString() === "hello sanitized\n" && r.truncated === false);
  }

  // 2. a symlinked FINAL component ⇒ reject (O_NOFOLLOW ⇒ ELOOP)
  symlinkSync(join(CWD, "notes.txt"), join(CWD, "link.txt"));
  {
    const r = await resolveAndRead(cat("link.txt"), CWD);
    t("symlink final component ⇒ reject", r.ok === false);
  }

  // 3. escape cwd (abs path outside the member's cwd) ⇒ reject
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "SECRET-OUTSIDE");
  {
    const r = await resolveAndRead(cat(outside), CWD);
    t("abs path outside cwd ⇒ reject escape-cwd", r.ok === false && r.reason === "escape-cwd");
  }
  // 3b. ../ escape
  {
    const r = await resolveAndRead(cat("../outside.txt"), CWD);
    t("../ escape ⇒ reject escape-cwd", r.ok === false && r.reason === "escape-cwd");
  }

  // 4. a directory ⇒ reject not-regular-file
  mkdirSync(join(CWD, "adir"));
  {
    const r = await resolveAndRead(cat("adir"), CWD);
    t("directory ⇒ reject not-regular-file", r.ok === false && r.reason === "not-regular-file");
  }

  // 5. file larger than the cap ⇒ truncated, bytes == cap
  writeFileSync(join(CWD, "big.bin"), Buffer.alloc(SANITIZED_READ_MAX_BYTES + 4096, 0x41));
  {
    const r = await resolveAndRead(cat("big.bin"), CWD);
    t("> 1 MiB ⇒ truncated true + bytes == cap", r.ok === true && r.truncated === true && r.bytes.length === SANITIZED_READ_MAX_BYTES);
  }
  // 5b. file exactly at the cap ⇒ not truncated
  writeFileSync(join(CWD, "exact.bin"), Buffer.alloc(SANITIZED_READ_MAX_BYTES, 0x42));
  {
    const r = await resolveAndRead(cat("exact.bin"), CWD);
    t("exactly 1 MiB ⇒ not truncated + bytes == cap", r.ok === true && r.truncated === false && r.bytes.length === SANITIZED_READ_MAX_BYTES);
  }

  // 6. credential path (defense-in-depth on the resolved path) ⇒ reject
  writeFileSync(join(CWD, ".env"), "TOKEN=abc");
  {
    const r = await resolveAndRead(cat(".env"), CWD);
    t("credential path ⇒ reject credential-path", r.ok === false && r.reason === "credential-path");
  }

  // 6b. SR-P1-2: credential path is CASE-INSENSITIVE — `.ENV` must also reject (resolved-path defense-in-depth).
  writeFileSync(join(CWD, ".ENV"), "TOKEN=abc");
  {
    const r = await resolveAndRead(cat(".ENV"), CWD);
    t("credential path .ENV (uppercase) ⇒ reject credential-path", r.ok === false && r.reason === "credential-path");
  }

  // 7. missing file ⇒ reject (not a crash)
  t("missing file ⇒ reject", (await resolveAndRead(cat("nope.txt"), CWD)).ok === false);

  // 8. a FIFO target ⇒ reject not-regular-file AND does NOT hang (O_NONBLOCK — a blocking open would wedge the coordinator).
  // The test COMPLETING is itself the proof; without O_NONBLOCK openSync(fifo) blocks until a writer appears.
  try {
    execFileSync("mkfifo", [join(CWD, "pipe")], { timeout: 2000 });
    const r = await resolveAndRead(cat("pipe"), CWD);
    t("FIFO ⇒ reject not-regular-file (no block, O_NONBLOCK)", r.ok === false && r.reason === "not-regular-file");
  } catch (e) {
    console.log("skip FIFO case (mkfifo unavailable): " + ((e as Error)?.message ?? e));
  }

  // ── Phase 1b forms (head/tail/wc/ls/stat) — all through the SAME bound-fd hardening ───────────────────────────
  const lines20 = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  writeFileSync(join(CWD, "lines.txt"), lines20);

  // 9. head ⇒ first 10 lines
  {
    const r = await resolveAndRead(spec("head", "lines.txt"), CWD);
    const want = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    t("head ⇒ first 10 lines", r.ok === true && r.bytes.toString() === want && r.truncated === false);
  }
  // 10. tail ⇒ last 10 lines
  {
    const r = await resolveAndRead(spec("tail", "lines.txt"), CWD);
    const want = Array.from({ length: 10 }, (_, i) => `l${i + 11}`).join("\n") + "\n";
    t("tail ⇒ last 10 lines", r.ok === true && r.bytes.toString() === want && r.truncated === false);
  }
  // 11. wc ⇒ `lines words bytes <arg>` (echoes the ORIGINAL arg, counts the WHOLE file)
  {
    const r = await resolveAndRead(spec("wc", "lines.txt"), CWD);
    t("wc ⇒ lines words bytes arg", r.ok === true && r.bytes.toString() === `20 20 ${Buffer.byteLength(lines20)} lines.txt\n`);
  }
  // 12. stat ⇒ the sanitized header + faithful fields (fstat of the bound fd, not byte-exact native format)
  {
    const r = await resolveAndRead(spec("stat", "lines.txt"), CWD);
    const s = r.ok ? r.bytes.toString() : "";
    t("stat ⇒ sanitized header + size + type + arg", r.ok === true && s.startsWith("sanitized stat format\n") &&
      s.includes(`size: ${Buffer.byteLength(lines20)}`) && s.includes("type: regular file") && s.includes("file: lines.txt"));
  }
  // 13. ls ⇒ sorted entries, one per line
  mkdirSync(join(CWD, "listme"));
  for (const n of ["b.txt", "a.txt", "c.txt"]) writeFileSync(join(CWD, "listme", n), "");
  {
    const r = await resolveAndRead(spec("ls", "listme"), CWD);
    t("ls ⇒ sorted entries one per line", r.ok === true && r.bytes.toString() === "a.txt\nb.txt\nc.txt\n" && r.truncated === false);
  }
  // 14. ls of a NON-credential dir that CONTAINS a credential-named entry ⇒ reject credential-entry (the output-filename guard;
  //     the dir name itself must NOT match SECRET_RE, else it would reject at the bind step as credential-path instead).
  mkdirSync(join(CWD, "proj"));
  writeFileSync(join(CWD, "proj", "ok.txt"), "");
  writeFileSync(join(CWD, "proj", ".env"), "TOKEN=1");
  {
    const r = await resolveAndRead(spec("ls", "proj"), CWD);
    t("ls over a dir with a credential-named entry ⇒ reject credential-entry", r.ok === false && r.reason === "credential-entry");
  }
  // 15. ls on a regular file ⇒ reject (O_DIRECTORY ⇒ ENOTDIR at open, or the defensive not-directory check where O_DIRECTORY is absent)
  {
    const r = await resolveAndRead(spec("ls", "lines.txt"), CWD);
    t("ls on a regular file ⇒ reject", r.ok === false && (r.reason === "not-directory" || /ENOTDIR/.test(r.reason)));
  }
  // 16. a content form on a directory ⇒ reject not-regular-file
  {
    const r = await resolveAndRead(spec("head", "listme"), CWD);
    t("head on a directory ⇒ reject not-regular-file", r.ok === false && r.reason === "not-regular-file");
  }
  // 17. the SHARED hardening still applies to the new forms: a symlinked final component ⇒ reject
  {
    const r = await resolveAndRead(spec("head", "link.txt"), CWD);
    t("head on a symlink final component ⇒ reject", r.ok === false);
  }
  // 18. ls escaping cwd ⇒ reject escape-cwd (the shared fdWithinCwd, for a dir fd)
  {
    const r = await resolveAndRead(spec("ls", "../"), CWD);
    t("ls ../ ⇒ reject escape-cwd", r.ok === false && r.reason === "escape-cwd");
  }

  // ── writeSanitizedResult ──────────────────────────────────────────────────────────────────────────────────
  const home = join(root, "home");
  {
    const p = await writeSanitizedResult(home, Buffer.from("RESULT-BODY"), false);
    t("writeSanitizedResult: under result dir", p.startsWith(sanitizedReadDir(home) + "/"));
    t("writeSanitizedResult: content + 0600", readFileSync(p, "utf8") === "RESULT-BODY" && (statSync(p).mode & 0o777) === 0o600);
  }
  {
    const p = await writeSanitizedResult(home, Buffer.from("BODY"), true);
    t("writeSanitizedResult: truncated appends the explicit marker", /BODY[\s\S]*truncated at 1MiB/.test(readFileSync(p, "utf8")));
  }

  // ── gcSanitizedResults ────────────────────────────────────────────────────────────────────────────────────
  {
    const dir = sanitizedReadDir(home);
    const old = join(dir, "stale.out");
    writeFileSync(old, "x");
    const past = Date.now() / 1000 - 10_000;
    utimesSync(old, past, past);
    gcSanitizedResults(home, 300);
    let gone = false; try { statSync(old); } catch { gone = true; }
    t("gc: removes a stale result file", gone);
  }
  t("gc: no dir ⇒ no throw", (() => { gcSanitizedResults(join(root, "nohome"), 300); return true; })());

  console.log("all sanitized-read-io selftests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
