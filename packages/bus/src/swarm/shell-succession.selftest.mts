import { provesContinuity, successionVerdict, presencePidRelPath, type Attestation, type IncumbentBinding } from "./shell-succession.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const att = (o: Partial<Attestation> = {}): Attestation => ({ machine: "m1", cwd: "/w", tool: "claude", resumeCmd: "claude --resume fe0376cd", newPid: 200, newNativeSid: "new-sid", ...o });
const inc = (o: Partial<IncumbentBinding> = {}): IncumbentBinding => ({ stableSid: "fe0376cd", mintedId: "minted-1", recordedMachine: "m1", recordedCwd: "/w", recordedTool: "claude", recordedResumeCmd: "claude --resume fe0376cd", incumbentPid: 100, incumbentLiveness: "dead", ...o });

// --- provesContinuity ---
t("continuity: all match -> true", provesContinuity(att(), inc()) === true);
t("continuity: machine mismatch -> false", provesContinuity(att({ machine: "m2" }), inc()) === false);
t("continuity: cwd mismatch -> false", provesContinuity(att({ cwd: "/other" }), inc()) === false);
t("continuity: tool mismatch -> false", provesContinuity(att({ tool: "codex" }), inc()) === false);
t("continuity: resumeCmd disagree -> false", provesContinuity(att({ resumeCmd: "x" }), inc()) === false);
// F45-P1-1: environment sameness is NOT identity — without a credential binding to THIS stableSid, no continuity.
t("continuity: v1 roster (no resumeCmd/pane, sid differs) -> FALSE (env != identity)", provesContinuity(att({ resumeCmd: "anything", newNativeSid: "new-sid" }), inc({ recordedResumeCmd: null })) === false);
t("continuity: resumeCmd matches but does NOT name the sid (generic template) -> false", provesContinuity(att({ resumeCmd: "claude", newNativeSid: "new-sid" }), inc({ recordedResumeCmd: "claude", recordedHerdrPane: null })) === false);
t("continuity: sidBinds (shell already carries stable sid) -> true even without resumeCmd", provesContinuity(att({ resumeCmd: "x", newNativeSid: "fe0376cd" }), inc({ recordedResumeCmd: null })) === true);
t("continuity: paneBinds alone (no resumeCmd) -> true", provesContinuity(att({ resumeCmd: "claude", herdrPane: "p1", newNativeSid: "new-sid" }), inc({ recordedResumeCmd: null, recordedHerdrPane: "p1" })) === true);
t("continuity: two different stableSids, empty fields -> both fresh (no binding)", provesContinuity(att({ resumeCmd: "x", newNativeSid: "n" }), inc({ stableSid: "A", recordedResumeCmd: null })) === false && provesContinuity(att({ resumeCmd: "x", newNativeSid: "n" }), inc({ stableSid: "B", recordedResumeCmd: null })) === false);
t("continuity: herdr pane disagree (both known) -> false", provesContinuity(att({ herdrPane: "p1" }), inc({ recordedHerdrPane: "p2" })) === false);
t("continuity: herdr pane match -> true", provesContinuity(att({ herdrPane: "p1" }), inc({ recordedHerdrPane: "p1" })) === true);
t("continuity: pane known one side only -> not required (resumeCmd still binds)", provesContinuity(att({ herdrPane: "p1" }), inc({ recordedHerdrPane: null })) === true);

// --- successionVerdict: fail-closed ---
const vAdopt = successionVerdict(att(), inc({ incumbentLiveness: "dead" }));
t("dead incumbent + continuity -> adopt", vAdopt.action === "adopt");
t("adopt rebinds stable sid to our pid, reuses mintedId", vAdopt.rebind?.stableSid === "fe0376cd" && vAdopt.rebind?.pid === 200 && vAdopt.rebind?.mintedId === "minted-1");
t("absent incumbent + continuity -> adopt", successionVerdict(att(), inc({ incumbentLiveness: "absent", incumbentPid: null })).action === "adopt");

t("LIVE other incumbent -> reject (never steal a live slot)", successionVerdict(att({ newPid: 200 }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "reject");
t("reject carries no rebind", successionVerdict(att(), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).rebind === undefined);
t("LIVE incumbent that IS us (same pid + proven) -> adopt idempotent", successionVerdict(att({ newPid: 100 }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "adopt");
// F45-P1-1: same pid must NOT exempt the continuity check
t("same-pid + ALIVE + env conflict -> reject (pid alone is not identity)", successionVerdict(att({ newPid: 100, cwd: "/other" }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "reject");
t("same-pid + DEAD + env conflict -> fresh (not adopt)", successionVerdict(att({ newPid: 100, machine: "m2" }), inc({ incumbentLiveness: "dead", incumbentPid: 100 })).action === "fresh");
t("dead + env matches but NO binding credential -> fresh", successionVerdict(att({ resumeCmd: "claude", newNativeSid: "new-sid" }), inc({ recordedResumeCmd: null, incumbentLiveness: "dead" })).action === "fresh");
t("dead + sidBinds -> adopt", successionVerdict(att({ resumeCmd: "x", newNativeSid: "fe0376cd" }), inc({ recordedResumeCmd: null, incumbentLiveness: "dead" })).action === "adopt");

t("dead incumbent but continuity FAILS -> fresh (never hijack)", successionVerdict(att({ cwd: "/elsewhere" }), inc({ incumbentLiveness: "dead" })).action === "fresh");
t("fresh carries no rebind", successionVerdict(att({ machine: "m2" }), inc({ incumbentLiveness: "absent" })).rebind === undefined);
t("adopt with no recorded mintedId -> mintedId null (not invented)", successionVerdict(att(), inc({ mintedId: null, incumbentLiveness: "dead" })).rebind?.mintedId === null);

// --- liveness precedence: a live OTHER incumbent beats continuity (can't steal even a proven continuation) ---
t("live other incumbent overrides proven continuity", successionVerdict(att({ newPid: 999 }), inc({ incumbentLiveness: "alive", incumbentPid: 100 })).action === "reject");

// --- path helper ---
t("presence pid rel path", presencePidRelPath("fe0376cd") === "presence/fe0376cd.pid");

console.log("all shell-succession selftests passed");
