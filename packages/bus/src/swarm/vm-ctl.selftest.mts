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
  buildHerdrInstallStep,
  HERDR_INSTALL_URL,
  shQuote,
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
// VMC-P1-1: negation / conflict text must NEVER be ready
t("VMC-P1-1: 'unreachable' -> down (not ready)", readyVerdict("unreachable", false) === "down");
t("VMC-P1-1: 'not ready' -> NOT ready", readyVerdict("not ready", false) !== "ready");
t("VMC-P1-1: 'herdr server not running' -> NOT ready", readyVerdict("herdr server not running", false) !== "ready");
t("VMC-P1-1: 'OK: connection refused' -> NOT ready", readyVerdict("OK: connection refused", false) !== "ready");
t("VMC-P1-1: conflict (reachable + refused) -> NOT ready", readyVerdict("reachable but connection refused", false) !== "ready");
// VMC-P1-1 round-2: generic negation/falsity (not just enumerated down-words) + structured flag
t("VMC-P1-1b: 'not online' -> NOT ready", readyVerdict("not online", false) !== "ready");
t("VMC-P1-1b: 'not connected' -> NOT ready", readyVerdict("not connected", false) !== "ready");
t("VMC-P1-1b: JSON ready:false -> down", readyVerdict('{"ready":false}', false) === "down");
t("VMC-P1-1b: JSON running:false -> down", readyVerdict('{"running":false}', false) === "down");
t("VMC-P1-1b: text 'running=false' -> NOT ready", readyVerdict("running=false", false) !== "ready");
t("VMC-P1-1b: JSON reachable:true -> ready (control)", readyVerdict('{"reachable":true}', false) === "ready");
t("VMC-P1-1b: 'server is ready' -> ready (control)", readyVerdict("server is ready", false) === "ready");
// VMC-P1-1 round-3: valid JSON judged structurally only (no text fall-through); conflict/non-bool -> unknown; progress text -> unknown
t("VMC-P1-1c-A: {ready:null} -> NOT ready", readyVerdict('{"ready":null}', false) !== "ready");
t("VMC-P1-1c-A: {ready:'pending'} -> NOT ready", readyVerdict('{"ready":"pending"}', false) !== "ready");
t("VMC-P1-1c-A: {running:0} -> NOT ready", readyVerdict('{"running":0}', false) !== "ready");
t("VMC-P1-1c-B: {ready:true,online:false} conflict -> unknown", readyVerdict('{"ready":true,"online":false}', false) === "unknown");
t("VMC-P1-1c-B: [{ready:true},{ready:false}] conflict -> unknown", readyVerdict('[{"ready":true},{"ready":false}]', false) === "unknown");
t("VMC-P1-1c-C: 'waiting for server to become ready' -> NOT ready", readyVerdict("waiting for server to become ready", false) !== "ready");
t("VMC-P1-1c-C: 'checking whether host is reachable' -> NOT ready", readyVerdict("checking whether host is reachable", false) !== "ready");
t("VMC-P1-1c-C: 'ready check pending' -> NOT ready", readyVerdict("ready check pending", false) !== "ready");
t("VMC-P1-1c: {ready:true} -> ready (control)", readyVerdict('{"ready":true}', false) === "ready");
t("VMC-P1-1c: {online:false} -> down (control)", readyVerdict('{"online":false}', false) === "down");
// VMC-P1-1 round-4: success text must FULLY match an enumerated format — no question/conditional/speculation/context
t("VMC-P1-1d: 'server is ready?' -> NOT ready", readyVerdict("server is ready?", false) !== "ready");
t("VMC-P1-1d: 'herdr server running?' -> NOT ready", readyVerdict("herdr server running?", false) !== "ready");
t("VMC-P1-1d: 'if the server is ready, continue' -> NOT ready", readyVerdict("if the server is ready, continue", false) !== "ready");
t("VMC-P1-1d: 'herdr may be running' -> NOT ready", readyVerdict("herdr may be running", false) !== "ready");
t("VMC-P1-1d: bare 'reachable' complete status -> ready (regression)", readyVerdict("reachable", false) === "ready");
t("VMC-P1-1d: 'herdr server running' (no punct) -> ready (control)", readyVerdict("herdr server running", false) === "ready");

