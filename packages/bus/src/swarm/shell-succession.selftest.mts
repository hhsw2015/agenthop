import { provesContinuity, successionVerdict, parseResumeTargetFromArgv, argvFromCmdline, presencePidRelPath, planSuccession, adoptLockSite, type Attestation, type IncumbentBinding, type IncumbentLiveness } from "./shell-succession.js";
import { acquireHolderLock, releaseHolderLock } from "./holder-lock.js";
import { probeCandidateLiveness, probeSessionLiveness, sidSockPrefix } from "./task-liveness.js";
import type { RosterMember } from "./resume.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// default att: env known+matching, structured resume target = the stable sid (binds).
const att = (o: Partial<Attestation> = {}): Attestation => ({ machine: "m1", cwd: "/w", tool: "claude", resumeCmd: "claude --resume fe0376cd", resumeTargetSid: "fe0376cd", newPid: 200, newNativeSid: "new-sid", ...o });
const inc = (o: Partial<IncumbentBinding> = {}): IncumbentBinding => ({ stableSid: "fe0376cd", mintedId: "minted-1", recordedMachine: "m1", recordedCwd: "/w", recordedTool: "claude", incumbentPid: 100, incumbentLiveness: "dead", ...o });

// --- provesContinuity: env must be KNOWN + matching ---
t("all match (resume target binds) -> true", provesContinuity(att(), inc()) === true);
t("machine mismatch -> false", provesContinuity(att({ machine: "m2" }), inc()) === false);
t("cwd mismatch -> false", provesContinuity(att({ cwd: "/other" }), inc()) === false);
t("tool mismatch -> false", provesContinuity(att({ tool: "codex" }), inc()) === false);
// F45-P1-1 CE2: empty env proves nothing, even with a positive sidBinds
t("empty machine -> false (env must be KNOWN)", provesContinuity(att({ machine: "", newNativeSid: "fe0376cd" }), inc()) === false);
t("empty cwd -> false", provesContinuity(att({ cwd: "", newNativeSid: "fe0376cd" }), inc()) === false);
t("empty tool -> false", provesContinuity(att({ tool: "", newNativeSid: "fe0376cd" }), inc()) === false);

// F45-P1-1 CE1: a credential must BIND to THIS sid structurally — not appear in free text
t("resume target == sid -> binds (true)", provesContinuity(att({ resumeTargetSid: "fe0376cd" }), inc({ stableSid: "fe0376cd" })) === true);
t("one shell resuming A canNOT adopt B (structured target, not substring)", provesContinuity(att({ resumeTargetSid: "A" }), inc({ stableSid: "B" })) === false);
t("resume target A DOES adopt A (same shell, its real target)", provesContinuity(att({ resumeTargetSid: "A" }), inc({ stableSid: "A" })) === true);
t("conflicting resume target disqualifies even if pane+sid would bind", provesContinuity(att({ resumeTargetSid: "OTHER", herdrPane: "p1", newNativeSid: "fe0376cd" }), inc({ stableSid: "fe0376cd", recordedHerdrPane: "p1" })) === false);
t("no binding credential (no target, pane, or sid match) -> false", provesContinuity(att({ resumeTargetSid: undefined, herdrPane: undefined, newNativeSid: "new-sid" }), inc()) === false);

// positive cases the reviewer asked to KEEP: explicit resume target / inherited pane / already-held native sid
t("sidBinds (shell already carries stable sid) -> true", provesContinuity(att({ resumeTargetSid: undefined, newNativeSid: "fe0376cd" }), inc({ stableSid: "fe0376cd" })) === true);
t("paneBinds (inherited pane recorded for this sid) -> true", provesContinuity(att({ resumeTargetSid: undefined, herdrPane: "p1", newNativeSid: "new-sid" }), inc({ recordedHerdrPane: "p1" })) === true);
t("pane disagree (both known) -> false", provesContinuity(att({ resumeTargetSid: undefined, herdrPane: "p1", newNativeSid: "new-sid" }), inc({ recordedHerdrPane: "p2" })) === false);
t("pane known one side only -> not a conflict (resume target still binds)", provesContinuity(att({ herdrPane: "p1" }), inc({ recordedHerdrPane: null })) === true);

