#!/usr/bin/env tsx
// swarm-tg-entry — the Telegram USER-ENTRY driver (thin IO). A user-entry peer to the console: it READS the core's frozen
// projections (decision batches here in v1) + pushes them to a bot, and PARSES the user's tap back into the SINGLE decision
// ledger (decision-batch DecisionsDoc). ZERO business logic — render/parse/scope/digest all come from the pure core
// (tg-entry.ts / decision-batch.ts / morning-digest.ts). DORMANT behind SWARM_TG_ENTRY. v1: notify + collect-approvals ONLY,
// NEVER executes a command (a verdict is only WRITTEN to the ledger; the coordinator's R17 chain re-injects).
//
// Credential discipline (§creds, same gate as vm-ctl): the bot token travels on STDIN into a 0600 file, NEVER argv/env.
//   seed:   printf %s '<token>' | tsx scripts/swarm-tg-entry.ts --seed-token
//   run:    SWARM_TG_ENTRY=1 tsx scripts/swarm-tg-entry.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import https from "node:https";
import { renderProjection, parseUpdate, type RenderSpec, type TgUpdate } from "../packages/bus/src/swarm/tg-entry.js";
import { listBatches, readBatch, writeDecisions } from "../packages/bus/src/swarm/decision-batch-store.js";

const HOME = homedir();
const tgDir = (): string => path.join(HOME, ".agenthop", "tg");
const tokenFile = (): string => path.join(tgDir(), "bot.token");
const allowFile = (): string => path.join(tgDir(), "allow.json");
const offsetFile = (): string => path.join(tgDir(), "offset");
const notifiedFile = (): string => path.join(tgDir(), "notified-batches.json");

const enabled = (env = process.env): boolean => /^(1|true|yes|on)$/i.test(env.SWARM_TG_ENTRY ?? "");

/** Read the 0600 token file; throws a clear error if absent (the user seeds it with --seed-token). */
function readToken(): string {
  const f = tokenFile();
  if (!existsSync(f)) throw new Error(`no bot token at ${f} — seed it: printf %s '<token>' | ${process.argv[1]} --seed-token`);
  return readFileSync(f, "utf8").trim();
}
/** The allowlist of numeric chat_ids (the user, usually one). Absent/corrupt -> empty (every inbound then ignored). */
function readAllow(): Set<number> {
  try { const a = JSON.parse(readFileSync(allowFile(), "utf8")); return new Set((Array.isArray(a) ? a : a?.chatIds ?? []).filter((n: unknown): n is number => typeof n === "number")); }
  catch { return new Set(); }
}
const readOffset = (): number => { try { return Number(readFileSync(offsetFile(), "utf8").trim()) || 0; } catch { return 0; } };
const writeOffset = (n: number): void => { try { writeFileSync(offsetFile(), String(n), { mode: 0o600 }); } catch { /* best-effort; a replayed update is deduped by consume-once */ } };
const readNotified = (): Set<string> => { try { return new Set(JSON.parse(readFileSync(notifiedFile(), "utf8"))); } catch { return new Set(); } };
const writeNotified = (s: Set<string>): void => { try { writeFileSync(notifiedFile(), JSON.stringify([...s]), { mode: 0o600 }); } catch { /* best-effort; a double-notify is benign (consume-once dedups the verdict) */ } };

/** One Telegram Bot API call over https. Resolves the parsed JSON `result`, or rejects. */
function tg(token: string, method: string, body: unknown): Promise<any> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "api.telegram.org", path: `/bot${token}/${method}`, method: "POST", headers: { "content-type": "application/json", "content-length": data.length }, timeout: 65000 },
      (res) => { let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { const j = JSON.parse(buf); j.ok ? resolve(j.result) : reject(new Error(j.description || "tg error")); } catch (e) { reject(e); } }); },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("tg timeout")));
    req.write(data); req.end();
  });
}

/** Send a RenderSpec. v1: message + inline keyboard fully; a photo/card falls back to its caption (no rasterizer yet); a
 *  document attachment is sent when the ref is a readable local file, else its pointer rides in the text. */
async function send(token: string, chatId: number, spec: RenderSpec): Promise<void> {
  const reply_markup = spec.keyboard ? { inline_keyboard: spec.keyboard.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) } : undefined;
  if (spec.attachment?.kind === "document" && existsSync(spec.attachment.ref) && statSync(spec.attachment.ref).isFile()) {
    // ponytail: document upload is multipart; v1 sends the text + the pointer, full sendDocument multipart is a follow-up.
    await tg(token, "sendMessage", { chat_id: chatId, text: `${spec.text}\n(doc: ${spec.attachment.ref})`, ...(reply_markup ? { reply_markup } : {}) });
    return;
  }
  const msg = await tg(token, "sendMessage", { chat_id: chatId, text: spec.text, ...(reply_markup ? { reply_markup } : {}) });
  if (spec.primitive === "pin" && msg?.message_id) await tg(token, "pinChatMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {}); // RED alert
}

/** OUTBOUND: push any decision batch not yet notified to each allowlisted chat (one message per item, with its scope keyboard). */
async function notifyNewBatches(token: string, allow: Set<number>): Promise<void> {
  const notified = readNotified();
  for (const batchId of listBatches(HOME)) {
    if (notified.has(batchId)) continue;
    const batch = readBatch(HOME, batchId);
    if (!batch) continue;
    for (const chatId of allow) for (const item of batch.items) await send(token, chatId, renderProjection({ kind: "decision", batchId, item })).catch((e) => console.error(`tg send failed: ${e instanceof Error ? e.message : e}`));
    notified.add(batchId); writeNotified(notified);
  }
}

/** INBOUND: long-poll getUpdates; a tap -> parseUpdate -> write the SINGLE ledger (never execute). */
async function pollOnce(token: string, allow: Set<number>): Promise<void> {
  const updates = await tg(token, "getUpdates", { offset: readOffset(), timeout: 50, allowed_updates: ["callback_query", "message"] });
  for (const u of updates ?? []) {
    writeOffset(u.update_id + 1);
    const cq = u.callback_query;
    const upd: TgUpdate = cq
      ? { chatId: cq.message?.chat?.id, callbackData: cq.data }
      : { chatId: u.message?.chat?.id, text: u.message?.text };
    const r = parseUpdate(upd, allow, Math.floor(Date.now() / 1000));
    if (r.kind === "ignore") { if (cq) await tg(token, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {}); continue; }
    try { writeDecisions(HOME, r.doc); if (cq) await tg(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "recorded" }).catch(() => {}); }
    catch (e) { if (cq) await tg(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "already decided" }).catch(() => {}); console.error(`tg verdict not written (likely already consumed): ${e instanceof Error ? e.message : e}`); }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--seed-token")) {
    const tok = readFileSync(0, "utf8").trim(); // stdin, NEVER argv
    if (!tok) { console.error("no token on stdin"); process.exit(2); }
    mkdirSync(tgDir(), { recursive: true });
    writeFileSync(tokenFile(), tok, { mode: 0o600 });
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