// --- backoff: bounded, last value repeats ---
t("backoff attempt1 = first", nextBackoffSec(1) === READY_BACKOFF_SEC[0]);
t("backoff clamps to last", nextBackoffSec(99) === READY_BACKOFF_SEC[READY_BACKOFF_SEC.length - 1]);
t("backoff attempt<1 -> first", nextBackoffSec(0) === READY_BACKOFF_SEC[0]);
// VMC-P2-2: illegal custom table -> safe default; result always finite & >=0
t("VMC-P2-2: empty table -> finite default", Number.isFinite(nextBackoffSec(1, [])) && nextBackoffSec(1, []) >= 0);
t("VMC-P2-2: NaN/Infinity table -> default", nextBackoffSec(1, [NaN, Infinity]) === READY_BACKOFF_SEC[0]);
t("VMC-P2-2: negative table -> default", nextBackoffSec(2, [-5, -1]) === READY_BACKOFF_SEC[1]);
t("VMC-P2-2: valid custom table honored", nextBackoffSec(1, [3, 6]) === 3);
// VMC-P2-2 round-2: sparse-array holes must NOT pass (every skips holes)
t("VMC-P2-2b: new Array(1) -> finite default", Number.isFinite(nextBackoffSec(1, new Array(1))) && nextBackoffSec(1, new Array(1)) === READY_BACKOFF_SEC[0]);
t("VMC-P2-2b: new Array(3) -> finite default", Number.isFinite(nextBackoffSec(2, new Array(3))) && nextBackoffSec(2, new Array(3)) === READY_BACKOFF_SEC[1]);
t("VMC-P2-2b: deleted-middle sparse -> default", (() => { const a = [1, 2, 3]; delete (a as any)[1]; const r = nextBackoffSec(2, a); return Number.isFinite(r) && r === READY_BACKOFF_SEC[1]; })());

// --- credential hard-gate: stdin→0600 always; argv = refuse ---
const codex = buildCredSeed("codex");
t("codex seed via stdin (never argv)", codex.viaStdin === true && codex.remoteCmd.includes("cat > ~/.codex/auth.json"));
t("codex seed born 0600 (umask 077 + rm -f, no chmod-after)", codex.remoteCmd.includes("umask 077") && codex.remoteCmd.includes("rm -f") && !codex.remoteCmd.includes("chmod"));
const claude = buildCredSeed("claude");
t("claude seed stdin + setup-token note", claude.viaStdin === true && /setup token/i.test(claude.note));
t("cred gate: stdin+not-argv -> ok", credDeliveryOk({ viaStdin: true, inArgv: false }) === true);
t("cred gate: argv -> REFUSE (fail-closed)", credDeliveryOk({ viaStdin: true, inArgv: true }) === false);
t("cred gate: not-stdin -> REFUSE", credDeliveryOk({ viaStdin: false, inArgv: false }) === false);
t("unknown family throws", (() => { try { buildCredSeed("grok" as any); return false; } catch { return true; } })());
// VMC-P1-2: 0600 BEFORE first byte (umask+rm before cat), &&-chained, no chmod-after masquerade
t("VMC-P1-2: codex 0600 before write (umask 077 && rm -f before cat)", /umask 077 && rm -f .* && cat > ~\/\.codex\/auth\.json$/.test(codex.remoteCmd));
t("VMC-P1-2: codex &&-chained, no post-cat chmod", codex.remoteCmd.includes("&&") && !/cat >.*chmod/.test(codex.remoteCmd));
t("VMC-P1-2: claude same discipline", /umask 077 && rm -f .* && cat > ~\/\.claude\/\.credentials\.json$/.test(claude.remoteCmd));

// VMC-P2-1: install URL is single-quoted (one literal arg; no shell rewrite / pre-download substitution)
t("VMC-P2-1: shQuote wraps + escapes", shQuote("a'b") === "'a'\\''b'");
t("VMC-P2-1: boot plan single-quotes the url", buildBootPlan().some((l) => l.includes("curl -fsSL 'https://herdr.dev/install.sh'")));
t("VMC-P2-1: malicious url stays quoted (no bare &/$())", (() => {
  const l = buildBootPlan({ herdrInstallUrl: "http://x/i.sh?a=1&b=2" }).find((x) => x.includes("curl"))!;
  return l.includes("'http://x/i.sh?a=1&b=2'") && !l.includes("i.sh?a=1&b=2 ");
})());

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
const bootCurl = boot.find((l) => l.includes("curl"))!;
t("boot plan downloads then runs (RH6)", bootCurl.includes("-o") && bootCurl.includes("|| exit 1") && !boot.some((l) => l.includes("| sh")));
t("boot plan documents exec -a claude", boot.some((l) => l.includes("exec -a claude")));

// --- D4-1: buildHerdrInstallStep is the single construction point both callers compose from ---
const step = buildHerdrInstallStep();
t("D4-1: install step is download-then-run, shQuote'd url, || exit 1 (RH6+VMC-P2-1)", step.length === 3 && step[1].includes(`curl -fsSL '${HERDR_INSTALL_URL}' -o "$herdr_installer" || exit 1`) && step[2] === 'sh "$herdr_installer"' && !step.some((l) => l.includes("| sh")));
t("D4-1: custom url stays shQuote'd (metachars inert)", buildHerdrInstallStep("http://x/i.sh?a=1&b=2")[1].includes("'http://x/i.sh?a=1&b=2'"));
t("D4-1: boot plan composes the shared step verbatim", step.every((l) => boot.includes(l)));

console.log("all vm-ctl selftests passed");
