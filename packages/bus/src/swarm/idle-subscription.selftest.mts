import { makeSub, isExpired, shouldFire, markFired, pruneSubs, watchedTargets, IDLE_SUB_TTL_SEC } from "./idle-subscription.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const T0 = 1_000_000;

const s = makeSub("sub1", "me", "peer", T0);
t("makeSub: 12h expiry default", s.expireSec === T0 + IDLE_SUB_TTL_SEC && s.fired === false);
t("makeSub: missing field throws", (() => { try { makeSub("", "me", "p", T0); return false; } catch { return true; } })());

// IS-P2-1: a positive fractional TTL must NOT floor to 0 (which would expire the sub at creation)
t("makeSub: positive TTL<1 clamps to >=1, not expired at creation", (() => { const x = makeSub("f", "me", "p", T0, 0.5); return x.expireSec === T0 + 1 && !isExpired(x, T0) && shouldFire(x, { idle: true, exited: false }, T0) === true; })());
// IS-P2-1: a non-finite creation clock is REJECTED (else a NaN expiry never trips isExpired -> fires forever, never prunes)
t("makeSub: NaN creation clock throws", (() => { try { makeSub("b", "me", "p", NaN); return false; } catch { return true; } })());
t("makeSub: Infinity creation clock throws", (() => { try { makeSub("b", "me", "p", Infinity); return false; } catch { return true; } })());

// one-shot fire: idle OR exit, not fired, not expired
t("fire on idle", shouldFire(s, { idle: true, exited: false }, T0 + 10) === true);
t("fire on exit", shouldFire(s, { idle: false, exited: true }, T0 + 10) === true);
t("no fire when neither idle nor exited", shouldFire(s, { idle: false, exited: false }, T0 + 10) === false);
t("no fire once fired (one-shot)", shouldFire(markFired(s), { idle: true, exited: false }, T0 + 10) === false);
t("no fire when expired", shouldFire(s, { idle: true, exited: false }, T0 + IDLE_SUB_TTL_SEC + 1) === false);
t("no fire on non-finite clock (fail-closed)", shouldFire(s, { idle: true, exited: false }, NaN) === false);

t("isExpired boundary", isExpired(s, T0 + IDLE_SUB_TTL_SEC) === true && isExpired(s, T0 + IDLE_SUB_TTL_SEC - 1) === false);
t("markFired immutable (original unchanged)", markFired(s).fired === true && s.fired === false);

// prune + watchedTargets
const subs = [s, makeSub("s2", "me", "p2", T0), markFired(makeSub("s3", "me", "p3", T0)), makeSub("s4", "me", "p4", T0 - IDLE_SUB_TTL_SEC - 10)];
const live = pruneSubs(subs, T0 + 10);
t("prune drops fired + expired", live.length === 2 && live.every((x) => x.id === "sub1" || x.id === "s2"));
t("watchedTargets = distinct live targets", (() => { const w = watchedTargets(subs, T0 + 10); return w.size === 2 && w.has("peer") && w.has("p2") && !w.has("p3") && !w.has("p4"); })());

console.log("all idle-subscription selftests passed");
