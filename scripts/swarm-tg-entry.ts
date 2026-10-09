#!/usr/bin/env tsx
// swarm-tg-entry — the Telegram USER-ENTRY driver (thin IO). A user-entry peer to the console: it READS the core's frozen
// projections (decision batches in v1) + pushes them to a bot, and PARSES the user's tap into the SINGLE decision ledger via
// the atomic merge recordDecision. ZERO business logic — render/parse/scope/merge/digest all live in the pure core. DORMANT
// behind SWARM_TG_ENTRY. v1: notify + collect-approvals ONLY, NEVER executes a command (a verdict is only WRITTEN; the
// coordinator's R17 chain re-injects).
//
// Credential discipline (§creds, vm-ctl gate): the bot token travels on STDIN into a 0600 file, NEVER argv/env.
//   seed:   printf %s '<token>' | tsx scripts/swarm-tg-entry.ts --seed-token
//   run:    SWARM_TG_ENTRY=1 tsx scripts/swarm-tg-entry.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { renderProjection, parseUpdate, type RenderSpec, type TgUpdate } from "../packages/bus/src/swarm/tg-entry.js";
import { listBatchesStrict, readBatch, recordDecision } from "../packages/bus/src/swarm/decision-batch-store.js";
import type { Verdict, ApprovalScope } from "../packages/bus/src/swarm/decision-batch.js";

const HOME = homedir();
const tgDir = (): string => path.join(HOME, ".agenthop", "tg");
const tokenFile = (): string => path.join(tgDir(), "bot.token");
const allowFile = (): string => path.join(tgDir(), "allow.json");
const offsetFile = (): string => path.join(tgDir(), "offset");
const notifiedFile = (): string => path.join(tgDir(), "notified-batches.json");

const enabled = (env = process.env): boolean => /^(1|true|yes|on)$/i.test(env.SWARM_TG_ENTRY ?? "");

function readToken(): string {
  const f = tokenFile();
  if (!existsSync(f)) throw new Error(`no bot token at ${f} — seed it: printf %s '<token>' | ${process.argv[1]} --seed-token`);
  return readFileSync(f, "utf8").trim();
}
function readAllow(): Set<number> {
  try { const a = JSON.parse(readFileSync(allowFile(), "utf8")); return new Set((Array.isArray(a) ? a : a?.chatIds ?? []).filter((n: unknown): n is number => typeof n === "number")); }
  catch { return new Set(); }
}
const readOffset = (): number => { try { return Number(readFileSync(offsetFile(), "utf8").trim()) || 0; } catch { return 0; } };
const writeOffset = (n: number): void => { try { writeFileSync(offsetFile(), String(n), { mode: 0o600 }); } catch { /* best-effort; a replayed update is deduped by consume-once */ } };
const readNotified = (): Set<string> => { try { return new Set(JSON.parse(readFileSync(notifiedFile(), "utf8"))); } catch { return new Set(); } };
const writeNotified = (s: Set<string>): void => { try { writeFileSync(notifiedFile(), JSON.stringify([...s]), { mode: 0o600 }); } catch { /* best-effort */ } };

// TG-P2-3 (round 3): a compact ref that round-trips ANY legal batchId/itemId inside Telegram's 64-byte callback_data. The ref is
// `<batchHash32>.<itemIndex>` — the driver (which holds the batch) resolves it back; no arbitrary id is ever embedded. 32 hex =
// 128 bits: a birthday collision is ~2^64 batches (astronomically beyond reach), and even so resolveRef REJECTS an ambiguous
// hash (it never first-hits a wrong batch). callback = `d|<32hex>.<idx>|<verdict>[|<scope>]` ≈ 55 bytes ≤ 64.
const batchRef = (batchId: string): string => createHash("sha256").update(batchId).digest("hex").slice(0, 32);
const encodeRef = (batchId: string, idx: number): string => `${batchRef(batchId)}.${idx}`;
/** Resolve a callback ref back to its batch+item. Returns null ONLY on a CONFIRMED-unresolvable ref — no batch matches the hash
 *  (genuinely gone), the index is out of range, or (TG-P2-3) MORE THAN ONE batch matches the hash (ambiguous: never guess, never
 *  first-hit a wrong batch). A dir/batch READ ERROR PROPAGATES (listBatchesStrict/readBatch throw) so the caller keeps the retry
 *  obligation instead of treating an unreadable store as "expired" (TG-P2-1). */
