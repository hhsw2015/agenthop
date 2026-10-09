// Review-queue ledger write point (T5-5 producer) — the minimal "各一行" the adversarial-review dispatch workflow runs at
// 派单 / 交付, so the durable ledger has a producer for the dispatcher's suggestion-mode consumer to read:
//   open:  node <tsx> scripts/review-ledger.ts open <ticket> <seat> [author] [sha]  → markReviewOpen (one open record)
//   done:  node <tsx> scripts/review-ledger.ts done <ticket> <seat>                 → markReviewDone (atomic rename → .done)
// AS-N1: `author` is optional in the SYNTAX but REQUIRED for the record to count toward a suggestion. The consumer's
// phantom-depth guard counts an open record only when BOTH its seat AND its author resolve to a live session; an empty or
// unresolvable author ⇒ the record is excluded from the queue-depth signal (it is still written, for audit, but never advises
// scaling). Pass the submitting session's native sid as author. Full counting example (open then, on sign-off, done):
//   review-ledger.ts open feat-autoscale 01a0ff49-7a50-7393-9737-2402e68e4649 f32a0507-27bd-47d2-adea-9f30b87612ae aaea0db
//   review-ledger.ts done feat-autoscale 01a0ff49-7a50-7393-9737-2402e68e4649
// It wraps the SIGNED review-seat-autoscale ledger primitives (which validate ticket/seat ids and write atomically). AH_HOME
// overrides the home dir. The dispatcher's sweep READS this ledger and ADVISES the coordinator (SWARM_REVIEW_AUTOSCALE
// suggestion mode); it never spawns/reclaims a seat. Why a standalone CLI and not a swarm-dispatch.ts one-shot mode: a new
// one-shot argv would also need F44's isDispatcherLoopCommand one-shot exclusion updated, so a separate entry is cleaner.
import { homedir } from "node:os";
import { markReviewOpen, markReviewDone, reviewQueueDir } from "../packages/bus/src/swarm/review-seat-autoscale.js";

const [mode, ticket, seat, author, sha] = process.argv.slice(2);
const dir = reviewQueueDir(process.env.AH_HOME || homedir());
const fail = (m: string): never => { process.stderr.write(`review-ledger: ${m}\n`); process.exit(2); };

async function main(): Promise<void> {
  if (mode === "open") {
    if (!ticket || !seat) fail("usage: review-ledger open <ticket> <seat> [author] [sha]");
    await markReviewOpen({ ticket: ticket!, seat: seat!, author: author ?? "", sha: sha ?? "", sentSec: Math.floor(Date.now() / 1000) }, dir);
    process.stdout.write(`opened ${ticket}.${seat}\n`);
  } else if (mode === "done") {
    if (!ticket || !seat) fail("usage: review-ledger done <ticket> <seat>");
    await markReviewDone(ticket!, seat!, dir);
    process.stdout.write(`done ${ticket}.${seat}\n`);
  } else {
    fail("usage: review-ledger <open|done> <ticket> <seat> [author] [sha]");
  }
}

main().catch((e) => { process.stderr.write(`review-ledger: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
