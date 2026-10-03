import { randomBytes } from "node:crypto";
import { DEFAULT_RELAY, readQueue, sendMessage, startHost } from "@agenthop/cli";
import { addressOf, generateCode, normalizeCode, relayEndpoints } from "@agenthop/tunnel";
import { openEntry, sealEntry } from "../team.js";

type RunningHost = Awaited<ReturnType<typeof startHost>>;

/**
 * A PER-TASK A2A room — the networked return channel for a swarm VM, built on the stock relay (same primitives
 * as directory.ts). The dispatcher opens a room with a RANDOM address + a RANDOM 32-byte seal key (the per-launch
 * key — NOT the team nsKey; a leak exposes only this one task's channel). The VM posts its result SEALED under
 * that key; the dispatcher polls the queue and opens the entries. The relay sees only the address, sizes, timing.
 *
 * Posting is open to anyone holding the address (as in directory.ts), but only the dispatcher has the seal key,
 * so garbage posts simply fail openEntry and are skipped. The address is injected to exactly one VM.
 */

/** Tags a sealed result entry (VM → dispatcher) in the per-task room. */
export const SWARM_RESULT_PREFIX = "[[agenthop:swarm-result]] ";
/** Tags a sealed command entry (dispatcher → VM) — the other direction over the same room (two-way networking). */
export const SWARM_CMD_PREFIX = "[[agenthop:swarm-cmd]] ";

const RESULT_TEXT_BYTES = 64 * 1024; // small results / notify ride the room; large artifacts go to GitHub (per the contract)

export type TaskRoom = {
  /** The room address to inject into the VM (so it can post). */
  code: string;
  /** The per-launch seal key, hex — injected into the VM so it can seal; NEVER the team nsKey. */
  keyHex: string;
  /** The relay this room lives on. */
  relay: string;
  /** Poll the room until a result arrives (decrypted) or the timeout elapses. Returns all results seen. */
  collect(timeoutMs: number): Promise<string[]>;
  /** Post a command to the VM (the dispatcher→VM direction) — sealed under the per-launch key. Two-way networking. */
  send(text: string): Promise<void>;
  /** Stop hosting the room. */
  close(): Promise<void>;
};

export type OpenTaskRoomOptions = { relay?: string; pass?: string };

/** Open a fresh per-task room and host it (the dispatcher is the keeper). */
export async function openTaskRoom(options: OpenTaskRoomOptions = {}): Promise<TaskRoom> {
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const code = addressOf(generateCode()); // a random, valid room address (the pairing secret is discarded)
  const token = randomBytes(16).toString("base64url"); // holds the room for us (reclaim auth), not a posting gate
  const nsKey = randomBytes(32); // the per-launch seal key — independent of any team secret
  const keyHex = nsKey.toString("hex");
  const base = relayEndpoints(relay, normalizeCode(code)).publicBase;
  const host: RunningHost = await startHost({
    code,
    token,
    serveQueue: true,
    relay,
    pass: options.pass,
    // A per-task room holds only a few small result blobs; lift the default lifetime quota like the inbox/directory do.
    limits: { messages: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, textBytes: RESULT_TEXT_BYTES },
  });
  let after = 0;
  let closed = false;
  return {
    code,
    keyHex,
    relay,
    async collect(timeoutMs: number): Promise<string[]> {
      const deadline = Date.now() + timeoutMs;
      const out: string[] = [];
      while (!closed && Date.now() < deadline) {
        let events: Awaited<ReturnType<typeof readQueue>>["events"] = [];
        try {
          events = (await readQueue(base, after, options.pass)).events;
        } catch {
          // transient relay hiccup — retry on the next tick
        }
        for (const event of events) {
          after = Math.max(after, event.seq ?? after);
          if (typeof event.text !== "string" || !event.text.startsWith(SWARM_RESULT_PREFIX)) continue;
          try {
            out.push(openEntry(nsKey, event.text.slice(SWARM_RESULT_PREFIX.length)));
          } catch {
            // not sealed with our key (noise / spam) — skip
          }
        }
        if (out.length) return out;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return out;
    },
    async send(text: string): Promise<void> {
      await sendMessage({ code, text: SWARM_CMD_PREFIX + sealEntry(nsKey, text), relay, pass: options.pass });
    },
    async close(): Promise<void> {
      closed = true;
      await host.close();
    },
  };
}

/** Read the per-task room once and return decrypted entries carrying `prefix` (newest last). Used VM-side to pull
 *  dispatcher commands (SWARM_CMD_PREFIX) and dispatcher-side to read results — one-shot, no hosting. */
export async function pullMessages(options: { code: string; keyHex: string; relay?: string; prefix: string; after?: number; pass?: string }): Promise<{ messages: string[]; after: number }> {
  const nsKey = Buffer.from(options.keyHex, "hex");
  if (nsKey.length !== 32) throw new Error("pullMessages: keyHex must be 32 bytes (64 hex chars)");
  const relay = options.relay ?? process.env.AGENTHOP_RELAY ?? DEFAULT_RELAY;
  const base = relayEndpoints(relay, normalizeCode(options.code)).publicBase;
  let after = options.after ?? 0;
  const messages: string[] = [];
  const resp = await readQueue(base, after, options.pass);
  for (const event of resp.events) {
    after = Math.max(after, event.seq ?? after);
    if (typeof event.text !== "string" || !event.text.startsWith(options.prefix)) continue;
    try {
      messages.push(openEntry(nsKey, event.text.slice(options.prefix.length)));
    } catch {
      // not ours — skip
    }
  }
  return { messages, after };
}

/**
 * Seal `text` under the per-launch key and post it into the per-task room. This is what the VM runs (bundled for
 * injection; see report-entry.ts) — and what the round-trip test calls directly. Pure relay use, no CPA coupling.
 */
export async function reportResult(options: { code: string; keyHex: string; text: string; relay?: string; pass?: string }): Promise<void> {
  const nsKey = Buffer.from(options.keyHex, "hex");
  if (nsKey.length !== 32) throw new Error("reportResult: keyHex must be 32 bytes (64 hex chars)");
  const sealed = SWARM_RESULT_PREFIX + sealEntry(nsKey, options.text);
  await sendMessage({ code: options.code, text: sealed, relay: options.relay, pass: options.pass });
}
