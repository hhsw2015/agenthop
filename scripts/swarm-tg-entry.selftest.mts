// Run: packages/bus/node_modules/.bin/tsx scripts/swarm-tg-entry.selftest.mts
// TG-1 / TG-2 / TG-5 (infra audit): the TG driver's three state readers/writers silently swallowed errors (readAllow -> empty set
// = approval BLACK HOLE; readOffset -> 0 = 24h backlog replay; writeOffset -> swallow = invisible reprocess storm). Pins the FC-2
// three-state contracts, with the 3 zero-bug fixture classes, each asserting an OBSERVABLE TERMINAL STATE (the value the main loop
// / pollOnce keys off: null ⇒ refuse, a set/number ⇒ proceed). EACCES is exercised via EISDIR (a directory at the file path), a
// non-ENOENT read/write fault that is portable in a selftest (no chmod/root dependence).
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAllow, readOffset, writeOffset } from "./swarm-tg-entry.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "tg-entry-selftest-"));
let seq = 0;
const f = (name: string) => path.join(scratch, `${name}-${seq++}`);
const setEq = (s: Set<number> | null, xs: number[]) => s !== null && s.size === xs.length && xs.every((x) => s.has(x));

try {
  // ── TG-5 readAllow: FC-2 three-state ────────────────────────────────────────────────────────────────────────────
  t("readAllow: ENOENT -> EMPTY set (not configured, NOT null)", (() => { const s = readAllow(f("absent")); return s !== null && s.size === 0; })());
  t("readAllow: valid array -> set", (() => { const p = f("arr"); writeFileSync(p, "[1,2,3]"); return setEq(readAllow(p), [1, 2, 3]); })());
  t("readAllow: {chatIds:[...]} -> set", (() => { const p = f("obj"); writeFileSync(p, JSON.stringify({ chatIds: [4, 5] })); return setEq(readAllow(p), [4, 5]); })());
  t("readAllow: empty array -> EMPTY set (configured empty, NOT null)", (() => { const p = f("empty"); writeFileSync(p, "[]"); const s = readAllow(p); return s !== null && s.size === 0; })());
  t("readAllow: array filters non-numbers", (() => { const p = f("mixed"); writeFileSync(p, '[1,"x",2,null,3]'); return setEq(readAllow(p), [1, 2, 3]); })());
  // the BLACK-HOLE-prevention terminal states: unreadable ⇒ null (NOT a silent empty set)
  t("readAllow: corrupt JSON -> null (black-hole prevented)", (() => { const p = f("corrupt"); writeFileSync(p, "{not json"); return readAllow(p) === null; })());
  t("readAllow: bare string id -> null (wrong shape, not silent empty)", (() => { const p = f("str"); writeFileSync(p, '"12345"'); return readAllow(p) === null; })());
  t("readAllow: bare number -> null", (() => { const p = f("num"); writeFileSync(p, "123"); return readAllow(p) === null; })());
  t("readAllow: EISDIR (dir at path) -> null (EACCES-class, not silent empty)", (() => { const p = f("dir"); mkdirSync(p); return readAllow(p) === null; })());

  // ── TG-2 readOffset: FC-2 three-state ───────────────────────────────────────────────────────────────────────────
  t("readOffset: ENOENT -> 0 (legitimate first run)", readOffset(f("absent")) === 0);
  t("readOffset: valid number -> it", (() => { const p = f("num"); writeFileSync(p, "42"); return readOffset(p) === 42; })());
  t("readOffset: corrupt content -> 0 (self-heals on next write)", (() => { const p = f("corrupt"); writeFileSync(p, "not-a-number"); return readOffset(p) === 0; })());
  t("readOffset: negative -> treated corrupt -> 0", (() => { const p = f("neg"); writeFileSync(p, "-5"); return readOffset(p) === 0; })());
  t("readOffset: EISDIR -> null (refuse poll, no 24h replay)", (() => { const p = f("dir"); mkdirSync(p); return readOffset(p) === null; })());

  // ── TG-1 writeOffset: surfaces faults ───────────────────────────────────────────────────────────────────────────
  t("writeOffset: success -> true + persists value", (() => { const p = f("ok"); const ok = writeOffset(p, 7); return ok === true && readFileSync(p, "utf8") === "7"; })());
  t("writeOffset: fault (dir at path) -> false (visible, NOT a silent swallow)", (() => { const p = f("dir"); mkdirSync(p); return writeOffset(p, 9) === false; })());

  // ── FIXTURE 1: crash-recovery (a crash-left corrupt offset recovers: read->0, write, read-> new value) ───────────
  {
    const p = f("crash-offset"); writeFileSync(p, "\x00\x00garbage"); // crashed mid-write
    t("fixture[crash]: corrupt offset reads 0 (not null, not throw)", readOffset(p) === 0);
    t("fixture[crash]: a good write then recovers the real value", writeOffset(p, 55) === true && readOffset(p) === 55);
  }

  // ── FIXTURE 2: restart-idempotency (same write replayed -> same observable value; readAllow stable) ──────────────
  {
    const p = f("idem-offset");
    writeOffset(p, 100); writeOffset(p, 100);
    t("fixture[idem]: writeOffset replay -> same value (last-wins, no drift)", readOffset(p) === 100);
    const ap = f("idem-allow"); writeFileSync(ap, "[9,9,8]");
    t("fixture[idem]: readAllow stable across re-reads (set dedups)", setEq(readAllow(ap), [9, 8]) && setEq(readAllow(ap), [9, 8]));
  }

  // ── FIXTURE 3: concurrency-race (interleaved offset writes always read a valid finite number; corrupt allow=null) ─
  {
    const p = f("race-offset");
    for (let i = 0; i < 20; i++) {
      writeOffset(p, 1000 + i);
      const r = readOffset(p);
      if (r === null || !Number.isFinite(r)) throw new Error("FAILED: fixture[race] read saw a torn/garbage offset");
    }
    t("fixture[race]: interleaved offset writes always read a valid number", readOffset(p) === 1019);
    // the concurrency-visible BLACK-HOLE guard: a config that becomes corrupt mid-run ⇒ readAllow null ⇒ the loop refuses (never
    // flips to a silent empty allowlist that acks every pending approval).
    const ap = f("race-allow"); writeFileSync(ap, '{"chatIds": broken');
    t("fixture[race]: corrupt allow mid-run -> null (loop refuses, no silent black hole)", readAllow(ap) === null);
  }

  console.log("\nTG-1/TG-2/TG-5 swarm-tg-entry selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
