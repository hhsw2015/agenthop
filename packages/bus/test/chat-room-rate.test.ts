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

  test("notify is true only on the FIRST denial per window (one receipt, not a storm)", () => {
    const rl = new RoomRateLimiter({ limit: 1, windowMs: 1000 });
    const k = rateKey("r", "a");
    expect(rl.admit(k, 0).ok).toBe(true);
    const d1 = rl.admit(k, 10); const d2 = rl.admit(k, 20); const d3 = rl.admit(k, 30);
    expect([d1.ok, d2.ok, d3.ok]).toEqual([false, false, false]);
    if (!d1.ok && !d2.ok && !d3.ok) expect([d1.notify, d2.notify, d3.notify]).toEqual([true, false, false]);
    // a new window re-arms the notify
    rl.admit(k, 2000); // admitted (window reset)
    const d4 = rl.admit(k, 2010);
    if (!d4.ok) expect(d4.notify).toBe(true);
  });

  test("keys are isolated per (room, sender)", () => {
    const rl = new RoomRateLimiter({ limit: 1, windowMs: 1000 });
    expect(rl.admit(rateKey("r1", "a"), 0).ok).toBe(true);
    expect(rl.admit(rateKey("r2", "a"), 0).ok).toBe(true); // different room — own budget
    expect(rl.admit(rateKey("r1", "b"), 0).ok).toBe(true); // different sender — own budget
    expect(rl.admit(rateKey("r1", "a"), 10).ok).toBe(false); // r1/a already spent
  });
});
