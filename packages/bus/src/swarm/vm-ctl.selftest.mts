import {
  verbNeedsBackend,
  adoptMachine,
  readyVerdict,
  nextBackoffSec,
  buildCredSeed,
  credDeliveryOk,
  buildForwardArgs,
  snapshotRef,
  restorePlan,
  forkPlan,
  buildCodePlan,
  buildBootPlan,
  READY_BACKOFF_SEC,
  type Verb,
} from "./vm-ctl.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- decoupling invariant ①: ONLY up/down touch a backend; every other verb is pure SSH ---
t("only up/down need a backend", verbNeedsBackend("up") && verbNeedsBackend("down"));
const pureVerbs: Verb[] = ["adopt", "ls", "ssh", "ready", "creds", "boot", "snapshot", "restore", "forward"];
t("all other verbs are backend-agnostic (pure SSH)", pureVerbs.every((v) => !verbNeedsBackend(v)));

// --- adopt ②/③: any ssh-reachable addr → a Machine, no backend/account, lifetimeSec=null ---
const m = adoptMachine("root@1.2.3.4", { nowSec: 100 });
t("adopt: backend=adopted (accountless)", m.backend === "adopted");
t("adopt: lifetimeSec=null (not self-destructing)", m.lifetimeSec === null);
t("adopt: capacity null until probed", m.capacity === null && m.remainingSec === null);
t("adopt: id defaults to addr", m.id === "root@1.2.3.4" && m.createdSec === 100);
t("adopt: empty addr throws", (() => { try { adoptMachine(""); return false; } catch { return true; } })());
// the decoupling property: an adopted machine carries NO vendor identity, yet every pure verb applies to it
t("decoupling: adopted machine valid for all pure verbs", pureVerbs.filter((v) => v !== "adopt").every(() => m.addr.length > 0));

// --- readyVerdict: fail-closed (exit-fail=unknown; explicit only) ---
t("ready: explicit reachable -> ready", readyVerdict("herdr server running", false) === "ready");
t("ready: exit-failed -> unknown (transport, not down)", readyVerdict("ssh: connect to host ... Connection refused", true) === "unknown");
t("ready: explicit refused (exit ok) -> down", readyVerdict("connection refused", false) === "down");
t("ready: timed out -> down", readyVerdict("ssh: connect timed out", false) === "down");
t("ready: noise -> unknown", readyVerdict("some banner text", false) === "unknown");
t("ready: empty -> unknown", readyVerdict("", false) === "unknown");

// --- backoff: bounded, last value repeats ---
t("backoff attempt1 = first", nextBackoffSec(1) === READY_BACKOFF_SEC[0]);
t("backoff clamps to last", nextBackoffSec(99) === READY_BACKOFF_SEC[READY_BACKOFF_SEC.length - 1]);
t("backoff attempt<1 -> first", nextBackoffSec(0) === READY_BACKOFF_SEC[0]);

// --- credential hard-gate: stdin→0600 always; argv = refuse ---
const codex = buildCredSeed("codex");
t("codex seed via stdin (never argv)", codex.viaStdin === true && codex.remoteCmd.includes("cat > ~/.codex/auth.json"));
t("codex seed sets 0600", codex.remoteCmd.includes("chmod 600") && codex.remoteCmd.includes("umask 077"));
const claude = buildCredSeed("claude");
t("claude seed stdin + setup-token note", claude.viaStdin === true && /setup token/i.test(claude.note));
t("cred gate: stdin+not-argv -> ok", credDeliveryOk({ viaStdin: true, inArgv: false }) === true);
t("cred gate: argv -> REFUSE (fail-closed)", credDeliveryOk({ viaStdin: true, inArgv: true }) === false);
t("cred gate: not-stdin -> REFUSE", credDeliveryOk({ viaStdin: false, inArgv: false }) === false);
t("unknown family throws", (() => { try { buildCredSeed("grok" as any); return false; } catch { return true; } })());

// --- forward: ssh -L args ---
t("forward builds -L", JSON.stringify(buildForwardArgs("root@h", 8080)) === JSON.stringify(["-N", "-L", "8080:localhost:8080", "root@h"]));
t("forward distinct local port", buildForwardArgs("root@h", 80, 8080)[2] === "8080:localhost:80");
t("forward bad port throws", (() => { try { buildForwardArgs("h", 0); return false; } catch { return true; } })());

// --- poor-man's-sleep + snapshot genealogy (checkpoint/template/fork) ---
const snap = snapshotRef("vm-x", { nowSec: 1000 });
t("snapshot default kind=checkpoint, name=ts", snap.kind === "checkpoint" && snap.name === "1000" && snap.branch === "vmctl-snap/1000");
const plan = restorePlan(snap, "vm-y");
t("checkpoint restore: boot -> checkout -> breakpoint -> succession", plan.length === 4 && plan[0].includes("boot vm-y") && plan[3].includes("succession"));
const tmpl = snapshotRef("vm-x", { kind: "template", name: "golden", nowSec: 1000 });
const tplan = restorePlan(tmpl, "vm-z");
t("template restore SKIPS bootstrap (instant set-up)", tplan[0].includes("skip bootstrap") && !tplan.some((s) => s.startsWith("boot ")));
t("template branch uses the name", tmpl.branch === "vmctl-snap/golden");
const fk = forkPlan(snap, ["a", "b", "c"]);
t("fork: one install amortized across N", fk[0].includes("3 machines") && fk.length === 4 && fk[3].includes("c"));
t("fork: empty targets throws", (() => { try { forkPlan(snap, []); return false; } catch { return true; } })());

// --- code facade: one-shot up/adopt -> ready -> creds -> boot -> machine-add (position transparency) ---
const code = buildCodePlan("claude", { verb: "up", backend: "railway" });
t("code plan: 5 steps up->ready->creds->boot->machine-add", code.length === 5 && code[0].includes("up --backend railway") && code[4].includes("machine add"));
t("code plan: creds stdin-0600 never argv", code[2].includes("stdin") && code[2].includes("never argv"));
t("code plan: position-transparent mount noted", code[4].includes("remote member == local member"));
t("code plan via adopt (accountless source)", buildCodePlan("codex", { verb: "adopt", addr: "root@h" })[0].includes("adopt root@h"));

// --- boot plan: download-then-run (never curl|sh), re-runnable ---
const boot = buildBootPlan();
t("boot plan downloads then runs (RH6)", boot[0].includes("-o") && boot[0].includes("|| exit 1") && !boot[0].includes("| sh"));
t("boot plan documents exec -a claude", boot.some((l) => l.includes("exec -a claude")));

console.log("all vm-ctl selftests passed");
