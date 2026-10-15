/**
 * tern-bridge selftest (tsx-run). A FAKE `tern` (a shell script that appends its argv to a log and, depending on a per-test MODE
 * file, plays the bridge by moving requests/<id>.json to results/<id>.json) + a FAKE control dir (tmp). Covers #1034:
 *  - happy path per op class (read-only list, non-idempotent stop, start on drain-start);
 *  - read-only timeout ⇒ exactly ONE recovery chain (reload → plugin list ready → arm → re-trigger) then success;
 *  - non-idempotent timeout ⇒ {state:"UNKNOWN", hold:true} and NO second trigger / no reload;
 *  - TERN_BIN missing ⇒ unknown with zero actions (no publish, no subprocess);
 *  - status three-state: healthy / degraded (stale mirror, backlog) / unknown (no binary, socket refused).
 *
 * Run: node_modules/.bin/tsx packages/bus/src/tern-bridge.selftest.mts  (from repo root)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realRun, ternCall, ternStatus, opClass, drainActionFor, checkRoleTitle, type TernDeps } from "./tern-bridge.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// The fake tern. MODE file controls behaviour:
//   answer       — on `ctl plugins run …drain*`: move the oldest request to results with {"ok":true,"echo":<op>}
//   silent       — record argv only (simulates a disabled drain hook: request never answered)
//   heal         — silent until `plugin reload` was seen, then answer (simulates recovery working)
//   refused      — every call prints "connection refused" and exits 1
const FAKE = `#!/bin/sh
D="$FAKE_DIR"
echo "$*" >> "$D/argv.log"
MODE=$(cat "$D/mode" 2>/dev/null)
if [ "$MODE" = refused ]; then echo "error: connection refused" >&2; exit 1; fi
case "$1 $2" in
  "plugin reload") echo reloaded > "$D/reloaded"; echo ok; exit 0;;
  "plugin list") echo '{"plugins":[{"id":"agenthop-agents-bridge","status":"ready"}],"problems":[]}'; exit 0;; # never a readiness probe
  "ls --json") echo '{"sessions":[{"tabs":[{"blocks":[{"id":1},{"id":2}]}]}]}'; exit 0;;
esac
if [ "$1 $2 $3" = "ctl plugins run" ]; then
  echo '{"ok":true}' # tern ctl answers ok even for actions that do not exist — never proof of execution
  case "$4" in *arm) exit 0;; esac
  case "$4" in *mirror)
    [ "$MODE" = deadmirror ] && exit 0
    T=$(cat "$D/tick" 2>/dev/null || echo 0); T=$((T+1)); echo $T > "$D/tick"
    printf '{"tick":%s,"vm":"v-%s","agents":[]}' "$T" "$(cat "$D/reloaded" 2>/dev/null | head -c3)" > "$D/ctl/agents.json"
    exit 0;;
  esac
  if [ "$MODE" = silent ] || [ "$MODE" = deadmirror ]; then exit 0; fi
  if [ "$MODE" = heal ] && [ ! -f "$D/reloaded" ]; then exit 0; fi
  REQ=$(ls "$D/ctl/requests" 2>/dev/null | grep '\\.json$' | sort | head -1)
  [ -z "$REQ" ] && exit 0
  OP=$(sed -n 's/.*"op":"\\([a-z]*\\)".*/\\1/p' "$D/ctl/requests/$REQ")
  mkdir -p "$D/ctl/results"
  cp "$D/ctl/requests/$REQ" "$D/last-request.json"
  if [ "$OP" = start ]; then printf '{"ok":true,"echo":"start","pane":4242}' > "$D/ctl/results/$REQ"
  else printf '{"ok":true,"echo":"%s"}' "$OP" > "$D/ctl/results/$REQ"; fi
  rm -f "$D/ctl/requests/$REQ"
  exit 0
