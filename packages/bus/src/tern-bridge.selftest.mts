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
import { realRun, ternCall, ternStatus, opClass, drainActionFor, checkRoleTitle, resumedSeat, type TernDeps } from "./tern-bridge.js";

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
  "process 4242") echo '{"pane":4242,"child":{"pid":9100}}'; exit 0;;
  "ls --json") echo '{"sessions":[{"tabs":[{"blocks":[{"id":1},{"id":2}]}]}]}'; exit 0;;
esac
if [ "$1 $2 $3" = "ctl plugins run" ]; then
  echo '{"ok":true}' # tern ctl answers ok even for actions that do not exist — never proof of execution
  case "$4" in *.arm-scan)
    [ -f "$D/noscan" ] && exit 0
    printf '{"step":"scanned","count":%s}' "$(cat "$D/patrols" 2>/dev/null || echo 1)" > "$D/ctl/sentinel.json"; exit 0;;
  esac
  case "$4" in *.arm-cancel-next)
    N=$(cat "$D/patrols" 2>/dev/null || echo 1)
    if [ -f "$D/cancelfail" ]; then printf '{"step":"cancel-failed","id":31,"count":%s}' "$N" > "$D/ctl/sentinel.json"; exit 0; fi
    N=$((N-1)); echo $N > "$D/patrols"; printf '{"step":"cancelled-one","count":%s}' "$N" > "$D/ctl/sentinel.json"; exit 0;;
  esac
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
  # mode lostclaim: the bridge CLAIMS (removes) the request but its answer is lost — until a reload happened
  if [ "$MODE" = lostclaim ] && [ ! -f "$D/reloaded" ]; then rm -f "$D/ctl/requests/$REQ"; exit 0; fi
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
  mkdirSync(path.join(dir, "bridge"));
  writeFileSync(path.join(dir, "bridge", "arm-schedule.sh"), `#!/bin/sh\necho "$*" >> "${dir}/schedule.log"\n[ -f "${dir}/schedfail" ] && { echo "failed: x"; exit 1; }\necho 1 > "${dir}/patrols"\necho "scheduled: verified 1 patrol"\n`);
  mkdirSync(path.join(dir, "ctl", "requests"), { recursive: true });
  mkdirSync(path.join(dir, "ctl", "results"), { recursive: true });
  process.env.FAKE_DIR = dir; // inherited by the fake tern via realRun's env
  let n = 0;
  const deps: TernDeps = {
    bin, ctlDir: path.join(dir, "ctl"), bridgeDir: path.join(dir, "bridge"), socket: path.join(dir, "sock"),
    presenceHome: dir, alive: () => true,
    run: realRun(path.join(dir, "sock")),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () => `t${++n}`,
  };
  const argv = () => (existsSync(path.join(dir, "argv.log")) ? readFileSync(path.join(dir, "argv.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  const requests = () => readdirSync(path.join(dir, "ctl", "requests")).filter((f) => f.endsWith(".json"));
  // a STALE mirror (readable, >5s old) is the only ground the call path may reload on (FC-2 gate)
  const staleMirror = () => {
    const af = path.join(dir, "ctl", "agents.json");
    writeFileSync(af, JSON.stringify({ tick: 1, vm: "v-old", agents: [] }));
    utimesSync(af, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  };
  return { dir, deps, argv, requests, staleMirror };
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

// ---- placement model (#1034 r2): split beside the caller's seat (default) / how:"tab" new tab same session / no session ----
t("checkRoleTitle: worker title \"<role> · <task>\" ok", checkRoleTitle("Platform Dev · bridge r8") === null && checkRoleTitle(undefined) === null)
t("checkRoleTitle: sid-like rejected (uuid + 8-hex)", checkRoleTitle("worker 90b58f9c") !== null && checkRoleTitle("x 01a13284-d361-74a0-a026-ad56f1fdf355") !== null)
t("checkRoleTitle: non-English / empty rejected", checkRoleTitle("审查") !== null && checkRoleTitle("  ") !== null)
{
  const s = setup("answer");
  const r = await ternCall("start", { prompt: "p", cwd: "/", title: "Platform Dev · smoke", near: 777 }, 2000, s.deps);
  const wire = readFileSync(path.join(s.dir, "last-request.json"), "utf8");
  t("start default: bridge gets how=\"split\"; title/near never on the wire", wire.includes('"how":"split"') && !wire.includes("title") && !wire.includes("near"))
  t("start default: worker moved right-of the caller's seat pane, then renamed", r.state === "ok" && (r as any).pane === 4242
    && s.argv().includes("move 4242 right-of 777") && s.argv().includes("rename 4242 Platform Dev · smoke") && (r as any).placed === "right-of 777")
  const order = s.argv().filter((x) => x.startsWith("move") || x.startsWith("rename"));
  t("start default: move happens before rename", order[0]?.startsWith("move") === true && order[1]?.startsWith("rename") === true)
}
{
  const s = setup("answer");
  const prev = process.env.TERN_PANE; process.env.TERN_PANE = "888";
  await ternCall("start", { prompt: "p", cwd: "/" }, 2000, s.deps);
  t("start default: with no args.near, the caller's TERN_PANE is the anchor", s.argv().includes("move 4242 right-of 888"))
  if (prev === undefined) delete process.env.TERN_PANE; else process.env.TERN_PANE = prev;
  await ternCall("start", { prompt: "p", cwd: "/", how: "tab" }, 2000, s.deps);
  t("start how=\"tab\": moved to a new tab in the same session", s.argv().includes("move 4242 new-tab"))
  const before = s.argv().length;
  const bs = await ternCall("start", { prompt: "p", cwd: "/", session: "other" }, 2000, s.deps);
  t("start args.session: rejected before any publish (never a silently-new session)", bs.state === "unknown" && /session/.test((bs as any).reason) && s.argv().length === before && s.requests().length === 0)
  const bh = await ternCall("start", { prompt: "p", cwd: "/", how: "replace_if_alone" }, 2000, s.deps);
  t("start: an unsupported how is rejected", bh.state === "unknown" && /how must be/.test((bh as any).reason))
  const bad = await ternCall("start", { prompt: "p", cwd: "/", title: "seat 90b58f9c" }, 2000, s.deps);
  t("start: a sid-like title is rejected BEFORE any publish (zero actions)", bad.state === "unknown" && s.requests().length === 0)
}

// ---- read-only timeout ⇒ ONE recovery then success ----
{
  const s = setup("heal"); s.staleMirror();
  const r = await ternCall("list", {}, 400, s.deps);
  const a = s.argv();
  t("read-only timeout: recovered once, then ok", r.state === "ok" && (r as any).recovered === true)
  t("read-only timeout: chain order = drain, reload, mirror(ready probe), arm, drain", (() => {
    const seq = a.map((x) => (x.startsWith("plugin reload") ? "reload" : x.endsWith(".mirror") ? "mirror" : x.endsWith(".arm-scan") ? "arm" : x.endsWith(".drain") ? "drain" : "?"));
    const i = seq.indexOf("reload");
    return seq[0] === "drain" && i > 0 && seq.indexOf("mirror", i) > i && seq.indexOf("arm", i) > seq.indexOf("mirror", i) && seq.lastIndexOf("drain") > seq.indexOf("arm", i);
  })())
  t("readiness: `tern plugin list` is NEVER used as a probe", !a.some((x) => x.startsWith("plugin list")))
  t("read-only timeout: exactly ONE reload", a.filter((x) => x.startsWith("plugin reload")).length === 1)
  t("read-only timeout: the SAME request was re-triggered (one id minted, no second publish)", (r as any).id === "t1" && s.requests().length === 0)
}
{
  const s = setup("silent"); s.staleMirror();
  const r = await ternCall("list", {}, 300, s.deps);
  t("read-only: still silent after recovery ⇒ timeout (recovered:true), exactly one reload", r.state === "timeout" && (r as any).recovered === true && s.argv().filter((x) => x.startsWith("plugin reload")).length === 1)
}

// ---- #1033 fact ①: ctl's {"ok":true} alone is never an answer — only results/<id>.json counts ----
{
  const s = setup("silent"); s.staleMirror(); // ctl prints {"ok":true} rc0, bridge never writes a result
  const r = await ternCall("list", {}, 300, s.deps);
  t("ctl ok but no result ⇒ NOT ok (timeout after recovery)", r.state !== "ok")
}
// ---- #1033 fact ②: reload but the mirror never moves ⇒ NOT ready (no arm, no re-trigger) ----
{
  const s = setup("deadmirror"); s.staleMirror();
  const r = await ternCall("list", {}, 300, s.deps);
  const a = s.argv();
  t("reload without mirror movement ⇒ unknown 'not ready', no arm", r.state === "unknown" && /not ready/.test((r as any).reason) && !a.some((x) => x.includes(".arm")))
}

// ---- FC-2 gate (coordinator live incident): agents.json unreadable ⇒ UNKNOWN, ZERO reloads ----
{
  const s = setup("silent"); // no agents.json at all (ENOENT) — e.g. a wrong control dir
  const r = await ternCall("list", {}, 300, s.deps);
  t("ENOENT agents.json + read-only timeout ⇒ unknown, ZERO reloads (never reload someone else's bridge)",
    r.state === "unknown" && /NOT reloading/.test((r as any).reason) && !s.argv().some((x) => x.startsWith("plugin reload")))
}
{
  const s = setup("silent");
  writeFileSync(path.join(s.dir, "ctl", "agents.json"), JSON.stringify({ tick: 5, vm: "v1", agents: [] })); // FRESH
  const r = await ternCall("list", {}, 300, s.deps);
  t("FRESH mirror + read-only timeout ⇒ not reloading (drain disabled ≠ bridge stale)", r.state === "unknown" && !s.argv().some((x) => x.startsWith("plugin reload")))
}
{
  const prevHome = process.env.AH_HOME; process.env.AH_HOME = "/tmp/definitely-not-the-bridge-home";
  const { defaultDeps } = await import("./tern-bridge.js");
  const dd = defaultDeps({ ...process.env, AGENTHOP_TERN_PANES: undefined } as any);
  t("ctlDir defaults to the OS home (where window.luau writes), NOT AH_HOME", dd.ctlDir === path.join(os.homedir(), ".agenthop", "tern-panes"))
  if (prevHome === undefined) delete process.env.AH_HOME; else process.env.AH_HOME = prevHome;
}

// ---- non-idempotent timeout ⇒ UNKNOWN/HOLD, never re-sent ----
for (const [op, args] of [["stop", { agent: 1 }], ["start", { prompt: "p", cwd: "/" }], ["eval", { code: "return 1" }]] as const) {
  const s = setup("silent");
  const r = await ternCall(op, args as Record<string, unknown>, 300, s.deps);
  const a = s.argv();
  t(`non-idempotent ${op} timeout: state UNKNOWN + hold:true + id`, r.state === "UNKNOWN" && (r as any).hold === true && typeof r.id === "string")
  t(`non-idempotent ${op} timeout: ONE trigger, NO reload, NO re-trigger`, a.filter((x) => x.includes("plugins run") && !x.includes(".arm")).length === 1 && !a.some((x) => x.startsWith("plugin reload")))
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

// ---- review 4f3afdc: MTB-OP-AUTHORITY — args.op can never replace the validated top-level op ----
for (const smuggled of ["stop", "start"]) {
  const s = setup("answer");
  const r = await ternCall("list", { op: smuggled, agent: 7 }, 500, s.deps);
  t(`list + args.op=${smuggled}: rejected before any publish/trigger`, r.state === "unknown" && /args\.op is reserved/.test((r as any).reason) && s.requests().length === 0 && s.argv().length === 0)
}
{
  const s = setup("answer");
  await ternCall("stop", { agent: 1 }, 2000, s.deps);
  const wire = JSON.parse(readFileSync(path.join(s.dir, "last-request.json"), "utf8"));
  t("published body's op is exactly the top-level op", wire.op === "stop")
}

// ---- MTB-READONLY-REPLAY: a read-only request that was CLAIMED (removed) and lost its answer is re-published, same id ----
{
  const s = setup("lostclaim"); s.staleMirror();
  const r = await ternCall("list", {}, 400, s.deps);
  t("claimed-but-unanswered read-only: recovered by re-publishing the same id ⇒ ok", r.state === "ok" && (r as any).recovered === true && (r as any).republished === true && r.id === "t1")
}
{
  const s = setup("heal"); s.staleMirror();
  const r = await ternCall("list", {}, 400, s.deps);
  t("never-claimed read-only: re-triggered, NOT re-published (no duplicate)", r.state === "ok" && (r as any).republished === undefined)
}
{
  const s = setup("lostclaim");
  const r = await ternCall("stop", { agent: 1 }, 300, s.deps);
  t("claimed-but-unanswered NON-idempotent: still UNKNOWN/hold, never re-published", r.state === "UNKNOWN" && s.requests().length === 0 && !s.argv().some((x) => x.startsWith("plugin reload")))
}

// ---- MTB-ARM-CONTRACT: recovery runs the full r12 arm sequence; any failed step stops before the drain ----
{
  const s = setup("heal"); s.staleMirror(); writeFileSync(path.join(s.dir, "patrols"), "0");
  const r = await ternCall("list", {}, 400, s.deps);
  const a = s.argv();
  t("count==0: arm-schedule.sh runs, then a fresh arm-scan verifies, then drain ⇒ ok", r.state === "ok" && existsSync(path.join(s.dir, "schedule.log"))
    && a.filter((x) => x.endsWith(".arm-scan")).length === 2)
}
{
  const s = setup("heal"); s.staleMirror(); writeFileSync(path.join(s.dir, "patrols"), "3");
  const r = await ternCall("list", {}, 400, s.deps);
  const a = s.argv();
  t("count==3: arm-cancel-next twice, verify scan, NO schedule ⇒ ok", r.state === "ok" && a.filter((x) => x.endsWith(".arm-cancel-next")).length === 2 && !existsSync(path.join(s.dir, "schedule.log")))
}
{
  const s = setup("heal"); s.staleMirror(); writeFileSync(path.join(s.dir, "patrols"), "0"); writeFileSync(path.join(s.dir, "schedfail"), "");
  const r = await ternCall("list", {}, 400, s.deps);
  const a = s.argv();
  const reload = a.findIndex((x) => x.startsWith("plugin reload"));
  t("arm-schedule.sh fails ⇒ unknown naming the step, NO drain after the reload", r.state === "unknown" && /arm-schedule\.sh/.test((r as any).reason) && !a.slice(reload).some((x) => x.endsWith(".drain")))
}
{
  const s = setup("heal"); s.staleMirror(); writeFileSync(path.join(s.dir, "patrols"), "2"); writeFileSync(path.join(s.dir, "cancelfail"), "");
  const r = await ternCall("list", {}, 400, s.deps);
  t("arm-cancel-next fails ⇒ unknown (cancel-failed), no drain", r.state === "unknown" && /cancel-failed/.test((r as any).reason))
}
{
  const s = setup("heal"); s.staleMirror(); writeFileSync(path.join(s.dir, "noscan"), "");
  writeFileSync(path.join(s.dir, "ctl", "sentinel.json"), '{"step":"scanned","count":1}'); // a STALE answer must not count
  const r = await ternCall("list", {}, 400, s.deps);
  t("arm-scan does not answer (stale scanned present) ⇒ unknown 'no fresh scan', no drain", r.state === "unknown" && /no fresh scan/.test((r as any).reason))
}

// ---- MTB-SOURCE-SHAPE: decodable JSON is not a legal mirror / inventory ----
{
  const s = setup("silent");
  const af = path.join(s.dir, "ctl", "agents.json");
  writeFileSync(af, "{}"); utimesSync(af, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const r = await ternCall("list", {}, 300, s.deps);
  t("stale `{}` mirror ⇒ unknown, ZERO reloads (not a legal mirror)", r.state === "unknown" && !s.argv().some((x) => x.startsWith("plugin reload")))
}
{
  const s = setup("answer");
  writeFileSync(path.join(s.dir, "ctl", "agents.json"), "{}");
  const st = await ternStatus(s.deps, undefined);
  t("status with `{}` mirror ⇒ unknown, never healthy", st.state === "unknown")
  writeFileSync(path.join(s.dir, "ctl", "agents.json"), JSON.stringify({ tick: 1, vm: "v", agents: [] }));
  const fake = path.join(s.dir, "tern");
  writeFileSync(fake, readFileSync(fake, "utf8").replace(`echo '{"sessions":[{"tabs":[{"blocks":[{"id":1},{"id":2}]}]}]}'`, "echo '{}'"));
  const st2 = await ternStatus(s.deps, undefined);
  t("status with `tern ls` = {} ⇒ unknown, blocks NOT folded to 0", st2.state === "unknown" && st2.blocks === undefined)
}

// ---- #1053: presence/<sid>.pid for a started ACP seat ----
{
  const SID = "c5beaa7c-acbb-4637-a197-2e9014ae42f8";
  t("resumedSeat: `tern acp claude --resume <sid>` and `--resume=<sid>`", resumedSeat(`/Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${SID} --mode x`)?.sid === SID && resumedSeat(`tern acp codex --resume=${SID}`)?.tool === "codex")
  t("resumedSeat: a fresh `tern acp claude` (no --resume) or a non-acp command has no sid", resumedSeat("tern acp claude --mode x") === null && resumedSeat(`claude --resume ${SID}`) === null && resumedSeat(undefined) === null)
  const s = setup("answer");
  const PS = ` 9100 1 /Applications/Tern.app/Contents/MacOS/tern acp claude --resume ${SID}\n 9101 9100 node /x/Tern/agents/claude/index.js\n 9102 9101 claude --output-format stream-json --resume=${SID}\n`;
  const run0 = s.deps.run;
  const deps = { ...s.deps, run: async (bin: string, a: string[], ms: number) => (bin === "ps" ? { code: 0, stdout: PS, stderr: "", timedOut: false } : run0(bin, a, ms)) };
  const r = await ternCall("start", { prompt: "p", cwd: "/", command: `tern acp claude --resume ${SID}` }, 2000, deps);
  t("ACP start with --resume <sid>: presence/<sid>.pid = the resolved claude pid (not the tern acp pid)", r.state === "ok" && (r as any).presence?.state === "wrote"
    && readFileSync(path.join(s.dir, ".agenthop", "presence", `${SID}.pid`), "utf8") === "9102")
  const r2 = await ternCall("start", { prompt: "p", cwd: "/" }, 2000, deps);
  t("ACP start without a sid: presence pending with the reason, start still ok", r2.state === "ok" && (r2 as any).presence?.state === "pending")
  const r3 = await ternCall("list", {}, 2000, deps);
  t("non-start ops carry no presence field", r3.state === "ok" && (r3 as any).presence === undefined)
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
