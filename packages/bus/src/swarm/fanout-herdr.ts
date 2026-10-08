// Fan-out VISIBLE backend — herdr chain (phase-1 FN4-B). PURE argv builders + parsers + the unit command.
//
// FN4 ruling (user: "use herdr to the extreme"): run each unit as a VISIBLE pane in a temporary workspace by
// composing herdr's OWN CLI — workspace create (the fanout-<runKey> zone) -> pane split -> `pane run` the full
// unit command (the tier-model is written ONTO the command line, so task + model are explicit — this sidesteps
// AS-IS spawn's interactive-only visible path) -> pane wait-output (completion) -> harvest -> workspace close
// (whole-zone reclaim; F42 only-own). herdr is NOT forked and spawn.ts is NOT touched: this uses the herdr CLI
// directly via herdrRun. F41 defense: `pane run` atomically sends the command text + Enter (never the
// char-by-char send-text path that swallows characters).
//
// This file is the PURE layer (selftested). The IO state machine (create -> split -> run -> wait -> read ->
// close, with per-step confirmation + failure reclaim) lives in the fanout driver over herdrRun.
import { shquote } from "../spawn.js";

// ---- argv builders (pure) ----
export function buildWorkspaceCreate(): string[] {
  return ["workspace", "create"];
}
export function buildWorkspaceRename(id: string, name: string): string[] {
  return ["workspace", "rename", id, name];
}
export function buildWorkspaceClose(id: string): string[] {
  return ["workspace", "close", id];
}
export function buildPaneSplitIn(targetPaneId: string, cwd: string): string[] {
  return ["pane", "split", targetPaneId, "--direction", "right", "--cwd", cwd, "--no-focus"];
}
export function buildPaneRun(paneId: string, command: string): string[] {
  return ["pane", "run", paneId, command];
}
export function buildPaneWaitOutput(paneId: string, match: string, timeoutMs: number): string[] {
  return ["pane", "wait-output", paneId, "--match", match, "--timeout", String(timeoutMs)];
}
export function buildPaneRead(paneId: string, lines = 120): string[] {
  return ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)];
}

// ---- receipt parsers (pure; herdr returns JSON) ----
export type WorkspaceCreated = { workspaceId: string; rootPaneId: string; tabId?: string };
export function workspaceFromCreate(json: unknown): WorkspaceCreated | null {
  const r = (json as { result?: { workspace?: { id?: unknown }; root_pane?: { pane_id?: unknown }; tab?: { id?: unknown } } })?.result;
  const workspaceId = r?.workspace?.id;
  const rootPaneId = r?.root_pane?.pane_id;
  if (typeof workspaceId !== "string" || typeof rootPaneId !== "string") return null;
  const tabId = r?.tab?.id;
  return { workspaceId, rootPaneId, ...(typeof tabId === "string" ? { tabId } : {}) };
}
export function paneIdFromSplit(json: unknown): string | null {
  const id = (json as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  return typeof id === "string" ? id : null;
}

// ---- the unit command (tier-model explicit on the command line) ----
// A per-unit completion marker the command echoes last, so `pane wait-output --match <marker>` settles
// deterministically even when the agent's own output is unpredictable.
export function doneMarker(key: string): string {
  return `FANOUT_DONE_${key}`;
}

// Build the one command `pane run` types into the pane: run the tool non-interactively with the tier-model on
// the command line, redirect all output to the unit's harvest file, then echo the completion marker. The prompt
// is shell-quoted (F41: a single atomic command, never char-by-char keystrokes).
export function unitCommand(opts: { bin: string; model: string; prompt: string; outputFile: string; key: string; extraArgs?: readonly string[] }): string {
  const extra = (opts.extraArgs ?? ["--dangerously-skip-permissions"]).join(" ");
  // Capture the REAL exit code to a sidecar `<outputFile>.rc` so the visible path has true exit evidence
  // (round-1 FN8), then echo the completion marker last for `pane wait-output`.
  return `${opts.bin} --model ${shquote(opts.model)} ${extra} -p ${shquote(opts.prompt)} > ${shquote(opts.outputFile)} 2>&1; echo $? > ${shquote(opts.outputFile + ".rc")}; echo ${shquote(doneMarker(opts.key))}`;
}

// The sidecar path where a visible unit's exit code lands.
export function rcFile(outputFile: string): string {
  return outputFile + ".rc";
}