fi
exit 0
`;

function setup(mode: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ternbr-"));
  const bin = path.join(dir, "tern");
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "mode"), mode);
  mkdirSync(path.join(dir, "ctl", "requests"), { recursive: true });
  mkdirSync(path.join(dir, "ctl", "results"), { recursive: true });
  process.env.FAKE_DIR = dir; // inherited by the fake tern via realRun's env
  let n = 0;
  const deps: TernDeps = {
    bin, ctlDir: path.join(dir, "ctl"), socket: path.join(dir, "sock"),
    run: realRun(path.join(dir, "sock")),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () => `t${++n}`,
  };
  const argv = () => (existsSync(path.join(dir, "argv.log")) ? readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  const requests = () => readdirSync(path.join(dir, "ctl", "requests")).filter((f) => f.endsWith(".json"));
  return { dir, deps, argv, requests };
}

// ---- pure ----
t("opClass: list/transcript/wait read-only; ask/start/stop/interrupt non-idempotent", opClass("list") === "read-only" && opClass("wait") === "read-only" && opClass("ask") === "non-idempotent" && opClass("start") === "non-idempotent")
t("opClass: eval non-idempotent unless args.readonly=true", opClass("eval") === "non-idempotent" && opClass("eval", { readonly: true }) === "read-only")
t("drainActionFor: start ⇒ drain-start; others ⇒ drain", drainActionFor("start").endsWith(".drain-start") && drainActionFor("list").endsWith(".drain"))

// ---- happy paths ----
{
  const s = setup("answer");
  const r = await ternCall("list", {}, 2000, s.deps);
  t("happy list: state ok + bridge result returned", r.state === "ok" && (r as any).result.echo === "list")
  t("happy list: published request consumed, result consumed", s.requests().length === 0 && readdirSync(path.join(s.dir, "ctl", "results")).length === 0)
  t("happy list: triggered plugin.agenthop-agents-bridge.drain once, no reload", s.argv().filter((a) => a.includes(".drain")).length === 1 && !s.argv().some((a) => a.startsWith("plugin reload")))
  const st = await ternCall("start", { prompt: "p", cwd: "/" }, 2000, s.deps);
  t("happy start: routed to drain-start", st.state === "ok" && s.argv().some((a) => a.endsWith(".drain-start")))
  const sp = await ternCall("stop", { agent: 1 }, 2000, s.deps);
  t("happy stop (non-idempotent): ok", sp.state === "ok" && (sp as any).result.echo === "stop")
  const ev = await ternCall("eval", { code: "return 1", readonly: true }, 2000, s.deps);
  t("eval: the caller-side `readonly` flag is NOT sent on the wire", ev.state === "ok")
}
{
  const s = setup("silent");
  await ternCall("eval", { code: "return 1", readonly: true }, 300, s.deps);
  const wire = readFileSync(path.join(s.dir, "ctl", "requests", s.requests()[0]!), "utf8");
  t("eval wire body: has op+code, no readonly", wire.includes('"op":"eval"') && wire.includes('"code"') && !wire.includes("readonly"))
}

// ---- #1035: start = the front door for visible work: how defaults to "tab", role title applied via `tern rename` ----
t("checkRoleTitle: English role name ok", checkRoleTitle("Platform Dev") === null && checkRoleTitle(undefined) === null)
t("checkRoleTitle: sid-like rejected (uuid + 8-hex)", checkRoleTitle("worker 90b58f9c") !== null && checkRoleTitle("x 01a13284-d361-74a0-a026-ad56f1fdf355") !== null)
t("checkRoleTitle: non-English / empty rejected", checkRoleTitle("审查") !== null && checkRoleTitle("  ") !== null)
{
  const s = setup("answer");
  const r = await ternCall("start", { prompt: "p", cwd: "/", title: "Chief Review" }, 2000, s.deps);
  const wire = readFileSync(path.join(s.dir, "last-request.json"), "utf8");
  t("start: how defaults to \"tab\" on the wire; title NOT sent to the bridge", wire.includes('"how":"tab"') && !wire.includes("title"))
  t("start: returns the pane id and renames it to the role title", r.state === "ok" && (r as any).pane === 4242 && (r as any).renamed === "Chief Review" && s.argv().some((a) => a === "rename 4242 Chief Review"))
  await ternCall("start", { prompt: "p", cwd: "/", how: "split" }, 2000, s.deps);
  t("start: an explicit how is kept", readFileSync(path.join(s.dir, "last-request.json"), "utf8").includes('"how":"split"'))
  const before = s.argv().length;
  const bad = await ternCall("start", { prompt: "p", cwd: "/", title: "seat 90b58f9c" }, 2000, s.deps);
  t("start: a sid-like title is rejected BEFORE any publish (zero actions)", bad.state === "unknown" && s.argv().length === before && s.requests().length === 0)
}

// ---- read-only timeout ⇒ ONE recovery then success ----
{
  const s = setup("heal");
  const r = await ternCall("list", {}, 400, s.deps);
  const a = s.argv();
  t("read-only timeout: recovered once, then ok", r.state === "ok" && (r as any).recovered === true)
  t("read-only timeout: chain order = drain, reload, mirror(ready probe), arm, drain", (() => {
    const seq = a.map((x) => (x.startsWith("plugin reload") ? "reload" : x.endsWith(".mirror") ? "mirror" : x.endsWith(".arm") ? "arm" : x.endsWith(".drain") ? "drain" : "?"));
    const i = seq.indexOf("reload");
    return seq[0] === "drain" && i > 0 && seq.indexOf("mirror", i) > i && seq.indexOf("arm", i) > seq.indexOf("mirror", i) && seq.lastIndexOf("drain") > seq.indexOf("arm", i);
  })())
  t("readiness: `tern plugin list` is NEVER used as a probe", !a.some((x) => x.startsWith("plugin list")))
  t("read-only timeout: exactly ONE reload", a.filter((x) => x.startsWith("plugin reload")).length === 1)
  t("read-only timeout: the SAME request was re-triggered (one id minted, no second publish)", (r as any).id === "t1" && s.requests().length === 0)
}
{
  const s = setup("silent");
  const r = await ternCall("list", {}, 300, s.deps);
  t("read-only: still silent after recovery ⇒ timeout (recovered:true), exactly one reload", r.state === "timeout" && (r as any).recovered === true && s.argv().filter((x) => x.startsWith("plugin reload")).length === 1)
}

// ---- #1033 fact ①: ctl's {"ok":true} alone is never an answer — only results/<id>.json counts ----
{
  const s = setup("silent"); // ctl prints {"ok":true} rc0, bridge never writes a result
  const r = await ternCall("list", {}, 300, s.deps);
  t("ctl ok but no result ⇒ NOT ok (timeout after recovery)", r.state !== "ok")
}
// ---- #1033 fact ②: reload but the mirror never moves ⇒ NOT ready (no arm, no re-trigger) ----
{
  const s = setup("deadmirror");
  const r = await ternCall("list", {}, 300, s.deps);
  const a = s.argv();
  t("reload without mirror movement ⇒ unknown 'not ready', no arm", r.state === "unknown" && /not ready/.test((r as any).reason) && !a.some((x) => x.endsWith(".arm")))
}

// ---- non-idempotent timeout ⇒ UNKNOWN/HOLD, never re-sent ----
for (const [op, args] of [["stop", { agent: 1 }], ["start", { prompt: "p", cwd: "/" }], ["eval", { code: "return 1" }]] as const) {
  const s = setup("silent");
  const r = await ternCall(op, args as Record<string, unknown>, 300, s.deps);
  const a = s.argv();
  t(`non-idempotent ${op} timeout: state UNKNOWN + hold:true + id`, r.state === "UNKNOWN" && (r as any).hold === true && typeof r.id === "string")
  t(`non-idempotent ${op} timeout: ONE trigger, NO reload, NO re-trigger`, a.filter((x) => x.includes("plugins run") && !x.endsWith(".arm")).length === 1 && !a.some((x) => x.startsWith("plugin reload")))
  t(`non-idempotent ${op} timeout: request left as published (one file, not re-published)`, s.requests().length === 1)
}

// ---- FC-2: unreachable ⇒ unknown, not "dead" ----
{
  const s = setup("answer");
  let r: any; try { r = await ternCall("list", {}, 500, { ...s.deps, bin: undefined }); } catch (e) { r = { state: "threw", reason: String(e) }; }
  t("TERN_BIN missing: state unknown with reason", r.state === "unknown" && /tern binary not found/.test((r as any).reason))
  t("TERN_BIN missing: ZERO actions (no publish, no subprocess)", s.requests().length === 0 && s.argv().length === 0)
}
{
  const s = setup("refused");
  const r = await ternCall("list", {}, 500, s.deps);
  t("socket refused (read-only): state unknown with a socket reason", r.state === "unknown" && /socket unreachable|refused/i.test((r as any).reason))
  const r2 = await ternCall("ask", { agent: 1, text: "hi" }, 500, s.deps);
  t("socket refused (non-idempotent): UNKNOWN/hold — the published request is an open obligation", r2.state === "UNKNOWN" && (r2 as any).hold === true)
}

// ---- status three-state ----
{
  const s = setup("answer");
  const af = path.join(s.dir, "ctl", "agents.json");
  writeFileSync(af, JSON.stringify({ tick: 9, vm: "v1", tick_ms: 0.4, tick_ms_max: 6.7, agents: [{}, {}] }));
  const h = await ternStatus(s.deps, undefined);
  t("status healthy: fresh mirror, no backlog, ls ok", h.state === "healthy" && h.mirror?.tick === 9 && h.blocks === 2 && h.backlog === 0)
  utimesSync(af, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  writeFileSync(path.join(s.dir, "ctl", "requests", "x.json"), "{}");
  const dg = await ternStatus(s.deps, undefined);
  t("status degraded: stale mirror + backlog both reported", dg.state === "degraded" && dg.reasons.some((x) => /stale/.test(x)) && dg.reasons.some((x) => /waiting/.test(x)))
  const un = await ternStatus({ ...s.deps, bin: undefined }, undefined);
  t("status unknown: no tern binary ⇒ unknown (not degraded/dead)", un.state === "unknown")
  writeFileSync(path.join(s.dir, "mode"), "refused");
  const un2 = await ternStatus(s.deps, undefined);
  t("status unknown: socket refused ⇒ unknown", un2.state === "unknown" && un2.reasons.some((x) => /socket|refused/i.test(x)))
}

console.log("all tern-bridge selftests passed");
