// coord-inbox — send one durable message to the CURRENT coordinator (#1032 B). For hand-written seat scripts (cc copies, reports,
// review delivery) that must never hard-code the coordinator's session id. Resolves SWARM_COORDINATOR via resolveCoordinatorInbox and
// publishes through writeInbox (the normal delivery primitive, so inbox-wake fires as usual).
//
//   SWARM_COORDINATOR=<sid|handle> node <tsx> scripts/coord-inbox.ts [--from LABEL] [--title T] [--task-ref R] [--key K] <text…>
//   echo "body" | … scripts/coord-inbox.ts --stdin [flags]
//
// --key makes the send idempotent (a re-run with the same key publishes at most once). Prints the outcome and the resolved sid.
// Exit 2 on a usage error or when the coordinator cannot be resolved (nothing is written). AH_HOME overrides the home dir.
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { writeInbox } from "../packages/bus/src/inbox.js";
import { resolveCoordinatorInbox, CoordinatorInboxError } from "../packages/bus/src/swarm/coord-inbox.js";
import { isValidSessionId } from "../packages/bus/src/send-fallback.js";

const fail = (m: string): never => { process.stderr.write(`coord-inbox: ${m}\n`); process.exit(2); };
const args = process.argv.slice(2);
let from = "coord-inbox", title: string | undefined, taskRef: string | undefined, key: string | undefined, useStdin = false;
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const val = (): string => { const v = args[++i]; if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`); return v!; };
  if (a === "--from") from = val();
  else if (a === "--title") title = val();
  else if (a === "--task-ref") taskRef = val();
  else if (a === "--key") key = val();
  else if (a === "--stdin") useStdin = true;
  else if (a === "--") { words.push(...args.slice(i + 1)); break; }
  else if (a.startsWith("--")) fail(`unknown flag: ${a}`);
  else words.push(a);
}
// writeInbox silently treats an unsafe key as "no key" (non-deduped). A caller who asked for idempotency must not get a silent
// double-send, so reject such a key here instead of letting it degrade.
if (key !== undefined && !/^[A-Za-z0-9._-]{1,120}$/.test(key)) fail(`--key must match [A-Za-z0-9._-]{1,120} (got ${JSON.stringify(key)})`);
const text = useStdin ? readFileSync(0, "utf8") : words.join(" ");
if (!text.trim()) fail("usage: coord-inbox [--from L] [--title T] [--task-ref R] [--key K] <text…> | --stdin");

const home = process.env.AH_HOME || homedir();
let sid: string;
try { sid = resolveCoordinatorInbox(home, process.env); }
catch (e) {
  // SWARM_COORDINATOR is the coordinator's ROLE box key; the role box has no presence of its own (the live coordinator session has
  // a different sid), so "does not resolve to a live session" is the normal case. When the key itself is a full, safe session id,
  // deliver to that durable box directly. Unset / a short handle / an unsafe id still refuse (never guess an address).
  const ref = (process.env.SWARM_COORDINATOR ?? "").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref) && isValidSessionId(ref)) sid = ref;
  else fail(e instanceof CoordinatorInboxError ? e.message : `resolve failed: ${(e as Error).message}`);
}
const res = writeInbox(home, sid!, { from, fromLabel: from, text, via: "local", ts: Date.now(), ...(title ? { title } : {}), ...(taskRef ? { taskRef } : {}) }, key);
process.stdout.write(`${res} → ${sid!}\n`);
