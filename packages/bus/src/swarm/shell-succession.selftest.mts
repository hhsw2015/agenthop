import { provesContinuity, successionVerdict, parseResumeTargetFromArgv, presencePidRelPath, type Attestation, type IncumbentBinding } from "./shell-succession.js";

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

// --- parseResumeTargetFromArgv: tool- and position-aware structured extraction (round-4) ---
t("argv: claude --resume <sid>", parseResumeTargetFromArgv(["claude", "--resume", "fe0376cd"]) === "fe0376cd");
t("argv: claude --resume=<sid> inline", parseResumeTargetFromArgv(["claude", "--resume=fe0376cd"]) === "fe0376cd");
t("argv: claude --resume after a value-option", parseResumeTargetFromArgv(["claude", "--model", "x", "--resume", "fe0376cd"]) === "fe0376cd");
t("argv: codex resume <sid> (subcommand at argv[1])", parseResumeTargetFromArgv(["codex", "resume", "01a0ff49"]) === "01a0ff49");
t("argv: no resume -> null", parseResumeTargetFromArgv(["claude", "--flag", "x"]) === null);
// P1-1 round-3 counterexamples
t("argv: option VALUE 'resume' is NOT a target", parseResumeTargetFromArgv(["claude", "--append-system-prompt", "resume", "fe0376cd"]) === null);
t("argv: '--resume' AFTER -- is positional, not a flag", parseResumeTargetFromArgv(["claude", "--", "--resume", "fe0376cd"]) === null);
t("argv: a value that looks like --resume is skipped (value-option)", parseResumeTargetFromArgv(["claude", "--append-system-prompt", "--resume", "fe0376cd"]) === null);
t("argv: codex with a flag before resume -> null (not position-exact)", parseResumeTargetFromArgv(["codex", "--flag", "resume", "sid"]) === null);
t("argv: codex resume with a dash target -> null", parseResumeTargetFromArgv(["codex", "resume", "--x"]) === null);
t("argv: FIRST --resume wins", parseResumeTargetFromArgv(["claude", "--resume", "A", "--resume", "B"]) === "A");
t("argv: trailing --resume with no value -> null", parseResumeTargetFromArgv(["claude", "--resume"]) === null);

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

console.log("all shell-succession selftests passed");
