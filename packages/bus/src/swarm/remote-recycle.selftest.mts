import {
  recycleVerdict,
  shouldRemove,
  parseMachineList,
  parseVmSshIds,
  parseReachable,
  workspaceIdForLabel,
} from "./remote-recycle.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- verdict: full truth table over machineReachable {true,false,null} × vmListed {true,false,null} ---
t("reachable=true,listed=true   -> live", recycleVerdict({ machineReachable: true, vmListed: true }) === "live");
t("reachable=true,listed=false  -> live (never remove a reachable box)", recycleVerdict({ machineReachable: true, vmListed: false }) === "live");
t("reachable=true,listed=null   -> live", recycleVerdict({ machineReachable: true, vmListed: null }) === "live");
t("reachable=false,listed=true  -> transient (net blip)", recycleVerdict({ machineReachable: false, vmListed: true }) === "transient");
t("reachable=false,listed=false -> recycled (two faces agree)", recycleVerdict({ machineReachable: false, vmListed: false }) === "recycled");
t("reachable=false,listed=null  -> unknown (one face only)", recycleVerdict({ machineReachable: false, vmListed: null }) === "unknown");
t("reachable=null,listed=false  -> unknown (can't tell if down)", recycleVerdict({ machineReachable: null, vmListed: false }) === "unknown");
t("reachable=null,listed=true   -> unknown", recycleVerdict({ machineReachable: null, vmListed: true }) === "unknown");
t("reachable=null,listed=null   -> unknown", recycleVerdict({ machineReachable: null, vmListed: null }) === "unknown");

// --- shouldRemove: recycled is the ONLY trigger ---
t("shouldRemove recycled", shouldRemove("recycled") === true);
t("shouldRemove live/transient/unknown all false", !shouldRemove("live") && !shouldRemove("transient") && !shouldRemove("unknown"));

// --- parseMachineList: real evidence row + tolerance ---
const mlRow = "5e1f7856be9dfc9cdb7288dce953189b\tvm-railway-rhv1\tvm-railway-rhv1\tdefault\tenabled";
const ml = parseMachineList(mlRow);
t("machine list: one row", ml.length === 1);
t("machine list: id", ml[0].id === "5e1f7856be9dfc9cdb7288dce953189b");
t("machine list: label", ml[0].label === "vm-railway-rhv1");
t("machine list: enabled", ml[0].enabled === true);
t("machine list: disabled flag", parseMachineList("id\tlbl\thost\tgrp\tdisabled")[0].enabled === false);
t("machine list: blank+short rows skipped", parseMachineList("\n\nonly\ttwo\n" + mlRow + "\n").length === 1);
t("machine list: empty -> []", parseMachineList("").length === 0);

// --- parseVmSshIds: vm-ssh ls --json ---
const lsJson = JSON.stringify([{ id: "vm-railway-rhv1", backend: "railway" }, { id: "vm-gha-x", backend: "gha" }]);
const ids = parseVmSshIds(lsJson)!;
t("vm-ssh ids: set of two", ids.size === 2 && ids.has("vm-railway-rhv1") && ids.has("vm-gha-x"));
t("vm-ssh ids: empty array -> empty set", parseVmSshIds("[]")!.size === 0);
t("vm-ssh ids: garbage -> null (unavailable)", parseVmSshIds("not json") === null);
t("vm-ssh ids: non-array -> null", parseVmSshIds('{"id":"x"}') === null);

// --- parseReachable: tri-state, with the unreachable⊃reachable trap ---
t("reachable: 'unreachable' -> false (NOT true)", parseReachable("machine is unreachable") === false);
t("reachable: timed out -> false", parseReachable("ssh: connect timed out") === false);
t("reachable: 'Remote server is ready' -> true", parseReachable("Remote server is ready.") === true);
t("reachable: 'reachable' -> true", parseReachable("status: reachable") === true);
t("reachable: unknown machine -> null (not saved)", parseReachable("unknown machine 'x'; use `herdr machine list`") === null);
t("reachable: empty -> null", parseReachable("") === null);
t("reachable: noise -> null", parseReachable("some unrelated line") === null);

// --- workspaceIdForLabel ---
const wl = JSON.stringify({ result: { type: "workspace_list", workspaces: [
  { workspace_id: "w1", label: "agenthop" },
  { workspace_id: "w3", label: "vm-railway-rhv1" },
] } });
t("workspace: match label -> id", workspaceIdForLabel(wl, "vm-railway-rhv1") === "w3");
t("workspace: no match -> null", workspaceIdForLabel(wl, "nope") === null);
t("workspace: garbage -> null", workspaceIdForLabel("x", "a") === null);

console.log("all remote-recycle selftests passed");
