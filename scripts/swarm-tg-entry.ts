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
import http from "node:http";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { renderProjection, parseUpdate, selectProxyUrl, buildTgVerdictReceipt, buildTgMessageReceipt, obligationReceiptValue, tgReceiptObligationDir, srcTag, tgIdempotencyKey, TG_ACK_TEXT, type RenderSpec, type TgUpdate, type ReceiptObligation } from "../packages/bus/src/swarm/tg-entry.js";
import { listBatchesStrict, readBatch, readConsumedResult, recordDecision } from "../packages/bus/src/swarm/decision-batch-store.js";
import { enqueueQueue, drainQueue } from "../packages/bus/src/swarm/tg-queue.js";
import { enforceScope, type Verdict, type ApprovalScope } from "../packages/bus/src/swarm/decision-batch.js";
import { writeInbox } from "../packages/bus/src/inbox.js";
import { resolveSession, listSessions } from "../packages/bus/src/swarm/task-liveness.js";
import { installInboxWake } from "../packages/bus/src/swarm/inbox-wake.js";

const HOME = homedir();
const tgDir = (): string => path.join(HOME, ".agenthop", "tg");
const tokenFile = (): string => path.join(tgDir(), "bot.token");
const allowFile = (): string => path.join(tgDir(), "allow.json");
const offsetFile = (): string => path.join(tgDir(), "offset");
const notifiedFile = (): string => path.join(tgDir(), "notified-batches.json");

// EXCEPTION to the 2026-10-10 "flags default ON" ruling: SWARM_TG_ENTRY stays OPT-IN (default OFF). The bridge needs a
// user-seeded bot token + allow-list; defaulting ON would spin an errored bridge on every host with no token. So this keeps the
// opt-in reader (NOT flagDefaultOn) — the user must explicitly start the bridge (v1 red line: "user starts the bridge").
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

