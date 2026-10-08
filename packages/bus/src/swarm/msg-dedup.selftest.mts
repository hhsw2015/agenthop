import { msgFingerprint, isDuplicate, pruneSeen, recordSeen, ringAdmit, DEDUP_WINDOW_SEC, RING_QUEUE_CAP, type SeenMap } from "./msg-dedup.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- fingerprint ---
t("fingerprint deterministic", msgFingerprint("a", "hi") === msgFingerprint("a", "hi"));
t("fingerprint differs by sender", msgFingerprint("a", "hi") !== msgFingerprint("b", "hi"));
t("fingerprint differs by text", msgFingerprint("a", "hi") !== msgFingerprint("a", "ho"));
t("fingerprint no (sender,text) collision via delimiter", msgFingerprint("ab", "c") !== msgFingerprint("a", "bc"));
// MD-P2-1: the key is an unambiguous canonical encoding — distinct pairs NEVER share a key (a 32-bit hash could, silently
// dropping a DISTINCT message), and NUL/digits in the content can't make two different pairs collide.
t("MD-P2-1: NUL in content does not collide", msgFingerprint("a\u0000b", "c") !== msgFingerprint("a", "\u0000bc"));
t("MD-P2-1: digit content can't forge the length prefix", msgFingerprint("1:x", "y") !== msgFingerprint("1", ":xy") && msgFingerprint("", "5:abc") !== msgFingerprint("5:ab", "c"));
t("MD-P2-1: distinct texts same sender never share a key (no hash collision)", msgFingerprint("s", "alpha") !== msgFingerprint("s", "bravo") && msgFingerprint("s", "") !== msgFingerprint("s", " "));
t("MD-P2-1: identical pairs DO share a key (true dedup preserved)", msgFingerprint("s", "same") === msgFingerprint("s", "same"));

// --- isDuplicate ---
const fp = msgFingerprint("a", "hi");
t("fresh fp not duplicate", isDuplicate({}, fp, 1000) === false);
t("recorded fp is duplicate within window", isDuplicate({ [fp]: 1000 }, fp, 1000 + DEDUP_WINDOW_SEC - 1) === true);
t("recorded fp not duplicate past window", isDuplicate({ [fp]: 1000 }, fp, 1000 + DEDUP_WINDOW_SEC) === false);
t("bad clock -> not duplicate (fail-safe, deliver)", isDuplicate({ [fp]: 1000 }, fp, NaN) === false);
// MD-P2-2: a FUTURE stamp (ts > now, e.g. after a clock rewind) is NOT duplicate evidence
t("MD-P2-2: future stamp (clock rewound) -> not duplicate (deliver)", isDuplicate({ [fp]: 1000 }, fp, 100) === false);
t("MD-P2-2: exact-now stamp is still a duplicate (boundary)", isDuplicate({ [fp]: 1000 }, fp, 1000) === true);

// --- pruneSeen ---
const seen: SeenMap = { a: 1000, b: 1000 + DEDUP_WINDOW_SEC - 1 };
t("prune drops expired, keeps fresh", (() => { const p = pruneSeen(seen, 1000 + DEDUP_WINDOW_SEC); return p.a === undefined && p.b === (1000 + DEDUP_WINDOW_SEC - 1); })());
t("prune bad clock -> unchanged", pruneSeen(seen, NaN) === seen);
t("prune pure (input untouched)", (() => { pruneSeen(seen, 1000 + DEDUP_WINDOW_SEC); return seen.a === 1000; })());

// --- recordSeen immutable ---
const base: SeenMap = { x: 1000 };
const rec = recordSeen(base, fp, 1010);
t("recordSeen returns new map with fp", rec[fp] === 1010 && rec.x === 1000);
t("recordSeen input untouched", (base as any)[fp] === undefined);
t("recordSeen prunes expired on write", recordSeen({ old: 1 }, fp, 1000 + DEDUP_WINDOW_SEC).old === undefined);

// --- ringAdmit ---
const r1 = ringAdmit({ queueLen: 0, seen: {}, fp, nowSec: 1000 });
t("ringAdmit delivers first time", r1.action === "deliver" && r1.seen[fp] === 1000);
const r2 = ringAdmit({ queueLen: 1, seen: r1.seen, fp, nowSec: 1010 });
t("ringAdmit drops duplicate within window", r2.action === "drop-duplicate" && r2.seen === r1.seen);
const r3 = ringAdmit({ queueLen: 1, seen: r1.seen, fp, nowSec: 1000 + DEDUP_WINDOW_SEC });
t("ringAdmit delivers again past window", r3.action === "deliver");
const rFull = ringAdmit({ queueLen: RING_QUEUE_CAP, seen: {}, fp, nowSec: 1000 });
t("ringAdmit stops ring when queue at cap", rFull.action === "stop-ring" && rFull.seen !== undefined);
t("ringAdmit cap wins over dedup", ringAdmit({ queueLen: RING_QUEUE_CAP, seen: { [fp]: 1000 }, fp, nowSec: 1001 }).action === "stop-ring");
t("ringAdmit bad clock delivers (never silent-drop)", ringAdmit({ queueLen: 0, seen: { [fp]: 1000 }, fp, nowSec: NaN }).action === "deliver");
t("ringAdmit clock-rewind (future stamp) delivers, not drop (MD-P2-2)", ringAdmit({ queueLen: 1, seen: { [fp]: 1000 }, fp, nowSec: 100 }).action === "deliver");

console.log("all msg-dedup selftests passed");