function resolveRef(ref: string): { batchId: string; itemId: string } | null {
  const dot = ref.lastIndexOf(".");
  if (dot < 0) return null;
  const bh = ref.slice(0, dot), idx = Number(ref.slice(dot + 1));
  if (!bh || !Number.isInteger(idx) || idx < 0) return null;
  const matches = listBatchesStrict(HOME).filter((b) => batchRef(b) === bh);
  if (matches.length !== 1) return null; // 0 = gone (terminal expire); >1 = ambiguous collision ⇒ never resolve to a guess
  const item = readBatch(HOME, matches[0]!)?.items[idx];
  return item ? { batchId: matches[0]!, itemId: item.id } : null;
}

function tg(token: string, method: string, body: unknown): Promise<any> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "api.telegram.org", path: `/bot${token}/${method}`, method: "POST", headers: { "content-type": "application/json", "content-length": data.length }, timeout: 65000 },
      (res) => { let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { const j = JSON.parse(buf); j.ok ? resolve(j.result) : reject(new Error(j.description || "tg error")); } catch (e) { reject(e); } }); },
    );
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("tg timeout")));
    req.write(data); req.end();
  });
}

/** Send a RenderSpec (throws on API failure so the caller can keep a retry obligation). v1: message + inline keyboard; a
 *  photo/card falls back to its caption (no rasterizer yet); a document rides as a pointer in text. */
async function send(token: string, chatId: number, spec: RenderSpec): Promise<void> {
  const reply_markup = spec.keyboard ? { inline_keyboard: spec.keyboard.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) } : undefined;
  const text = spec.attachment?.kind === "document" ? `${spec.text}\n(doc: ${spec.attachment.ref})` : spec.text;
  const msg = await tg(token, "sendMessage", { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) });
  if (spec.primitive === "pin" && msg?.message_id) await tg(token, "pinChatMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
}

/** OUTBOUND: push each not-yet-notified decision batch. TG-P2-2: a batch is marked notified ONLY after FULL successful
 *  delivery to every allowlisted recipient; a zero-recipient run or any send failure leaves it un-notified to retry. */
async function notifyNewBatches(token: string, allow: Set<number>): Promise<void> {
  if (allow.size === 0) return; // no recipient => no delivery => never a completion proof
  const notified = readNotified();
  for (const batchId of listBatchesStrict(HOME)) { // strict: a read glitch throws -> the loop retries; never a silently-skipped notify
    if (notified.has(batchId)) continue;
    const batch = readBatch(HOME, batchId);
    if (!batch) continue;
    let allOk = true;
    for (const chatId of allow) for (let i = 0; i < batch.items.length; i++) {
      try { await send(token, chatId, renderProjection({ kind: "decision", item: batch.items[i]!, ref: encodeRef(batchId, i) })); }
      catch (e) { allOk = false; console.error(`swarm-tg-entry: notify send failed (will retry): ${e instanceof Error ? e.message : e}`); }
    }
    if (allOk) { notified.add(batchId); writeNotified(notified); } // only a fully-delivered batch is done
  }
}

/** INBOUND: long-poll getUpdates; a tap -> parseUpdate -> resolve ref -> recordDecision (merge). TG-P2-1: the offset is
 *  committed ONLY after a TERMINAL outcome (recorded / consumed / unknown-item / ignored / expired-ref); a transient IO error
 *  or a contended lock STOPS this poll WITHOUT advancing, so the same update is retried — never a silent "already decided". */
