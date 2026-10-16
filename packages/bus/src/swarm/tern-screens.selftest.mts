/**
 * tern-screens selftest (#1115 T1, [liveness]): merging the per-VM screens/<vm>.json files. UNKNOWN for every unreadable,
 * malformed, missing, stale or future-dated observation; never idle by default; the newer of two VMs wins.
 * Run: node_modules/.bin/tsx packages/bus/src/swarm/tern-screens.selftest.mts
 */
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeScreens, readScreens, screenOf } from "./tern-screens.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };
const P = "12382390714370";
const file = (vm: string, screens: Record<string, unknown>) => JSON.stringify({ vm, screens });
const NOW = 1_000_000;

{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "working", rule: "r", agent: "claude", observed_at: NOW - 3, try: "ok" } }) }], NOW, 60);
  const e = screenOf(m, Number(P));
  t("fresh observation ⇒ its state (working), with agent and rule", e.state === "working" && e.agent === "claude" && e.rule === "r" && e.vm === "A");
  t("a pane no VM reports ⇒ unknown (never idle)", screenOf(m, 42).state === "unknown");
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW - 61 } }) }], NOW, 60);
  t("observation older than maxAge ⇒ unknown (stale), observedAt kept for diagnostics", screenOf(m, P).state === "unknown" && screenOf(m, P).observedAt === NOW - 61);
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW + 3600 } }) }], NOW, 60);
  t("observation an hour in the future (clock stepped back) ⇒ unknown", screenOf(m, P).state === "unknown" && /future/.test(screenOf(m, P).why ?? ""));
}
{
  const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: { try: "unreadable", tried_at: NOW } }) }], NOW, 60);
  t("an entry with only a failed attempt (no observation) ⇒ unknown", screenOf(m, P).state === "unknown");
}
{
  for (const bad of [{ state: "sleeping", observed_at: NOW }, { state: 3, observed_at: NOW }, { state: "idle", observed_at: "x" }, null]) {
    const m = mergeScreens([{ name: "a.json", body: file("A", { [P]: bad }) }], NOW, 60);
    t(`malformed entry ${JSON.stringify(bad)} ⇒ unknown`, screenOf(m, P).state === "unknown");
  }
  for (const body of [null, "{not json", "[]", JSON.stringify({ vm: "A", screens: [] }), JSON.stringify({ vm: "A" })]) {
    const m = mergeScreens([{ name: "a.json", body }], NOW, 60);
    t(`unreadable / malformed file ${JSON.stringify(body)?.slice(0, 30)} ⇒ its panes unknown`, screenOf(m, P).state === "unknown");
  }
}
{
  const m = mergeScreens([
    { name: "a.json", body: file("A", { [P]: { state: "idle", observed_at: NOW - 20 } }) },
    { name: "b.json", body: file("B", { [P]: { state: "blocked", observed_at: NOW - 2 } }) },
  ], NOW, 60);
  t("two VMs report one pane ⇒ the newer observation wins", screenOf(m, P).state === "blocked" && screenOf(m, P).vm === "B");
}
{
  const d = mkdtempSync(path.join(os.tmpdir(), "screens-")); mkdirSync(path.join(d, "screens"));
  t("no screens dir ⇒ every pane unknown", screenOf(readScreens(path.join(d, "nope"), NOW, 60), P).state === "unknown");
  writeFileSync(path.join(d, "screens", "A.json"), file("A", { [P]: { state: "idle", observed_at: NOW - 1 } }));
  t("real file read ⇒ idle", screenOf(readScreens(d, NOW, 60), P).state === "idle");
  chmodSync(path.join(d, "screens", "A.json"), 0o000);
  t("unreadable file (chmod 000) ⇒ unknown", screenOf(readScreens(d, NOW, 60), P).state === "unknown");
  chmodSync(path.join(d, "screens", "A.json"), 0o600);
}
console.log("all tern-screens selftests passed");
