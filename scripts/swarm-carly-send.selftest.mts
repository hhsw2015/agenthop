/**
 * swarm-carly-send selftest (tsx-run). Covers deliverable ② incl. the named acceptance e2e (one message, through durable, into the
 * target's box):
 *  - pure: classifyArgs (role + verbatim text / usage / flag reject), roleEnvVar (SWARM_<ROLE>), resolveRoleHandle.
 *  - e2e: with a planted coordinator presence + SWARM_COORDINATOR, run() delivers ONE message to ~/.agenthop/inbox/<sid>/ with the
 *    FORCED envelope {from:carly, via:carly, intent:report} and the VERBATIM text.
 *  - FC-2 fallback: an unresolvable role ⇒ the message is durably queued to ~/.agenthop/carly/outbox/ (never dropped), exit 0.
 *  - usage error ⇒ exit 2.
 *
 * Run: node_modules/.bin/tsx scripts/swarm-carly-send.selftest.mts  (from repo root)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyArgs, roleEnvVar, resolveRoleHandle, run } from "./swarm-carly-send.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const tmpHome = () => mkdtempSync(path.join(os.tmpdir(), "carlysend-"));
const readJsonDir = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));

// ---- pure ----
{
  const s = classifyArgs(["coordinator", "hello", "world"]);
  t("classifyArgs: role + joined verbatim text", s.kind === "send" && s.role === "coordinator" && s.text === "hello world");
  t("classifyArgs: no args ⇒ usage (no error)", classifyArgs([]).kind === "usage" && (classifyArgs([]) as any).error === undefined);
  t("classifyArgs: role only (no text) ⇒ usage error", (classifyArgs(["coordinator"]) as any).error === "empty message text");
  t("classifyArgs: leading flag ⇒ usage error", (classifyArgs(["--oops", "x"]) as any).error?.includes("unexpected flag"));
  t("roleEnvVar: coordinator ⇒ SWARM_COORDINATOR", roleEnvVar("coordinator") === "SWARM_COORDINATOR");
  t("roleEnvVar: dialog-officer ⇒ SWARM_DIALOG_OFFICER", roleEnvVar("dialog-officer") === "SWARM_DIALOG_OFFICER");
  t("roleEnvVar: sanitizes to SWARM_* only (no traversal)", roleEnvVar("../etc") === "SWARM_ETC");
  t("resolveRoleHandle: reads SWARM_<ROLE>", resolveRoleHandle("coordinator", { SWARM_COORDINATOR: "c-1" } as any) === "c-1");
  t("resolveRoleHandle: blank/unset ⇒ null", resolveRoleHandle("coordinator", {} as any) === null && resolveRoleHandle("coordinator", { SWARM_COORDINATOR: "  " } as any) === null);
}

// ---- e2e: real durable delivery to a planted coordinator box ----
{
  const home = tmpHome();
  const coordSid = "coord-test-0001"; // valid session id ([A-Za-z0-9_-]+)
  mkdirSync(path.join(home, ".agenthop", "presence"), { recursive: true });
  writeFileSync(path.join(home, ".agenthop", "presence", `${coordSid}.pid`), String(process.pid)); // makes listSessions see it
  const env = { AH_HOME: home, SWARM_COORDINATOR: coordSid } as unknown as NodeJS.ProcessEnv; // SWARM_INBOX_WAKE unset ⇒ durable-only
  const code = run(["coordinator", "user says: continue project X"], env);
  t("e2e: exit 0", code === 0);
  const box = path.join(home, ".agenthop", "inbox", coordSid);
  const msgs = readJsonDir(box);
  t("e2e: exactly one message landed in the coordinator's durable box", msgs.length === 1);
  const m = msgs[0];
  t("e2e: forced envelope {from:carly, via:carly, intent:report}", m.from === "carly" && m.via === "carly" && m.intent === "report");
  t("e2e: verbatim text delivered", m.text === "user says: continue project X");
}

// ---- FC-2 fallback: unresolvable role ⇒ durable outbox, never dropped ----
{
  const home = tmpHome();
  const env = { AH_HOME: home } as unknown as NodeJS.ProcessEnv; // no SWARM_COORDINATOR ⇒ unresolvable
  const code = run(["coordinator", "nobody home"], env);
  t("fallback: exit 0 (durably queued is success)", code === 0);
  const outbox = path.join(home, ".agenthop", "carly", "outbox");
  const queued = readJsonDir(outbox);
  t("fallback: one message queued to carly outbox", queued.length === 1 && queued[0].to === "coordinator");
  t("fallback: queued envelope is from carly, verbatim", queued[0].msg.from === "carly" && queued[0].msg.via === "carly" && queued[0].msg.text === "nobody home");
}

// ---- usage exit code ----
{
  t("usage error ⇒ exit 2", run(["coordinator"], { AH_HOME: tmpHome() } as any) === 2);
  t("--help ⇒ exit 0", run(["--help"], { AH_HOME: tmpHome() } as any) === 0);
}

console.log("all swarm-carly-send selftests passed");
