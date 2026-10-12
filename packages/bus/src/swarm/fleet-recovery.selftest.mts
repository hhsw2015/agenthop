// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/fleet-recovery.selftest.mts
// full-fleet-recovery r2 (codex:Work @29bd0e1, 11 P2 + 1 P3). Pins the rebuilt pure core AND runs the REAL orchestration
// (orchestrateRecover) with injected fakes so the three zero-bug fixture classes actually exercise recovery execution (FR-11):
// crash-recovery (interrupted run resumes + reuses the episode), restart-idempotency (re-run never double-launches), concurrency
// (two overlapping recoveries launch each member once). Each asserts an OBSERVABLE TERMINAL STATE (launch counts, episode id,
// outstanding, on-disk boundary). Plus FR-1/2/3/4/5/7/9/10 unit coverage + the store CP-3 ancestor chain + claim O_EXCL.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FLEET_SNAPSHOT_SCHEMA, fleetRecoveryEnabled, envAllowed, scrubValueSecrets, filterCaptureEnv, snapshotStaleSec,
  parseFleetSnapshot, parseDispatcherRecipe, dispatcherNeedsRelaunch, wakeHealthy, dispatcherVerdict, memberVerdict,
  resolveMemberSid, resolveEpisodeId, buildBreakpointText, grantedItemsForMember, deliveryDischarged, summarizeOutstanding,
  orchestrateRecover, breakpointInjectionEnabled,
  type FleetSnapshot, type DispatcherRecipe, type RecoverDeps, type RecoveryEpisode, type PeerLikeMin, type RosterMemberLike, type DeliveryStatus, type DispatcherLiveness,
} from "./fleet-recovery.js";
import {
  writeFleetSnapshot, readFleetSnapshot, recordDispatcherRecipe, readDispatcherRecipe, writeEpisode, readEpisode,
  claimRecoverLaunch, writeRecoveryReceipt, readRecoveryReceipt, FLEET_RECEIPT_SCHEMA,
} from "./fleet-recovery-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const scratch = mkdtempSync(path.join(tmpdir(), "fleet-recovery-r2-"));
const freshHome = () => mkdtempSync(path.join(scratch, "home-"));
const swarm = (h: string) => path.join(h, ".agenthop", "swarm");
const goodRecipe: DispatcherRecipe = { argv: ["/usr/bin/node", "scripts/swarm-dispatch.ts"], cwd: "/repo", env: { SWARM_SELF: "d1", HERDR_ENV: "1" }, source: "self-recorded" };
const goodSnap: FleetSnapshot = { schema: FLEET_SNAPSHOT_SCHEMA, capturedAtSec: 1000, dispatcher: goodRecipe, rosterFile: "/h/roster.json" };

