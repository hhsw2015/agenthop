import { describe, expect, test } from "vitest";
import { RoomRateLimiter, rateKey } from "../src/swarm/chat-room-rate.js";

describe("RoomRateLimiter (S14 chat-entry throttle)", () => {
  test("admits up to the limit in a window, then denies with retryAfterMs", () => {
    const rl = new RoomRateLimiter({ limit: 3, windowMs: 1000 });
    const k = rateKey("r", "alice");
    expect(rl.admit(k, 0).ok).toBe(true);
    expect(rl.admit(k, 10).ok).toBe(true);
    expect(rl.admit(k, 20).ok).toBe(true);
    const d = rl.admit(k, 30);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.retryAfterMs).toBe(970); // oldest hit (t=0) + window(1000) - now(30)
  });

  test("the window slides: once the oldest hit ages out, a slot frees", () => {
    const rl = new RoomRateLimiter({ limit: 2, windowMs: 1000 });
    const k = rateKey("r", "a");
    expect(rl.admit(k, 0).ok).toBe(true);
    expect(rl.admit(k, 100).ok).toBe(true);
    expect(rl.admit(k, 200).ok).toBe(false); // full
    expect(rl.admit(k, 1001).ok).toBe(true);  // t=0 hit aged out ⇒ room again
  });

  test("notify stays DUE until markNotified, then is suppressed for the rest of the window; a new window re-arms it", () => {
    const rl = new RoomRateLimiter({ limit: 1, windowMs: 1000 });
    const k = rateKey("r", "a");
    expect(rl.admit(k, 0).ok).toBe(true);
    const d1 = rl.admit(k, 10); if (!d1.ok) expect(d1.notify).toBe(true); // receipt due
    rl.markNotified(k, 10);                                               // receipt actually delivered
    const d2 = rl.admit(k, 20); if (!d2.ok) expect(d2.notify).toBe(false); // suppressed within the window
    expect(rl.admit(k, 2000).ok).toBe(true);                             // new window
    const d3 = rl.admit(k, 2010); if (!d3.ok) expect(d3.notify).toBe(true); // due again
  });

  test("CR-R2-P2-1: without markNotified, notify stays DUE (a failed receipt is retried, not consumed)", () => {
    const rl = new RoomRateLimiter({ limit: 1, windowMs: 1000 });
    const k = rateKey("r", "a");
    expect(rl.admit(k, 0).ok).toBe(true);
    const d1 = rl.admit(k, 10); const d2 = rl.admit(k, 20); // two denials, markNotified never called
    if (!d1.ok) expect(d1.notify).toBe(true);
    if (!d2.ok) expect(d2.notify).toBe(true); // still due — admit alone does not consume the slot
  });

  test("CR-R2-P2-2: an invalid config is rejected (no NaN retry, no silently-disabled cap)", () => {
    for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: Number.NaN }, { limit: 1.5 }]) expect(() => new RoomRateLimiter(bad)).toThrow();
    for (const bad of [{ windowMs: 0 }, { windowMs: -1 }, { windowMs: Number.NaN }]) expect(() => new RoomRateLimiter(bad)).toThrow();
    expect(() => new RoomRateLimiter({ limit: 1, windowMs: 1000 })).not.toThrow();
  });

  test("keys are isolated per (room, sender)", () => {
    const rl = new RoomRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.admit(rateKey("r1", "a"), 0).ok).toBe(true);
    expect(rl.admit(rateKey("r2", "a"), 0).ok).toBe(true); // different room — own budget
    expect(rl.admit(rateKey("r1", "b"), 0).ok).toBe(true); // different sender — own budget
    expect(rl.admit(rateKey("r1", "a"), 10).ok).toBe(false); // r1/a already spent
  });
});