async function pollOnce(token: string, allow: Set<number>): Promise<void> {
  const updates = await tg(token, "getUpdates", { offset: readOffset(), timeout: 50, allowed_updates: ["callback_query", "message"] });
  for (const u of updates ?? []) {
    const cq = u.callback_query;
    const chatId: unknown = cq ? cq.message?.chat?.id : u.message?.chat?.id;
    const ack = async (text?: string): Promise<void> => { if (cq) await tg(token, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {}); };
    // first-contact: surface an un-allowlisted chat_id so the user can add it (design detail); terminal -> advance.
    if (typeof chatId === "number" && !allow.has(chatId)) { console.error(`swarm-tg-entry: message from un-allowlisted chat_id ${chatId} — add it to ${allowFile()} to enable`); writeOffset(u.update_id + 1); await ack(); continue; }
    const upd: TgUpdate = cq ? { chatId, callbackData: cq.data } : { chatId, text: u.message?.text };
    const r = parseUpdate(upd, allow);
    if (r.kind === "ignore") { writeOffset(u.update_id + 1); await ack(); continue; }
    // TG-P2-1: resolveRef throws on a STORE READ ERROR (unreadable batches dir/batch.json) — that is TRANSIENT, so STOP the poll
    // WITHOUT advancing the offset; the same tap is retried next loop (never a false "expired" that permanently skips an approval).
    let resolved: { batchId: string; itemId: string } | null;
    try { resolved = resolveRef(r.ref); }
    catch (e) { console.error(`swarm-tg-entry: ref lookup read error (NOT advancing offset, will retry): ${e instanceof Error ? e.message : e}`); return; }
    if (!resolved) { writeOffset(u.update_id + 1); await ack("expired"); continue; } // CONFIRMED gone/ambiguous -> terminal
    const decision = { id: resolved.itemId, verdict: r.verdict as Verdict, ...(r.scope ? { scope: r.scope as ApprovalScope } : {}) };
    let outcome: "recorded" | "consumed" | "unknown-item" | "contended";
    try { outcome = recordDecision(HOME, resolved.batchId, decision, Math.floor(Date.now() / 1000)); }
    catch (e) { console.error(`swarm-tg-entry: recordDecision transient error (NOT advancing offset, will retry): ${e instanceof Error ? e.message : e}`); return; } // transient IO -> retry this update next poll
    if (outcome === "contended") return; // a concurrent holder — retry this update next poll (do NOT advance)
    writeOffset(u.update_id + 1); // terminal
    await ack(outcome === "recorded" ? "recorded" : outcome === "consumed" ? "already decided" : "unknown");
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--seed-token")) {
    const tok = readFileSync(0, "utf8").trim(); // stdin, NEVER argv
    if (!tok) { console.error("no token on stdin"); process.exit(2); }
    mkdirSync(tgDir(), { recursive: true });
    // TG-P1-3: 0600 from the FIRST byte — write a 0600 temp and atomic-rename over the target (replaces a pre-existing 0644;
    // a post-hoc chmod would leave a window at the old mode).
    const tmp = path.join(tgDir(), `.bot.token.tmp-${process.pid}`);
    writeFileSync(tmp, tok, { mode: 0o600 });
    renameSync(tmp, tokenFile());
    console.error(`wrote ${tokenFile()} (0600). Next: put your numeric chat_id in ${allowFile()} and SWARM_TG_ENTRY=1 to run.`);
    return;
  }
  if (!enabled()) { console.error("swarm-tg-entry: SWARM_TG_ENTRY is off (dormant). Set SWARM_TG_ENTRY=1 to run."); process.exit(0); }
  const token = readToken();
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  console.error("swarm-tg-entry: up (notify + collect-approvals; never executes).");
  while (!stop) {
    const allow = readAllow(); // re-read each loop so the user can add a chat_id without a restart
    try { await notifyNewBatches(token, allow); await pollOnce(token, allow); }
    catch (e) { console.error(`swarm-tg-entry loop error (continuing): ${e instanceof Error ? e.message : e}`); await new Promise((r) => setTimeout(r, 3000)); }
  }
  console.error("swarm-tg-entry: stopped.");
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
