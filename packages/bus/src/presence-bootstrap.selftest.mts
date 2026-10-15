/**
 * SP-BOOTSTRAP-FALLBACK (Chief Review 82be0ff): the presence daemon's startup write must go through the per-sid lock only. When
 * another writer (an agent publish in flight) holds that lock and no .pid exists yet, the daemon must HOLD — not fall back to an
 * unlocked write. Real runPresence, private home.  Run: node_modules/.bin/tsx packages/bus/src/presence-bootstrap.selftest.mts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const SID = "11111111-2222-4333-8444-555555555555";
const h = mkdtempSync(path.join(os.tmpdir(), "pb-"));
const pd = path.join(h, ".agenthop", "presence"); mkdirSync(pd, { recursive: true });
const pf = path.join(pd, `${SID}.pid`);
// a LIVE foreign holder (the parent process) owns the presence lock: an agent writer mid-publish
const holder = process.ppid;
mkdirSync(path.join(pd, `${SID}.lockd`)); writeFileSync(path.join(pd, `${SID}.lockd`, `${holder}.cafe00000000`), "");
writeFileSync(path.join(pd, `${SID}.lockd.hold.${holder}.cafe00000000`), "");
process.env.AGENTHOP_PID_FILE = pf;
const { runPresence } = await import("./presence.js");
const p = runPresence({ home: h } as any);
t("bootstrap HOLDS while another writer holds the lock: no .pid written (no unlocked fallback)", !existsSync(pf))
await p.stop();
t("shutdown while held: still nothing written or deleted", !existsSync(pf))
// positive control: lock free ⇒ the daemon writes its own record through the locked path
const h2 = mkdtempSync(path.join(os.tmpdir(), "pb2-"));
const pf2 = path.join(h2, ".agenthop", "presence", `${SID}.pid`);
process.env.AGENTHOP_PID_FILE = pf2;
const p2 = runPresence({ home: h2 } as any);
t("positive control: lock free ⇒ the daemon records its own pid, origin bus", readFileSync(pf2, "utf8") === String(process.pid) && /^origin=bus /.test(readFileSync(pf2.replace(/\.pid$/, ".origin"), "utf8")))
await p2.stop();
t("positive control: shutdown removes its own record", !existsSync(pf2))
console.log("all presence-bootstrap selftests passed");
process.exit(0);