// --- parseResumeTargetFromArgv (round-5): RECOGNIZED codex entrypoint only; claude is never parsed (sidBinds covers it) ---
t("argv: codex resume <sid> (exact entrypoint + position)", parseResumeTargetFromArgv(["codex", "resume", "01a0ff49"]) === "01a0ff49");
t("argv: /usr/local/bin/codex resume <sid> (path basename)", parseResumeTargetFromArgv(["/usr/local/bin/codex", "resume", "01a0ff49"]) === "01a0ff49");
// P1-1 round-4 counterexamples — all must be null
t("argv: node maintenance.mjs --resume SID -> null (not a codex entrypoint)", parseResumeTargetFromArgv(["node", "maintenance.mjs", "--resume", "SID"]) === null);
t("argv: codex-inspector resume SID -> null (exact basename, no substring)", parseResumeTargetFromArgv(["codex-inspector", "resume", "SID"]) === null);
t("argv: claude --name --resume SID -> null (claude not parsed)", parseResumeTargetFromArgv(["claude", "--name", "--resume", "SID"]) === null);
t("argv: claude --resume SID -> null (claude keeps its sid; sidBinds, not argv)", parseResumeTargetFromArgv(["claude", "--resume", "fe0376cd"]) === null);
t("argv: codex with a flag before resume -> null (not position-exact)", parseResumeTargetFromArgv(["codex", "--flag", "resume", "sid"]) === null);
t("argv: codex resume with a dash target -> null", parseResumeTargetFromArgv(["codex", "resume", "--x"]) === null);
t("argv: codex alone -> null", parseResumeTargetFromArgv(["codex", "resume"]) === null);

// --- SP3 (round-4): /proc/<pid>/cmdline parse keeps EXACT argv boundaries. Args are NUL-separated AND NUL-terminated; only the
//     single trailing terminator is dropped, NEVER interior/trailing empty real args (a `.filter(Boolean)` would shift positions
//     and could FABRICATE a resume target out of a non-target arg). The parse result MUST equal the raw-array parse result. ---
const sp3 = (parts: string[]) => parts.join("\0") + "\0"; // kernel form: each arg NUL-terminated ⇒ trailing terminator
t("cmdline: normal codex resume -> exact argv", JSON.stringify(argvFromCmdline(sp3(["codex", "resume", "01a0ff49"]))) === JSON.stringify(["codex", "resume", "01a0ff49"]));
t("cmdline: empty buffer -> [] (zombie/kernel thread)", argvFromCmdline("").length === 0);
t("cmdline: no trailing NUL -> kept as-is", JSON.stringify(argvFromCmdline("codex\0resume")) === JSON.stringify(["codex", "resume"]));
// the false-adopt counterexamples: filter(Boolean) would shift and yield a target; the correct parse yields NONE (same as raw array)
t("cmdline: EMPTY FIRST arg preserved -> parse null (argv0 '' != codex), NOT shifted to adopt",
  (() => { const a = argvFromCmdline(sp3(["", "codex", "resume", "sid"])); return JSON.stringify(a) === JSON.stringify(["", "codex", "resume", "sid"]) && parseResumeTargetFromArgv(a) === null; })());
t("cmdline: EMPTY TARGET arg preserved -> parse null (argv2 ''), NOT shifted to adopt the next arg",
  (() => { const a = argvFromCmdline(sp3(["codex", "resume", "", "x"])); return JSON.stringify(a) === JSON.stringify(["codex", "resume", "", "x"]) && parseResumeTargetFromArgv(a) === null; })());
