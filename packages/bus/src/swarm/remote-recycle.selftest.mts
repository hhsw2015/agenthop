import {
  recycleVerdict,
  shouldRemove,
  parseMachineList,
  parseVmSshIds,
  parseReachable,
  reachabilityFromStatus,
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

// --- RH1 regression: parseReachable only EXPLICIT unreachable -> false; else null (never on error/failed substrings) ---
t("RH1: 'permission denied' (local read fail) -> null, NOT false", parseReachable("error: permission denied reading config") === null);
t("RH1: generic 'failure' -> null", parseReachable("local config read failure") === null);
t("RH1: reachable JSON with last_error:null -> true (not false)", parseReachable('{"reachable":true,"last_error":null}') === true);
t("RH1: structured reachable:false -> false", parseReachable('{"reachable":false}') === false);
t("RH1: contradictory (unreachable + reachable) -> null", parseReachable("was unreachable, now reachable") === null);
t("RH1: bare 'error' token does NOT force false", parseReachable("status report: no error") === null);

// --- RH1 round-2: a LOCAL command failure (exit!=0) is NOT remote-unreachable evidence -> null ---
t("RH1b: exit-failed + 'connection refused' -> null (local socket, not remote)", reachabilityFromStatus("error: connection refused (herdr socket)", true) === null);
t("RH1b: exit-failed + 'timed out' -> null (local IPC)", reachabilityFromStatus("local IPC timed out", true) === null);
t("RH1b: exit-ok + structured reachable:false -> false", reachabilityFromStatus('{"reachable":false}', false) === false);
t("RH1b: exit-ok + explicit unreachable text -> false", reachabilityFromStatus("machine is unreachable", false) === false);
t("RH1b: exit-ok + reachable -> true", reachabilityFromStatus('{"reachable":true}', false) === true);

// --- RH2 regression: a partial/malformed vm-ssh list -> null (never a partial 'absent' set) ---
t("RH2: [null,{}] -> null (not empty set)", parseVmSshIds("[null,{}]") === null);
t("RH2: valid+missing-id rows -> null (not partial set)", parseVmSshIds('[{"id":"a"},{"backend":"x"}]') === null);
t("RH2: all-valid -> trusted set", (() => { const s = parseVmSshIds('[{"id":"a"},{"id":"b"}]'); return !!s && s.size === 2 && s.has("a"); })());
t("RH2: legit empty [] -> empty set (trusted)", (() => { const s = parseVmSshIds("[]"); return !!s && s.size === 0; })());

// --- RH5 regression: invalid collection / ambiguous match -> null (no close, no throw) ---
t("RH5: workspaces:{} -> null (no throw)", workspaceIdForLabel(JSON.stringify({ result: { workspaces: {} } }), "a") === null);
t("RH5: two same-label -> null (ambiguous)", workspaceIdForLabel(JSON.stringify({ result: { workspaces: [
  { workspace_id: "w3", label: "dup" }, { workspace_id: "w4", label: "dup" } ] } }), "dup") === null);
t("RH5: unique match still returns", workspaceIdForLabel(JSON.stringify({ result: { workspaces: [ { workspace_id: "w3", label: "dup" } ] } }), "dup") === "w3");
// RH5 round-2: a same-label record missing its id makes the label AMBIGUOUS -> null (don't close the complete one)
t("RH5b: complete + same-label-missing-id -> null (ambiguous)", workspaceIdForLabel(JSON.stringify({ result: { workspaces: [
  { workspace_id: "w-local-business", label: "dup" }, { label: "dup" } ] } }), "dup") === null);
t("RH5b: unique complete still returns (control)", workspaceIdForLabel(JSON.stringify({ result: { workspaces: [
  { workspace_id: "w3", label: "dup" }, { workspace_id: "w4", label: "other" } ] } }), "dup") === "w3");

console.log("all remote-recycle selftests passed");
