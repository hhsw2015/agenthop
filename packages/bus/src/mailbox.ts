import { hkdfSync } from "node:crypto";
import { isRoomAddress, WORDLIST } from "@agenthop/tunnel";
import { sendMessage, startHost } from "@agenthop/cli";
import { openDm, sealDm, type SessionKeys } from "./dm.js";

/**
 * A session's mailbox for cross-machine DMs, built on a stock relay: the session hosts a room at
 * an address derived from its own public key (the upstream inbox trick), and accepts messages
 * sealed to that key. Only someone who knows the key can seal to it, and the key is only ever
 * handed out through the team-sealed directory — so team membership is what gates a DM.
 *
 * A keepalive GET keeps the room from idling out while no messages flow, so a session counts as
 * online for as long as its process runs — not merely for ten minutes after the last message.
 */

type RunningHost = Awaited<ReturnType<typeof startHost>>;

export type MailIn = { from: string; payload: string };

export type Mailbox = {
  address(): string;
  /** Take everything received since the last call. */
  drain(): MailIn[];
  /** Seal `payload` to a peer's public key and post it to their mailbox. false if it did not go. */
  send(toPub: string, payload: string): Promise<boolean>;
  close(): Promise<void>;
};

const KEEPALIVE_MS = 4 * 60_000;

/** The room a key's messages are delivered to. Sender and recipient both derive it the same way. */
export function mailboxAddress(publicKey: string): string {
  for (let round = 0; ; round++) {
    const bytes = Buffer.from(hkdfSync("sha256", Buffer.from(publicKey, "base64url"), Buffer.alloc(0), `agenthop bus mail v1 ${round}`, 8));
    const digits = String(bytes.readUInt16BE(0) % 10000).padStart(4, "0");
    const words = [2, 4, 6].map((at) => WORDLIST[bytes.readUInt16BE(at) % WORDLIST.length]!);
    const address = `${digits}-${words.join("-")}`;
    if (isRoomAddress(address)) return address;
  }
}

/** The token that holds our mailbox room, from our private key, so a restart takes it back at once. */
export function mailboxToken(keys: SessionKeys): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(keys.privateKey, "base64url"), Buffer.alloc(0), "agenthop bus mail token v1", 32)).toString("base64url");
}

export type MailboxOptions = { keys: SessionKeys; relay?: string; pass?: string; onInbound?: (msg: MailIn) => void };

export function startMailbox(options: MailboxOptions): Mailbox {
  const { keys } = options;
  const address = mailboxAddress(keys.publicKey);
  const inbox: MailIn[] = [];
  let host: RunningHost | undefined;
  let closed = false;

  const deliver = (msg: MailIn): void => {
    if (options.onInbound) options.onInbound(msg);
    else inbox.push(msg);
  };

  const accept = (text: string): boolean => {
    try {
      openDm(keys, text);
      return true;
    } catch {
      return false; // not a DM for us
    }
  };

  void (async () => {
    // Retry the first connection with backoff: without this, one early failure (relay briefly down
    // or the room momentarily taken) left the mailbox dark for the whole session even after the
    // relay recovered. Sending is unaffected either way. Mirrors cli/src/inbox.ts.
    let wait = 1000;
    while (!closed) {
      try {
        const running = await startHost({
          code: address,
          token: mailboxToken(keys),
          serveQueue: false,
          relay: options.relay,
          pass: options.pass,
          recoverMs: Number.POSITIVE_INFINITY,
          // The mailbox lives for the whole session; lift the default lifetime quota (2,000 msgs /
          // 8 MiB) so a long-lived session keeps receiving DMs. textBytes caps a single DM.
          limits: { messages: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, textBytes: 1024 * 1024 },
          accept,
          onEvent: (event) => {
            if (event.from !== "peer" || typeof event.text !== "string") return;
            try {
              const opened = openDm(keys, event.text);
              deliver({ from: opened.from, payload: opened.payload });
            } catch {
              // not for us
            }
          },
        });
        if (closed) {
          await running.close(); // closed while connecting: don't leave a host running
          return;
        }
        host = running;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30_000);
      }
    }
  })();

  // Any request through the relay resets the room's idle timer; a bare GET is enough.
  const beat = setInterval(() => {
    if (host) void fetch(host.url).catch(() => undefined);
  }, KEEPALIVE_MS);
  beat.unref();

  return {
    address: () => address,
    drain: () => inbox.splice(0, inbox.length),
    async send(toPub, payload) {
      try {
        await sendMessage({ code: mailboxAddress(toPub), text: sealDm(keys, toPub, payload), relay: options.relay, pass: options.pass });
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      closed = true;
      clearInterval(beat);
      await host?.close();
      host = undefined;
    },
  };
}