try {
  // ── FR-2: value-level credential scrub ─────────────────────────────────────────────────────────────────────────
  t("scrub: strips URL userinfo", scrubValueSecrets("https://user:pass@git.example/o/r.git") === "https://git.example/o/r.git");
  t("scrub: strips user@ too", scrubValueSecrets("ssh://deploy@host/path") === "ssh://host/path");
  t("scrub: leaves a clean URL + plain value", scrubValueSecrets("https://git.example/o/r.git") === "https://git.example/o/r.git" && scrubValueSecrets("plain") === "plain");
  t("filterCaptureEnv: scrubs a captured value (FR-2)", filterCaptureEnv({ SWARM_WORK_REPO: "https://u:{{PASSWORD_mcu5s9ca}}@h/r.git" }).SWARM_WORK_REPO === "https://h/r.git");
  t("envAllowed: HERDR_ family + SWARM_ + secret denylist", envAllowed("HERDR_SOCKET_PATH") && envAllowed("SWARM_SELF") && !envAllowed("CPA_API_KEY") && !envAllowed("SWARM_X_TOKEN"));

  // ── FR-1: lossless recipe parse (argv array, spaces survive; re-scrub on read) ──────────────────────────────────
  t("parseDispatcherRecipe: argv with spaces round-trips (FR-1 lossless)", (() => {
    const p = parseDispatcherRecipe({ schema: "x", argv: ["/node", "my file.ts", "--flag=a b"], cwd: "/r", env: {}, source: "self-recorded" });
    return p !== null && p.argv.length === 3 && p.argv[1] === "my file.ts" && p.argv[2] === "--flag=a b";
  })());
  t("parseDispatcherRecipe: no argv -> null", parseDispatcherRecipe({ cwd: "/r", env: {} }) === null);
  t("parseDispatcherRecipe: re-scrubs env on read (FR-2)", parseDispatcherRecipe({ argv: ["/n"], cwd: "/r", env: { SWARM_WORK_REPO: "https://u:p@h/r" }, source: "ps-fallback" })?.env.SWARM_WORK_REPO === "https://h/r");
  t("parseFleetSnapshot: good round-trip", JSON.stringify(parseFleetSnapshot(JSON.stringify(goodSnap))) === JSON.stringify(goodSnap));
  t("parseFleetSnapshot: present-but-malformed dispatcher -> null (refuse)", parseFleetSnapshot(JSON.stringify({ ...goodSnap, dispatcher: { cwd: "/r" } })) === null);
  t("parseFleetSnapshot: null dispatcher ok; garbage -> null", parseFleetSnapshot(JSON.stringify({ ...goodSnap, dispatcher: null }))?.dispatcher === null && parseFleetSnapshot("{x") === null);

  // ── flags + stale ───────────────────────────────────────────────────────────────────────────────────────────────
  t("fleetRecoveryEnabled default ON; breakpoint default ON", fleetRecoveryEnabled({}) && !fleetRecoveryEnabled({ SWARM_FLEET_RECOVERY: "0" }) && breakpointInjectionEnabled({}));
  t("snapshotStaleSec", snapshotStaleSec({ capturedAtSec: 1000 }, 1600) === 600 && snapshotStaleSec({ capturedAtSec: 2000 }, 1000) === 0);

  // ── Q2 dispatcher verdict incl. FR-3 (wake UNKNOWN ⇒ unknown, never borrowed) ───────────────────────────────────
  t("dispatcherNeedsRelaunch", dispatcherNeedsRelaunch(goodSnap, false) && !dispatcherNeedsRelaunch(goodSnap, true));
  t("wakeHealthy only 'on'", wakeHealthy("on") && !wakeHealthy("on(inert:no-herdr)"));
  t("verdict confirmed = alive+fresh+wake-on", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" }, 120) === "confirmed");
  t("verdict failed = pid dead", dispatcherVerdict({ pidAlive: false, heartbeatFreshSec: 1, wakeStatus: "on" }, 120) === "failed");
  t("verdict unknown = wake inert (F54)", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on(inert:no-herdr)" }, 120) === "unknown");
  t("verdict unknown = wake NULL (FR-3 target env unreadable, never borrowed)", dispatcherVerdict({ pidAlive: true, heartbeatFreshSec: 10, wakeStatus: null }, 120) === "unknown");

  // ── FR-5: member resolution to UNIQUE SID ───────────────────────────────────────────────────────────────────────
  const peers: PeerLikeMin[] = [{ stableId: "sid-A", title: "Work-aaa" }, { stableId: "sid-B", title: "dup" }, { stableId: "sid-C", title: "dup" }];
  t("resolve: exact id -> resolved", (() => { const r = resolveMemberSid({ member: "sid-A" }, peers); return r.kind === "resolved" && r.sid === "sid-A"; })());
  t("resolve: unique title -> resolved", (() => { const r = resolveMemberSid({ member: "old-id", title: "Work-aaa" }, peers); return r.kind === "resolved" && r.sid === "sid-A"; })());
  t("resolve: REUSED title -> ambiguous (never false confirm, FR-5)", resolveMemberSid({ member: "x", title: "dup" }, peers).kind === "ambiguous");
  t("resolve: no match -> absent", resolveMemberSid({ member: "ghost", title: "none" }, peers).kind === "absent");

  // ── FR-7: episode identity ──────────────────────────────────────────────────────────────────────────────────────
  t("episode: incomplete+recent -> REUSE", (() => { const e: RecoveryEpisode = { episodeId: "ep-1", startedAtSec: 1000, snapshotCapturedAtSec: 1, completed: false }; const r = resolveEpisodeId(e, 1100, () => "ep-NEW", 1800); return r.reused && r.episodeId === "ep-1"; })());
  t("episode: completed -> NEW (a retry of a finished run is a new event)", resolveEpisodeId({ episodeId: "ep-1", startedAtSec: 1000, snapshotCapturedAtSec: 1, completed: true }, 1100, () => "ep-NEW", 1800).episodeId === "ep-NEW");
  t("episode: stale incomplete -> NEW (new reboot, same snapshot)", resolveEpisodeId({ episodeId: "ep-1", startedAtSec: 1000, snapshotCapturedAtSec: 1, completed: false }, 9999, () => "ep-NEW", 1800).episodeId === "ep-NEW");
  t("episode: none -> NEW", resolveEpisodeId(null, 1000, () => "ep-NEW", 1800).episodeId === "ep-NEW");

  // ── FR-10: breakpoint from granted (full-SID) + three-state ─────────────────────────────────────────────────────
  const parse = (name: string) => { const parts = name.endsWith(".json") ? name.slice(0, -5).split(".") : []; return parts.length >= 3 ? { itemId: parts.slice(0, -2).join("."), state: parts[parts.length - 2]!, who: parts[parts.length - 1]! } : null; };
  t("grantedItemsForMember: full-SID who, granted only (FR-10)", (() => {
    const names = ["taskA.granted.sid-long-uuid-1234.json", "taskB.claimed.sid-long-uuid-1234.json", "taskC.granted.other.json"];
    const g = grantedItemsForMember("sid-long-uuid-1234", names, parse);
    return g.length === 1 && g[0] === "taskA";
  })());
  t("buildBreakpointText: granted + attempts; never 'new task'", (() => {
    const s = buildBreakpointText({ member: "m", grantedItems: ["taskA"], liveAttempts: ["job/taskA/a1"], unreadInbox: 2 }, "T");
    return s.includes("taskA") && s.includes("job/taskA/a1") && s.includes("未派新活");
  })());
  t("buildBreakpointText: unreadable source -> explicit 'could not read' (FR-10, not false none)", (() => {
    const s = buildBreakpointText({ member: "m", grantedItems: null, liveAttempts: null, unreadInbox: null }, "T");
    return s.includes("无法读取") && !s.includes("未发现你名下已准入");
  })());

  // ── FR-8: obligation summary ────────────────────────────────────────────────────────────────────────────────────
  t("deliveryDischarged: published/already only", deliveryDischarged("published") && deliveryDischarged("already") && !deliveryDischarged("failed") && !deliveryDischarged("skipped"));
  t("summarizeOutstanding: dispatcher unknown + member unknown + failed report (FR-8)", (() => {
    const { outstanding, notConfirmed } = summarizeOutstanding({
      episodeId: "e", dispatcher: { relaunched: true, verdict: "unknown", wakeStatus: "on(inert:no-herdr)" },
      members: [{ member: "m1", resolution: "absent", verdict: "unknown", breakpoint: "skipped" }, { member: "m2", resolution: "resolved", sid: "s2", verdict: "confirmed", breakpoint: "failed" }],
      reportDelivery: "failed",
    });
    return notConfirmed === 2 && outstanding.some((o) => o.startsWith("dispatcher:")) && outstanding.some((o) => o.includes("breakpoint:")) && outstanding.some((o) => o.startsWith("coordinator-report:"));
  })());

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // FR-11 — the 3 zero-bug fixture classes run the REAL orchestrateRecover with fakes (observable terminal state)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  type HOpts = Partial<{ episode: RecoveryEpisode | null; peersBefore: PeerLikeMin[]; peersAfter: PeerLikeMin[]; claims: Set<string>; dispLiveness: DispatcherLiveness; now: number; mint: () => string; dispatcherLive: boolean }>;
  function makeHarness(o: HOpts) {
    const state = { episode: o.episode ?? null as RecoveryEpisode | null, settled: false, claims: o.claims ?? new Set<string>(), launches: [] as string[], bpKeys: [] as string[], reportKeys: [] as string[], episodeWrites: [] as RecoveryEpisode[] };
    const deps: RecoverDeps = {
      now: () => o.now ?? 1000,
      mintEpisodeId: o.mint ?? (() => "ep-NEW"),
      episodeStaleWindowSec: 1800, heartbeatThresholdSec: 120, breakpointsEnabled: true, recoveredAtIso: "T",
      readEpisode: () => state.episode,
      writeEpisode: (ep) => { state.episode = ep; state.episodeWrites.push(ep); },
      dispatcherLive: () => o.dispatcherLive ?? true,
      relaunchDispatcher: () => true,
      verifyDispatcher: () => o.dispLiveness ?? { pidAlive: true, heartbeatFreshSec: 10, wakeStatus: "on" },
      peers: () => (state.settled ? (o.peersAfter ?? []) : (o.peersBefore ?? [])),
      settle: async () => { state.settled = true; },
      claimLaunch: (mk, ep) => { const k = `${ep}::${mk}`; if (state.claims.has(k)) return false; state.claims.add(k); return true; },
      launchMember: async (m) => { state.launches.push(m.member); return { ok: true }; },
      breakpointFacts: (sid) => ({ member: sid, grantedItems: [], liveAttempts: [], unreadInbox: 0 }),
      deliverBreakpoint: (_sid, _text, ep) => { state.bpKeys.push(`fr-bp-${ep}-${_sid}`); return "published" as DeliveryStatus; },
      deliverReport: (_r, ep) => { state.reportKeys.push(`fr-report-${ep}`); return "published" as DeliveryStatus; },
    };
    return { deps, state };
  }
  const roster: RosterMemberLike[] = [{ member: "m1", title: "Work-m1" }, { member: "m2", title: "Work-m2" }];

  // FIXTURE 1: crash-recovery — a prior run launched m1 then was interrupted (episode incomplete, m1 now visible); re-run REUSES the
  // episode, does NOT relaunch m1 (claim held), launches m2, finishes. Observable: m1 launched 0 times this run, m2 once, episode reused.
  {
    const claims = new Set<string>(["ep-1::m1"]); // the interrupted run already claimed m1
    const h = makeHarness({ episode: { episodeId: "ep-1", startedAtSec: 1000, snapshotCapturedAtSec: 1000, completed: false }, peersBefore: [{ stableId: "m1", title: "Work-m1" }], peersAfter: [{ stableId: "m1", title: "Work-m1" }, { stableId: "m2", title: "Work-m2" }], claims });
    const r = await orchestrateRecover(goodSnap, roster, h.deps);
    t("fixture[crash]: reused the interrupted episode (FR-7)", r.episodeId === "ep-1");
    t("fixture[crash]: did NOT relaunch the already-claimed m1; launched only m2", h.state.launches.length === 1 && h.state.launches[0] === "m2");
    t("fixture[crash]: both members confirmed after resume, 0 outstanding", r.notConfirmed === 0 && r.outstanding.length === 0 && h.state.episode?.completed === true);
  }

  // FIXTURE 2: restart-idempotency — two sequential runs where members NEVER become visible. The claim dedups launches; the episode
  // (left incomplete by run 1) is reused by run 2 so report/breakpoint keys are STABLE. Observable: each member launched exactly once total.
  {
    const claims = new Set<string>();
    const h1 = makeHarness({ episode: null, peersBefore: [], peersAfter: [], claims, now: 1000, mint: () => "ep-X" });
    const r1 = await orchestrateRecover(goodSnap, roster, h1.deps);
    const h2 = makeHarness({ episode: h1.state.episode, peersBefore: [], peersAfter: [], claims, now: 1100, mint: () => "ep-Y" });
    const r2 = await orchestrateRecover(goodSnap, roster, h2.deps);
    t("fixture[idem]: run1 left outstanding (members never visible)", r1.outstanding.length > 0 && r1.episodeId === "ep-X");
    t("fixture[idem]: run2 REUSED the incomplete episode (same id)", r2.episodeId === "ep-X");
    t("fixture[idem]: each member launched EXACTLY ONCE across both runs (no double-launch)", h1.state.launches.length === 2 && h2.state.launches.length === 0);
    t("fixture[idem]: report key stable across the retry", r1.episodeId === r2.episodeId);
  }

  // FIXTURE 3: concurrency — two overlapping recoveries sharing the claim store; each member must be launched exactly ONCE total.
  {
    const claims = new Set<string>();
    const ep: RecoveryEpisode = { episodeId: "ep-C", startedAtSec: 1000, snapshotCapturedAtSec: 1000, completed: false };
    const a = makeHarness({ episode: ep, peersBefore: [], peersAfter: [], claims, now: 1050 });
    const b = makeHarness({ episode: ep, peersBefore: [], peersAfter: [], claims, now: 1050 });
    await Promise.all([orchestrateRecover(goodSnap, roster, a.deps), orchestrateRecover(goodSnap, roster, b.deps)]);
    const total = a.state.launches.length + b.state.launches.length;
    t("fixture[race]: shared claim store ⇒ each member launched EXACTLY ONCE total (not 2x)", total === roster.length);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // STORE: FR-1 self-record round-trip · FR-9 ancestor-chain CP-3 · FR-7 episode · claim O_EXCL · receipt
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const h = freshHome();
    t("store: recordDispatcherRecipe self-records argv array losslessly", (() => { recordDispatcherRecipe(h, 10); const r = readDispatcherRecipe(h); return r !== null && r.source === "self-recorded" && Array.isArray(r.argv) && r.argv.length >= 1; })());
    t("store: writeFleetSnapshot + read round-trip", (() => writeFleetSnapshot(h, goodRecipe, 5) && readFleetSnapshot(h)?.dispatcher?.argv[1] === "scripts/swarm-dispatch.ts")());
    t("store: read absent snapshot -> null", readFleetSnapshot(freshHome()) === null);
  }
  {
    const h = freshHome();
    t("store: episode write + read round-trip", (() => { writeEpisode(h, { episodeId: "e1", startedAtSec: 1, snapshotCapturedAtSec: 1, completed: false }); const e = readEpisode(h); return e?.episodeId === "e1" && e.completed === false; })());
    t("store: episode absent -> null", readEpisode(freshHome()) === null);
  }
  {
    const h = freshHome();
    t("store: claimRecoverLaunch O_EXCL — first wins, second (same episode) loses (FR-6)", claimRecoverLaunch(h, "m1", "ep-1") === true && claimRecoverLaunch(h, "m1", "ep-1") === false);
    t("store: claim — a DIFFERENT episode re-claims cleanly (new reboot)", claimRecoverLaunch(h, "m1", "ep-2") === true);
  }
  {
    const h = freshHome();
    t("store: receipt round-trip + schema", (() => writeRecoveryReceipt(h, { notConfirmed: 0 }) && readRecoveryReceipt(h)?.schema === FLEET_RECEIPT_SCHEMA)());
  }

  // FR-9: ancestor-chain CP-3 — a symlinked SWARM ancestor (leaf console/ is a real dir underneath) must STILL refuse every write.
  {
    const h = freshHome(); mkdirSync(path.join(h, ".agenthop"), { recursive: true });
    const ext = mkdtempSync(path.join(scratch, "ext-"));
    mkdirSync(path.join(ext, "console"), { recursive: true }); // a real console/ under the redirect target
    symlinkSync(ext, swarm(h)); // .agenthop/swarm -> ext (ancestor redirect)
    t("fixture[FR-9]: symlinked swarm ancestor -> writeFleetSnapshot refused", writeFleetSnapshot(h, goodRecipe, 1) === false);
    t("fixture[FR-9]: symlinked swarm ancestor -> writeRecoveryReceipt refused (leaf console is a real dir, ancestor is not)", writeRecoveryReceipt(h, { x: 1 }) === false);
    t("fixture[FR-9]: symlinked swarm ancestor -> recordDispatcherRecipe refused", recordDispatcherRecipe(h, 1) === false);
    t("fixture[FR-9]: symlinked swarm ancestor -> claimRecoverLaunch refused", claimRecoverLaunch(h, "m", "e") === false);
    t("fixture[FR-9]: NO escape writes at the redirect target", !existsSync(path.join(ext, "fleet-snapshot.json")) && !existsSync(path.join(ext, "console", "fleet-recovery.json")) && !existsSync(path.join(ext, "dispatcher-recipe.json")));
  }

  // crash-recovery (store): a torn snapshot never masquerades; leftover tmp ignored.
  {
    const h = freshHome(); mkdirSync(swarm(h), { recursive: true });
    writeFileSync(path.join(swarm(h), "fleet-snapshot.json"), '{"schema":"fleet-recovery-snapshot/v1","capturedAtSec":1,');
    t("fixture[crash/store]: torn snapshot -> null", readFleetSnapshot(h) === null);
    writeFileSync(path.join(swarm(h), "fleet-snapshot.json.tmp-dead"), "x");
    t("fixture[crash/store]: good write after crash reads cleanly", writeFleetSnapshot(h, goodRecipe, 9) && readFleetSnapshot(h)?.capturedAtSec === 9);
  }

  console.log("\nfleet-recovery r2 selftest: ALL PASS");
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}