// Proxy support (bring-up: this host's direct api.telegram.org is firewalled; a system HTTP proxy tunnels it). A zero-dependency
// CONNECT-tunnel agent: HTTP CONNECT to the proxy, then TLS over the tunnel — so https.request keeps doing response parsing. No
// proxy env ⇒ undefined agent ⇒ https.request connects DIRECTLY (byte-for-byte the old behavior). One agent per proxy URL. Token
// discipline untouched (the token only rides in the request PATH, as before, never the proxy).
const proxyAgents = new Map<string, https.Agent>();
const CONNECT_DEADLINE_MS = 30000; // bounds CONNECT + the TLS handshake TOGETHER (TGP-2), so a stalled proxy can't hang the loop
function proxyAgentFor(host: string): https.Agent | undefined {
  const url = selectProxyUrl(process.env, host);
  if (!url) return undefined; // no proxy env ⇒ direct connect, zero behavior change
  const cached = proxyAgents.get(url);
  if (cached) return cached;
  const agent = new https.Agent({ keepAlive: false });
  (agent as unknown as { createConnection: (opts: { host: string; port?: number }, cb: (e: Error | null, s?: tls.TLSSocket) => void) => void }).createConnection = (opts, cb) => {
    // Validate the proxy INSIDE createConnection so a bad config SURFACES as a connect error (never a silent direct downgrade, TGP-1).
    let pu: URL;
    // TGP-1: NEVER echo the raw proxy URL in an error — it may carry user:password (the loop catch logs the message). Report the
    // config shape / a credential-STRIPPED host:port only.
    try { pu = new URL(url); } catch { cb(new Error("invalid proxy URL (unparseable; check HTTPS_PROXY/HTTP_PROXY — value not echoed)")); return; }
    if (pu.protocol !== "http:") { cb(new Error(`unsupported proxy scheme ${pu.protocol} for ${pu.hostname}:${pu.port || "(default)"} — only http:// is supported (credentials omitted)`)); return; } // reject, don't downgrade (TGP-1)
    const targetAuthority = `${opts.host}:${opts.port ?? 443}`;
    const headers: Record<string, string> = { host: targetAuthority }; // CONNECT request-target AND Host = the TARGET authority (TGP-1)
    if (pu.username) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString("base64")}`;
    let settled = false;
    let ts: tls.TLSSocket | null = null;
    const creq = http.request({ host: pu.hostname, port: Number(pu.port) || 80, method: "CONNECT", path: targetAuthority, headers });
    const deadline = setTimeout(() => { if (!settled) { settled = true; try { creq.destroy(); } catch { /* */ } try { ts?.destroy(); } catch { /* */ } cb(new Error("proxy CONNECT/TLS handshake timeout")); } }, CONNECT_DEADLINE_MS);
    const done = (err: Error | null, sock?: tls.TLSSocket): void => { if (settled) return; settled = true; clearTimeout(deadline); cb(err, sock); };
    creq.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); done(new Error(`proxy CONNECT -> ${res.statusCode}`)); return; }
      ts = tls.connect({ socket, servername: opts.host, host: opts.host, port: opts.port ?? 443 });
      ts.once("secureConnect", () => done(null, ts!));
      ts.once("error", (e) => { try { ts?.destroy(); } catch { /* */ } done(e); });
    });
    creq.once("error", (e) => done(e));
    creq.end();
  };
  proxyAgents.set(url, agent);
  return agent;
}

function tg(token: string, method: string, body: unknown, timeoutMs = 65000): Promise<any> {
  const data = Buffer.from(JSON.stringify(body));
  const agent = proxyAgentFor("api.telegram.org"); // undefined ⇒ direct (no proxy env)
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "api.telegram.org", path: `/bot${token}/${method}`, method: "POST", headers: { "content-type": "application/json", "content-length": data.length }, timeout: timeoutMs, ...(agent ? { agent } : {}) },
      (res) => { let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { const j = JSON.parse(buf); j.ok ? resolve(j.result) : reject(new Error(j.description || "tg error")); } catch (e) { reject(e); } }); },
    );
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("tg timeout")));
    req.write(data); req.end();
  });
}

// Inbound immediacy (TGP-3): forward a receipt to the coordinator inbox as a DURABLE, IDEMPOTENT publish (writeInbox with a stable
// idempotency key = exactly-once credential protocol; a replay dedups to "already", a write of a genuinely new message fires the
// installed inbox-wake hook ⇒ sub-second wake). Returns sent/retry/skip so the caller ties the TG offset to a confirmed handoff:
//   skip  = no coordinator configured ⇒ permanent no-op (advance; the verdict is already in the ledger).
//   retry = coordinator SET but not resolvable yet, or a write fault ⇒ KEEP the update (do not advance), re-poll (idempotent).
//   sent  = durably handed off. NOTIFY ONLY — never executes; the coordinator's re-injection chain does the work.
function forwardToCoordinator(fields: { text: string; taskRef: string; title: string }, idempotencyKey: string): "sent" | "retry" | "skip" {
  try {
    const coord = process.env.SWARM_COORDINATOR;
    if (!coord || !coord.trim()) return "skip";
    const coordSid = resolveSession(coord, listSessions(HOME));
    if (!coordSid) return "retry"; // transient: coordinator not resolvable on this machine yet
    const res = writeInbox(HOME, coordSid, { from: "swarm-tg-entry", fromLabel: "tg-entry", text: fields.text, taskRef: fields.taskRef, title: fields.title, via: "local", ts: Date.now() }, idempotencyKey);
    // TGP-3a: ONLY a CONFIRMED publication discharges. "published" = this message landed; "already" = the same event was already
    // published (replay dedup). "deferred"/"pending"/"unknown" are NOT confirmed (a pending credential has no message body yet) ⇒
    // keep the retry responsibility (offset NOT advanced), re-poll (idempotent on the same key).
    return (res === "published" || res === "already") ? "sent" : "retry";
  } catch (e) { console.error(`swarm-tg-entry: coordinator forward failed (will retry, offset NOT advanced): ${e instanceof Error ? e.message : e}`); return "retry"; }
}

// TGP-6 ack dedup: fire the immediate TG-side read-receipt at most once per update_id (the offset may not advance on a forward
// retry, so an update can re-poll — don't re-ack each time). Pruned below the committed offset each poll.
const ackedUpdates = new Set<number>();

// TGP-4 (TG-r5): the durable receipt-obligation drain. For each obligation (captured at record time, keyed by update_id), the
// receipt VALUE is resolved from the AUTHORITATIVE consumed result (readConsumedResult — the digest-verified consumed projection,
// NOT the orphan-inclusive live fold): not-sealed ⇒ the recorded value; sealed+present ⇒ the authoritative final; sealed+absent ⇒
// the tap was orphaned (the store signals its own re-batch) ⇒ DROP; unknown ⇒ retry. The forward is keyed by update_id so a
// re-poll/restart/dual-instance dedups (writeInbox publishOnce). A release/ack fault is tracked in receiptStuck (DO-P2-2).
const receiptStuck = new Set<string>();
async function drainReceiptObligations(): Promise<void> {
  try {
    await drainQueue(tgReceiptObligationDir(HOME), (rec) => {
      const ob = rec as Partial<ReceiptObligation>;
      if (!ob || typeof ob !== "object" || typeof ob.updateId !== "number" || typeof ob.batchId !== "string" || typeof ob.itemId !== "string" || !ob.recordedValue) return "sent"; // shape-invalid ⇒ discharge
      let authority: { consumed: true; itemValue: { verdict: Verdict; scope?: ApprovalScope } | null } | { consumed: false } | { consumed: "unknown" };
      try {
        const cr = readConsumedResult(HOME, ob.batchId);
        if (cr.consumed === true) { const d = cr.doc.decisions.find((x) => x.id === ob.itemId); authority = { consumed: true, itemValue: d ? { verdict: d.verdict, ...(d.scope ? { scope: d.scope } : {}) } : null }; }
        else authority = cr; // { consumed: false } | { consumed: "unknown" }
      } catch { return "retry"; } // transient consumed-authority read ⇒ keep the obligation
      const act = obligationReceiptValue(authority, ob.recordedValue);
      if (act.action === "retry") return "retry";
      if (act.action === "drop") return "sent"; // orphaned tap — the store's own orphan signal covers re-batching; no receipt
      return forwardToCoordinator(buildTgVerdictReceipt(ob.batchId, ob.itemId, act.value.verdict, act.value.scope), tgIdempotencyKey("tg-verdict", ob.updateId)) === "retry" ? "retry" : "sent";
    }, { stuck: receiptStuck });
  } catch { /* fail-soft: a drain fault never kills the poll loop */ }
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
  // getUpdates timeout=25 bounds only the SERVER long-poll wait (TGP-6): it is NOT an end-to-end SLA. The loop is serial
  // (notifyNewBatches + pollOnce + per-item sends), so outbound new-batch latency ≈ one loop iteration (long-poll + that tick's
  // work), not a hard ≤25s. Inbound verdict→coordinator latency is independent — it rides the durable receipt + inbox-wake below.
  await drainReceiptObligations(); // recover any obligation a prior poll/process held (crash-recovery + coordinator-was-down retry) BEFORE the long-poll blocks
  const committed = readOffset();
  for (const id of ackedUpdates) if (id < committed) ackedUpdates.delete(id); // bound the ack-dedup set to the live window
  const updates = await tg(token, "getUpdates", { offset: committed, timeout: 25, allowed_updates: ["callback_query", "message"] });
  for (const u of updates ?? []) {
    const cq = u.callback_query;
    const chatId: unknown = cq ? cq.message?.chat?.id : u.message?.chat?.id;
    const ack = async (text?: string): Promise<void> => { if (cq) await tg(token, "answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text } : {}) }, 15000).catch(() => {}); };
    // first-contact: surface an un-allowlisted chat_id so the user can add it (design detail); terminal -> advance.
    if (typeof chatId === "number" && !allow.has(chatId)) { console.error(`swarm-tg-entry: message from un-allowlisted chat_id ${chatId} — add it to ${allowFile()} to enable`); writeOffset(u.update_id + 1); await ack(); continue; }
    // conversation SLA ② (TGP-6): an IMMEDIATE TG-side read-receipt — FIRE-AND-FORGET (never awaited, never blocks processing),
    // ONCE per update_id (an update can re-poll when a forward retry holds the offset), with a short deadline. Final result rides
    // the outbound path later.
    if (typeof chatId === "number" && !ackedUpdates.has(u.update_id)) { ackedUpdates.add(u.update_id); void tg(token, "sendMessage", { chat_id: chatId, text: TG_ACK_TEXT }, 15000).catch(() => {}); }
    const upd: TgUpdate = cq ? { chatId, callbackData: cq.data } : { chatId, text: u.message?.text };
    const r = parseUpdate(upd, allow);
    if (r.kind === "ignore") {
      // ① a non-verdict allowlisted message reaches the coordinator inbox (notify + inbox-wake); NEVER executed. TGP-3: it has no
      // ledger copy, so release the update (advance) ONLY after a durable handoff — a retry keeps the update (idempotent on replay).
      if (typeof chatId === "number" && typeof u.message?.text === "string" && u.message.text.trim()) {
        if (forwardToCoordinator(buildTgMessageReceipt(chatId, u.message.text), tgIdempotencyKey("tg-msg", u.update_id)) === "retry") return;
      }
      writeOffset(u.update_id + 1); await ack(); continue;
    }
    // TG-P2-1: resolveRef throws on a STORE READ ERROR (unreadable batches dir/batch.json) — that is TRANSIENT, so STOP the poll
    // WITHOUT advancing the offset; the same tap is retried next loop (never a false "expired" that permanently skips an approval).
    let resolved: { batchId: string; itemId: string } | null;
    try { resolved = resolveRef(r.ref); }
    catch (e) { console.error(`swarm-tg-entry: ref lookup read error (NOT advancing offset, will retry): ${e instanceof Error ? e.message : e}`); return; }
    if (!resolved) { writeOffset(u.update_id + 1); await ack("expired"); continue; } // CONFIRMED gone/ambiguous -> terminal
    // TGP-4 (TG-r6): stamp the decision's `reason` with this event's identity tag, so the SAME atomic ledger commit that records the
    // verdict also carries which TG update made it — enabling EVENT-BOUND receipt recovery after a lost obligation (see below).
    const decision = { id: resolved.itemId, verdict: r.verdict as Verdict, reason: srcTag(u.update_id), ...(r.scope ? { scope: r.scope as ApprovalScope } : {}) };
    let outcome: "recorded" | "consumed" | "unknown-item" | "contended";
    try { outcome = recordDecision(HOME, resolved.batchId, decision, Math.floor(Date.now() / 1000)); }
    catch (e) { console.error(`swarm-tg-entry: recordDecision transient error (NOT advancing offset, will retry): ${e instanceof Error ? e.message : e}`); return; } // transient IO -> retry this update next poll
    if (outcome === "contended") return; // a concurrent holder — retry this update next poll (do NOT advance)
    // ① inbound immediacy + TGP-4 (TG-r5) DURABLE, EVENT-BOUND receipt obligation. A receipt is owed ONLY for a tap THIS call
    // actually RECORDED — the obligation's existence IS the proof that this update (identity = update_id) recorded a decision (fact
    // b). A "consumed"/"unknown-item" tap did NOT record (a late/losing tap, or one the coordinator already decided via console) ⇒
    // NO obligation ⇒ never a false/stale receipt. The obligation is captured DURABLY (keyed by update_id) BEFORE the offset
    // advances, so recovery delivers it from the obligation — never by re-deriving from the volatile ledger fold. The FINAL value is
    // resolved at delivery from the AUTHORITATIVE consumed result (fact a), not here. A persist fault ⇒ hold the offset and retry.
    if (outcome === "recorded") {
      let mine: { verdict: Verdict; scope?: ApprovalScope };
      try {
        const item = readBatch(HOME, resolved.batchId)?.items.find((it) => it.id === resolved.itemId);
        if (!item) return; // can't clamp without the item ⇒ transient (the batch should exist) ⇒ retry, do NOT advance
        mine = enforceScope(item, decision);
      } catch { return; } // transient batch read ⇒ retry
      const ob: ReceiptObligation = { updateId: u.update_id, batchId: resolved.batchId, itemId: resolved.itemId, recordedValue: { verdict: mine.verdict, ...(mine.scope ? { scope: mine.scope } : {}) } };
      if (enqueueQueue(tgReceiptObligationDir(HOME), ob, u.update_id) === "failed") return; // can't persist the obligation ⇒ hold offset, retry
    } else if (outcome === "consumed") {
      // TGP-4 (TG-r6) EVENT-BOUND RECOVERY: the obligation may have been LOST before it was durable — an enqueue IO-failure above, or
      // a crash between recordDecision and the enqueue. The batch is now sealed, but THIS event's identity is in the sealed ledger
      // (we stamped `reason` into the recorded decision). Read the AUTHORITATIVE consumed result (digest-verified claim, not the fold):
      // iff the item's final decision was written by THIS update (reason === srcTag), re-capture its obligation so the receipt is
      // STILL delivered — provably this event's, never by value-equality. A mismatch/absent ⇒ this tap was superseded or never the
      // final ⇒ owe nothing. "unknown" (sealed-but-unreadable) ⇒ retry. A read fault ⇒ retry (never a false "not ours").
      let cr: ReturnType<typeof readConsumedResult>;
      try { cr = readConsumedResult(HOME, resolved.batchId); } catch { return; }
      if (cr.consumed === "unknown") return; // can't verify the authority yet ⇒ hold offset, retry
      if (cr.consumed === true) {
        const d = cr.doc.decisions.find((x) => x.id === resolved.itemId);
        if (d && d.reason === srcTag(u.update_id)) {
          const ob: ReceiptObligation = { updateId: u.update_id, batchId: resolved.batchId, itemId: resolved.itemId, recordedValue: { verdict: d.verdict, ...(d.scope ? { scope: d.scope } : {}) } };
          if (enqueueQueue(tgReceiptObligationDir(HOME), ob, u.update_id) === "failed") return; // can't persist ⇒ retry (DONE marker makes it idempotent)
        }
      }
    }
    writeOffset(u.update_id + 1); // terminal (the obligation, if any, is durable)
    await ack(outcome === "recorded" ? "recorded" : outcome === "consumed" ? "already decided" : "unknown");
  }
  await drainReceiptObligations(); // deliver this cycle's recorded receipts (fast path) + anything a prior poll held
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
  // TGP-5: install the SIGNED inbox-wake hook in THIS process so a receipt writeInbox fires a real-time coordinator wake. Gated on
  // herdr reachability (F54): if herdr is NOT reachable here the hook stays INERT — the receipt still DELIVERS DURABLY and the
  // coordinator's own inbox poll is the backstop, so sub-second wake is NOT guaranteed in that case. Status logged honestly.
  const wakeActive = installInboxWake((s) => console.error(s));
  console.error(`swarm-tg-entry: inbox-wake ${wakeActive ? "ACTIVE (real-time coordinator wake on receipt)" : "INERT (durable delivery only; coordinator poll is the backstop)"}`);
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