t("cmdline: argv ending in a real empty arg -> that empty is KEPT (only the terminator dropped)",
  JSON.stringify(argvFromCmdline(sp3(["codex", "resume", ""]))) === JSON.stringify(["codex", "resume", ""]));
t("cmdline: interior arg WITH SPACES survives exactly (no boundary loss)",
  JSON.stringify(argvFromCmdline(sp3(["/my dir/codex", "resume", "sid"]))) === JSON.stringify(["/my dir/codex", "resume", "sid"]));

// --- successionVerdict: fail-closed ---
const vAdopt = successionVerdict(att(), inc({ incumbentLiveness: "dead" }));
t("dead + continuity -> adopt", vAdopt.action === "adopt");
t("adopt rebinds stable sid to our pid, reuses mintedId", vAdopt.rebind?.stableSid === "fe0376cd" && vAdopt.rebind?.pid === 200 && vAdopt.rebind?.mintedId === "minted-1");
t("absent + continuity -> adopt", successionVerdict(att(), inc({ incumbentLiveness: "absent", incumbentPid: null })).action === "adopt");
t("LIVE other incumbent -> reject (never steal a live slot)", successionVerdict(att({ newPid: 200 }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "reject");
t("reject carries no rebind", successionVerdict(att(), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).rebind === undefined);
t("LIVE incumbent that IS us (same pid + proven) -> adopt idempotent", successionVerdict(att({ newPid: 100 }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "adopt");
t("same-pid + ALIVE + env conflict -> reject (pid alone is not identity)", successionVerdict(att({ newPid: 100, cwd: "/other" }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "reject");
t("same-pid + DEAD + env conflict -> fresh (not adopt)", successionVerdict(att({ newPid: 100, machine: "m2" }), inc({ incumbentLiveness: "dead", incumbentPid: 100 })).action === "fresh");
t("dead + env ok but NO binding credential -> fresh", successionVerdict(att({ resumeTargetSid: undefined, newNativeSid: "new-sid" }), inc({ incumbentLiveness: "dead" })).action === "fresh");
t("dead + sidBinds -> adopt", successionVerdict(att({ resumeTargetSid: undefined, newNativeSid: "fe0376cd" }), inc({ incumbentLiveness: "dead" })).action === "adopt");
t("dead but continuity FAILS -> fresh (never hijack)", successionVerdict(att({ cwd: "/elsewhere" }), inc({ incumbentLiveness: "dead" })).action === "fresh");
t("adopt with no recorded mintedId -> mintedId null (not invented)", successionVerdict(att(), inc({ mintedId: null, incumbentLiveness: "dead" })).rebind?.mintedId === null);

// --- path helper ---
t("presence pid rel path", presencePidRelPath("fe0376cd") === "presence/fe0376cd.pid");

// --- planSuccession: roster-snapshot candidate selection + verdict (F45 ① consumption-point core; async — incumbentOf probes the live socket) ---
const mem = (o: Partial<RosterMember> = {}): RosterMember => ({ member: "fe0376cd", tool: "claude", cwd: "/w", role: null, resumeCmd: "claude --resume fe0376cd", ...o });
const deadInc: (s: string) => Promise<IncumbentLiveness> = async () => ({ pid: 100, liveness: "dead" });
const aliveInc: (s: string) => Promise<IncumbentLiveness> = async () => ({ pid: 100, liveness: "alive" });
t("plan: no roster members -> fresh", (await planSuccession(att(), [], deadInc)).action === "fresh");
t("SP1 same-sid fix: no resume target, credential=own native sid, member matches, dead -> ADOPT (restore own slot)",
  (await planSuccession(att({ resumeTargetSid: undefined, newNativeSid: "fe0376cd" }), [mem({ member: "fe0376cd" })], deadInc)).action === "adopt");
const spOrder = await planSuccession(att({ resumeTargetSid: "B", newNativeSid: "new-sid" }), [mem({ member: "A" }), mem({ member: "B" })], deadInc);
t("SP1 candidate by CREDENTIAL not roster order: [A,B] + credential B -> adopt B (not the first entry A)", spOrder.action === "adopt" && spOrder.rebind?.stableSid === "B");
t("SP2 empty/unknown cwd -> fresh (environment unprovable, never normalized to root)",
  (await planSuccession(att({ cwd: "", resumeTargetSid: "fe0376cd", newNativeSid: "new-sid" }), [mem()], deadInc)).action === "fresh");
t("SP2 a record with empty cwd does NOT match a shell at root",
  (await planSuccession(att({ cwd: "/", resumeTargetSid: "fe0376cd", newNativeSid: "new-sid" }), [mem({ cwd: "" })], deadInc)).action === "fresh");
t("plan: tool mismatch -> no candidate -> fresh", (await planSuccession(att({ tool: "codex" }), [mem({ tool: "claude" })], deadInc)).action === "fresh");
t("plan: cwd mismatch -> no candidate -> fresh", (await planSuccession(att({ cwd: "/other" }), [mem({ cwd: "/w" })], deadInc)).action === "fresh");
const spAdopt = await planSuccession(att({ resumeTargetSid: "fe0376cd", newNativeSid: "new-sid" }), [mem({ member: "fe0376cd" })], deadInc);
t("plan: match + resume-target credential + dead incumbent -> ADOPT", spAdopt.action === "adopt" && spAdopt.rebind?.stableSid === "fe0376cd" && spAdopt.rebind?.pid === 200 && spAdopt.rebind?.mintedId === null);
t("plan: match but LIVE incumbent -> reject (never steal a live slot)", (await planSuccession(att({ resumeTargetSid: "fe0376cd", newNativeSid: "new-sid" }), [mem({ member: "fe0376cd" })], aliveInc)).action === "reject");
t("plan: credential names a sid with no roster member -> fresh", (await planSuccession(att({ resumeTargetSid: undefined, herdrPane: undefined, newNativeSid: "new-sid" }), [mem({ member: "fe0376cd" })], deadInc)).action === "fresh");
t("plan: cwd compared normalized (trailing slash)", (await planSuccession(att({ cwd: "/w/", resumeTargetSid: "fe0376cd", newNativeSid: "new-sid" }), [mem({ cwd: "/w" })], deadInc)).action === "adopt");

// --- SU2 single-winner adopt lock (holder-lock via adoptLockSite; real fs). Deep stale/own-recovery cases live in holder-lock's
//     own selftest (DA2); here we verify the SITE + single-winner integration. ---
const lockHome = mkdtempSync(path.join(tmpdir(), "f45-lock-"));
mkdirSync(path.join(lockHome, ".agenthop", "presence"), { recursive: true });
const siteL = adoptLockSite(lockHome, "sidL");
const tok1 = acquireHolderLock(siteL);
t("SU2 lock: first acquire wins (token)", typeof tok1 === "string");
if (tok1) releaseHolderLock(siteL, tok1);
const tok2 = acquireHolderLock(siteL);
t("SU2 lock: release then re-acquire wins", typeof tok2 === "string");
if (tok2) releaseHolderLock(siteL, tok2);
// a FOREIGN LIVE holder (a different, live pid published inside the lock dir) ⇒ contended (never stolen). pid 1 (init/launchd)
// is always live and not ours (process.kill(1,0) ⇒ EPERM, not ESRCH ⇒ not reclaimable).
const siteF = adoptLockSite(lockHome, "sidF");
mkdirSync(siteF.lockDir); writeFileSync(path.join(siteF.lockDir, "1.deadbeef"), "");
t("SU2 lock: a live FOREIGN holder is contended (null), never stolen", acquireHolderLock(siteF) === null);
const sA = acquireHolderLock(adoptLockSite(lockHome, "sidA"));
const sB = acquireHolderLock(adoptLockSite(lockHome, "sidB"));
t("SU2 lock: distinct sids are independent locks (both win)", typeof sA === "string" && typeof sB === "string");
rmSync(lockHome, { recursive: true, force: true });

// --- SU1 (round-5) candidate-probe uncertainty: probeCandidateLiveness must distinguish a CONFIRMED live owner, a CONFIRMED
//     dead/other candidate, and an UNCONFIRMABLE one (a connected-but-unresponsive socket = a live-but-slow owner). A response
//     TIMEOUT must NOT read as absence (the r5 false-adopt: a current instance with a momentarily blocked event loop answers the
//     connect but not the sid write within the probe window, and was being consumed as adoptable). Real unix sockets. ---
// A SHORT home (/tmp, not the deep mkdtemp tmpdir) so the prefix(32)+nonce socket path fits the macOS AF_UNIX ~104-byte limit.
const sockHome = mkdtempSync("/tmp/f45s-");
const servers: net.Server[] = [];
const mkServer = (p: string, onConn: (s: net.Socket) => void): Promise<string> => new Promise((res) => {
  const srv = net.createServer(onConn); servers.push(srv); srv.listen(p, () => res(p));
});
const aliveP = await mkServer(path.join(sockHome, "alive.sock"), (s) => s.end("sidX"));           // emits EXACTLY our sid, then closes
const otherP = await mkServer(path.join(sockHome, "other.sock"), (s) => s.end("a-different-sid")); // a different owner answers
const slowP  = await mkServer(path.join(sockHome, "slow.sock"), () => { /* accept, then NEVER write/close within the window */ });
t("probeCandidate: emits exact sid -> alive", (await probeCandidateLiveness(aliveP, "sidX", 300)) === "alive");
t("probeCandidate: emits a DIFFERENT sid -> dead (a confirmed other owner, not ours)", (await probeCandidateLiveness(otherP, "sidX", 300)) === "dead");
t("probeCandidate: no listener at path -> dead (ECONNREFUSED/ENOENT leftover)", (await probeCandidateLiveness(path.join(sockHome, "nope.sock"), "sidX", 300)) === "dead");
t("probeCandidate: connected but response times out -> UNKNOWN (live-but-slow owner, never 'dead')", (await probeCandidateLiveness(slowP, "sidX", 150)) === "unknown");

// probeSessionLiveness aggregation (real sockets at the CORRECT hashed prefix in a presence dir):
const SID = "fe0376cd-f1df-4d46-a15d-b333acba7ee9";
const presDir = path.join(sockHome, ".agenthop", "presence");
mkdirSync(presDir, { recursive: true });
const pref = sidSockPrefix(SID);
t("probeSessionLiveness: enumerable dir, no candidate -> no-socket (confirmed absent)", (await probeSessionLiveness(sockHome, SID, 200)) === "no-socket");
const aliveSock = await mkServer(path.join(presDir, `${pref}.a.sock`), (s) => s.end(SID)); void aliveSock;
t("probeSessionLiveness: a live candidate at the hashed prefix -> alive", (await probeSessionLiveness(sockHome, SID, 300)) === "alive");
// SU1 crux at the AGGREGATION layer: a SLOW (connected-but-silent) candidate and NO live one ⇒ "unknown" (absence unprovable ⇒
// the adoption path must NOT treat this as adoptable). Replace the dir with only a slow candidate.
rmSync(path.join(presDir, `${pref}.a.sock`), { force: true });
const slowSock = await mkServer(path.join(presDir, `${pref}.s.sock`), () => { /* silent */ }); void slowSock;
t("probeSessionLiveness: only a connected-but-silent candidate -> unknown (NOT no-socket; forbids adoption)", (await probeSessionLiveness(sockHome, SID, 150)) === "unknown");
for (const s of servers) { try { s.close(); } catch { /* noop */ } }
rmSync(sockHome, { recursive: true, force: true });

// ── SUCC-1 r2 (codex:Work): the crash-stranded EMPTY adopt lock is reclaimed INSIDE acquireHolderLock via the opt-in
//    reclaimExternalStranded — no out-of-band rmdir (so no ABA), single-winner, confirmed-dead-only (SUCC1-2). ──
{
  const mkHome = () => mkdtempSync(path.join(tmpdir(), "succ1-"));
  const SID = "succ-sid-1";
  // Lay down the on-disk state of a crash between holder-lock's mkdir and its identity write: an EMPTY lock dir + a hold-intent
  // naming `intentPid` (the crashed owner). This is exactly what runSuccessionAtStartup's acquire then meets.
  const strand = (home: string, intentPid: number) => {
    const site = adoptLockSite(home, SID);
    mkdirSync(site.lockDir, { recursive: true });
    writeFileSync(path.join(site.intentDir, `${site.intentPrefix}${intentPid}.abcdef`), "");
    return site;
  };

  // crash-recovery: stranded empty lock + a CONFIRMED-DEAD intent + the opt-in ⇒ reclaimed (rmdir-if-empty + fresh take) ⇒ sid
  // acquirable, with EXACTLY our identity in the dir (no double-identity residue).
  {
    const home = mkHome(); const site = strand(home, 999999);          // 999999 ⇒ ESRCH ⇒ confirmed dead
    const token = acquireHolderLock(site);
    t("SUCC-1 crash-recovery: a stranded empty lock + dead intent is reclaimed ⇒ token (not deaf forever)", token !== null);
    t("SUCC-1 crash-recovery: our identity is now published IN the dir", existsSync(path.join(site.lockDir, String(token))));
    t("SUCC-1 crash-recovery: EXACTLY one identity in the dir after reclaim (no double-identity)", readdirSync(site.lockDir).length === 1);
    if (token) releaseHolderLock(site, token);
    rmSync(home, { recursive: true, force: true });
  }

  // SUCC1-1 (codex:Work): a stale CONFIRMED-DEAD intent must NEVER authorize taking a dir that is ACTUALLY HELD. If a holder has
  // published into the dir (non-empty) and is a LIVE foreign pid, the reclaimer must go to the published-holder branch and
  // CONTEND — the all-dead intent scan is not proof the CURRENT dir is unoccupied (the TOCTOU the r3 fix closes).
  {
    const home = mkHome(); const site = adoptLockSite(home, SID);
    mkdirSync(site.lockDir, { recursive: true });
    writeFileSync(path.join(site.lockDir, "1.deadbeef"), "");                         // a LIVE foreign holder (pid 1 ⇒ EPERM ⇒ alive) published here
    writeFileSync(path.join(site.intentDir, `${site.intentPrefix}999999.aa`), "");    // + a STALE confirmed-dead intent on disk
    t("SUCC1-1: a stale dead intent does NOT authorize stealing a LIVE published holder ⇒ contend", acquireHolderLock(site) === null);
    t("SUCC1-1: the live holder's identity is untouched", existsSync(path.join(site.lockDir, "1.deadbeef")) && readdirSync(site.lockDir).length === 1);
    rmSync(home, { recursive: true, force: true });
  }

  // SUCC1-3 (codex:Work): a dead MULTI-token residue — left when two rejected publishSole backouts both failed their exact-name
  // cleanup on a transient dir fault — must be RECOVERABLE, not permanently un-adoptable. Every token CONFIRMED-DEAD (ESRCH) and
  // none live ⇒ reclaimed by exact name (default: published identities prove death, like the single-holder reclaim).
  {
    const home = mkHome(); const site = adoptLockSite(home, SID);
    mkdirSync(site.lockDir, { recursive: true });
    writeFileSync(path.join(site.lockDir, "999998.aaaaaa"), ""); // dead pid A
    writeFileSync(path.join(site.lockDir, "999999.bbbbbb"), ""); // dead pid B
    const token = acquireHolderLock(site);
    t("SUCC1-3: a dead multi-token residue is reclaimed (not permanently un-adoptable) ⇒ token", token !== null);
    t("SUCC1-3: after recovery EXACTLY our identity remains (both dead residues removed)", token !== null && readdirSync(site.lockDir).length === 1 && existsSync(path.join(site.lockDir, String(token))));
    if (token) releaseHolderLock(site, token);
    rmSync(home, { recursive: true, force: true });
  }

  // SUCC1-3 protection: a >1 residue where ANY token is a LIVE/unknown pid ⇒ contend — never delete a live/unknown identity (no P1 reopen).
  {
    const home = mkHome(); const site = adoptLockSite(home, SID);
    mkdirSync(site.lockDir, { recursive: true });
    writeFileSync(path.join(site.lockDir, "999999.dead"), ""); // confirmed dead
    writeFileSync(path.join(site.lockDir, "1.live"), "");      // pid 1 ⇒ EPERM ⇒ alive/unknown ⇒ protected
    t("SUCC1-3: a multi-token dir with a LIVE/unknown identity ⇒ contend (residue not touched)", acquireHolderLock(site) === null);
    t("SUCC1-3: both tokens untouched when one is live/unknown", readdirSync(site.lockDir).length === 2);
    rmSync(home, { recursive: true, force: true });
  }

  // opt-in gating: the SAME stranded state WITHOUT the opt ⇒ contends (decision-batch / shared-budget are byte-identical).
  {
    const home = mkHome(); const site = strand(home, 999999);
    t("SUCC-1 opt-in: default acquire (no reclaim) still CONTENDS an external stranded dir", acquireHolderLock(site) === null);
    rmSync(home, { recursive: true, force: true });
  }

  // SUCC1-2 three-state: a NON-ESRCH (alive/unknown) foreign intent must NOT authorize reclaim, even with the opt-in. pid 1 (init)
  // probes EPERM ⇒ alive ⇒ not-all-dead ⇒ contend. This is also the ABA single-winner proxy: a concurrent acquirer's LIVE intent
  // blocks reclaim, so two racing reclaimers each see the other and both contend (only a SOLO acquirer reclaims).
  {
    const home = mkHome(); const site = strand(home, 1);              // pid 1 ⇒ EPERM ⇒ alive/unknown, NOT ESRCH
    t("SUCC1-2: an alive/unknown foreign intent ⇒ reclaim CONTENDS (non-ESRCH never authorizes; single-winner)", acquireHolderLock(site) === null);
    rmSync(home, { recursive: true, force: true });
  }

  // a stranded dir with a DEAD intent AND a concurrent LIVE intent (pid 1) ⇒ not all-dead ⇒ contend (two racers both contend).
  {
    const home = mkHome(); const site = strand(home, 999999);
    writeFileSync(path.join(site.intentDir, `${site.intentPrefix}1.beef`), ""); // a concurrent acquirer's live intent
    t("SUCC-1 ABA: a dead intent + a concurrent live intent ⇒ CONTEND (no double-holder)", acquireHolderLock(site) === null);
    rmSync(home, { recursive: true, force: true });
  }

  // no intents at all (empty dir, nothing proving a crash) ⇒ NOT reclaimed even with the opt (requires >=1 confirmed-dead intent).
  {
    const home = mkHome(); const site = adoptLockSite(home, SID); mkdirSync(site.lockDir, { recursive: true });
    t("SUCC-1: an empty dir with NO hold-intent is not provably stranded ⇒ contend", acquireHolderLock(site) === null);
    rmSync(home, { recursive: true, force: true });
  }

  // restart-idempotency: after a reclaim+release the sid acquires cleanly again (no residue strands it).
  {
    const home = mkHome(); const site = strand(home, 999999);
    const t1 = acquireHolderLock(site); if (t1) releaseHolderLock(site, t1);
    const t2 = acquireHolderLock(site);
    t("SUCC-1 idempotent: reclaim → release → re-acquire succeeds (no stranded residue)", t2 !== null);
    if (t2) releaseHolderLock(site, t2);
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("all shell-succession selftests passed");
