import { provesContinuity, successionVerdict, parseResumeTargetFromArgv, presencePidRelPath, planSuccession, acquireAdoptLock, releaseAdoptLock, type Attestation, type IncumbentBinding, type IncumbentLiveness } from "./shell-succession.js";
import type { RosterMember } from "./resume.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

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

// --- SU2 single-winner adopt lock (real fs) ---
const lockHome = mkdtempSync(path.join(tmpdir(), "f45-lock-"));
mkdirSync(path.join(lockHome, ".agenthop", "presence"), { recursive: true });
t("SU2 lock: first acquire wins", acquireAdoptLock(lockHome, "sidL", process.pid) === true);
t("SU2 lock: second acquire while the holder (this live process) holds it -> loses", acquireAdoptLock(lockHome, "sidL", process.pid) === false);
releaseAdoptLock(lockHome, "sidL");
t("SU2 lock: release then re-acquire wins", acquireAdoptLock(lockHome, "sidL", process.pid) === true);
writeFileSync(path.join(lockHome, ".agenthop", "presence", "sidG.adopt.lock"), "garbage"); // unreadable (non-numeric) holder
t("SU2 lock: a lock with an unreadable holder is NOT stolen (fail-closed)", acquireAdoptLock(lockHome, "sidG", process.pid) === false);
// SU2 rename-based reclaim: a DEFINITELY-dead holder (a reaped child's freed pid) is reclaimed; a live holder (above) is not.
const reaped = spawnSync(process.execPath, ["-e", ""]); const deadPid = reaped.pid ?? 0; // spawnSync blocks until exit+reap ⇒ pid is dead
writeFileSync(path.join(lockHome, ".agenthop", "presence", "sidR.adopt.lock"), String(deadPid));
t("SU2 lock: a dead holder's stale lock is reclaimed (rename-atomic)", deadPid > 0 && acquireAdoptLock(lockHome, "sidR", process.pid) === true);
rmSync(lockHome, { recursive: true, force: true });

console.log("all shell-succession selftests passed");
