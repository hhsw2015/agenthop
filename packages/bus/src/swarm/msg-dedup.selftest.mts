import { msgFingerprint, isDuplicate, pruneSeen, recordSeen, ringAdmit, DEDUP_WINDOW_SEC, RING_QUEUE_CAP, type SeenMap } from "./msg-dedup.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- fingerprint ---
t("fingerprint deterministic", msgFingerprint("a", "hi") === msgFingerprint("a", "hi"));
t("fingerprint differs by sender", msgFingerprint("a", "hi") !== msgFingerprint("b", "hi"));
t("fingerprint differs by text", msgFingerprint("a", "hi") !== msgFingerprint("a", "ho"));
t("fingerprint no (sender,text) collision via delimiter", msgFingerprint("ab", "c") !== msgFingerprint("a", "bc"));

// --- isDuplicate ---
const fp = msgFingerprint("a", "hi");
t("fresh fp not duplicate", isDuplicate({}, fp, 1000) === false);
t("recorded fp is duplicate within window", isDuplicate({ [fp]: 1000 }, fp, 1000 + DEDUP_WINDOW_SEC - 1) === true);
t("recorded fp not duplicate past window", isDuplicate({ [fp]: 1000 }, fp, 1000 + DEDUP_WINDOW_SEC) === false);
t("bad clock -> not duplicate (fail-safe, deliver)", isDuplicate({ [fp]: 1000 }, fp, NaN) === false);

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

console.log("all msg-dedup selftests passed");
