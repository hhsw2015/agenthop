/**
 * remote-bootstrap — ③ boot template for a remote herdr VM + the ephemeral-machine linkage ② consumes
 * (S14 remote-herdr-view).
 *
 * Flow: `vm-ssh up --init <buildBootstrapScript()>` provisions a VM that installs herdr + probes its capacity; the
 * local side then `machine add`s it, writes the capacity into the workspace metadata, and records a LINKAGE
 * (machine label ↔ vm-ssh id). The linkage is the durable producer for the recycle sweep's `ephemeralLabels`
 * (remote-recycle.ts ②): it is how the sweep knows which saved machines are throwaway VMs (vs a permanent SSH box) —
 * without it, a recycled VM is indistinguishable from a down permanent box, so ② stays inert until a label is linked.
 *
 * Pure builders + linkage algebra above the line (selftested). IO (herdr/vm-ssh calls, linkage file) below — exercised
 * by live runs. Full live acceptance (real provision → metadata → recycle) rides a future authorized VM; no-spend now.
 */

import { CAPACITY_PROBE_CMD } from "./remote-capacity.js";

// ============================================================================================================
// Pure layer — builders + linkage algebra (selftested in remote-bootstrap.selftest.mts)
// ============================================================================================================

export const BOOTSTRAP_SOURCE = "remote-herdr-view";
export const HERDR_INSTALL_URL = "https://herdr.dev/install.sh";

/**
 * The one-shot remote bootstrap, passed as `vm-ssh up --init <this>`. Installs herdr (must match the LOCAL version or
 * `machine add` refuses) and prints the capacity probe to stdout (the local flow feeds it to capacityFromProbe). Pure.
 */
export function buildBootstrapScript(opts: { herdrInstallUrl?: string } = {}): string {
  const url = opts.herdrInstallUrl ?? HERDR_INSTALL_URL;
  return [
    "#!/bin/sh",
    "set -eu",
    "# remote-herdr-view ③ boot template — runs on the fresh VM via `vm-ssh up --init`.",
    "# 1. herdr (must match the local version, else local `machine add` refuses).",
    "#    Download THEN run (never pipe curl into a shell): in a pipe the shell sees the installer's exit, not curl's,",
    "#    so a failed/empty download is swallowed and the box comes up herdr-less but exit 0 (RH6). `set -e`+`&&` stop it.",
    'herdr_installer="$(mktemp)"',
    `curl -fsSL ${url} -o "$herdr_installer" && sh "$herdr_installer"`,
    "# 2. capacity probe → stdout; the local add-flow reads it and computes agentCapacity (remote-capacity.ts).",
    CAPACITY_PROBE_CMD,
    "# 3. NOTE: every agent launcher on this box MUST `exec -a claude <real-binary>` so herdr identifies the agent by",
    "#    argv0 basename (herdr-args-fix F③: identify_agent). codex needs no shim (its binary is already named codex).",
    "",
  ].join("\n");
}

/** Build `herdr workspace report-metadata` args that write the computed capacity as a display-only token. Pure.
 *  (CLI shape verified vs live herdr 0.9.3: `report-metadata --source <ID> --token NAME=VALUE <WORKSPACE_ID>`.) */
export function buildCapacityMetadataArgs(workspaceId: string, capacity: number, source = BOOTSTRAP_SOURCE): string[] {
  return ["workspace", "report-metadata", "--source", source, "--token", `capacity=${capacity}`, workspaceId];
}

/** A linked ephemeral machine: the herdr machine label (key) → the vm-ssh VM behind it. */
export interface LinkageEntry {
  vmId: string;
  backend: string;
  createdSec: number;
}
export type Linkage = Record<string, LinkageEntry>; // keyed by herdr machine label

/** A value is a valid LinkageEntry only with a non-empty string vmId + string backend + finite createdSec. Pure. */
export function isLinkageEntry(v: unknown): v is LinkageEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.vmId === "string" && e.vmId.length > 0 && typeof e.backend === "string" && typeof e.createdSec === "number" && Number.isFinite(e.createdSec);
}

/**
 * Parse the linkage ledger. The ledger's keys become `ephemeralLabels` — the set of machines the recycle sweep (②) is
 * ALLOWED to remove — so a key with an invalid body must NOT grant that authority: e.g. `{"permanent-main":null}` must
 * not make `permanent-main` sweepable (RH4). Each entry is validated; invalid entries are DROPPED (a valid entry
 * alongside them is still usable). Non-object root / parse error ⇒ empty (nothing linked). Pure.
 */
export function parseLinkage(json: string): Linkage {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Linkage = {};
  for (const [label, entry] of Object.entries(v as Record<string, unknown>)) {
    if (isLinkageEntry(entry)) out[label] = entry; // invalid entry ⇒ no cleanup authority
  }
  return out;
}

/** Add/replace a label's linkage, returning a NEW record (coding-style: never mutate). Pure. */
export function addLinkage(rec: Linkage, label: string, entry: LinkageEntry): Linkage {
  return { ...rec, [label]: entry };
}

/** Remove a label, returning a NEW record. Pure. */
export function removeLinkage(rec: Linkage, label: string): Linkage {
  const { [label]: _drop, ...rest } = rec;
  return rest;
}

/** The set of linked labels = the `ephemeralLabels` the recycle sweep (②) acts within. Pure. */
export function linkageLabels(rec: Linkage): Set<string> {
  return new Set(Object.keys(rec));
}

// ============================================================================================================
// IO shell — thin wrappers + linkage file (exercised by live/integration runs, NOT the selftest)
// ============================================================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
const px = promisify(execFile);

export const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";

/** Linkage ledger path under the data root (SWARM_DATA_ROOT seam deferred — see CORE 解耦审计表). */
export function linkagePath(home: string = homedir()): string {
  return join(home, ".agenthop", "swarm", "remote-herdr", "ephemeral.json");
}

export async function readLinkage(p: string = linkagePath()): Promise<Linkage> {
  try {
    return parseLinkage(await readFile(p, "utf8"));
  } catch {
    return {}; // missing ledger = nothing linked
  }
}

/** Persist the linkage atomically (temp + rename), creating the dir. */
export async function writeLinkage(rec: Linkage, p: string = linkagePath()): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(rec, null, 2));
  await rename(tmp, p);
}

/** Write the computed capacity into the workspace metadata. Never throws on a normal CLI failure. */
export async function writeCapacityMetadata(
  workspaceId: string,
  capacity: number,
  source = BOOTSTRAP_SOURCE,
): Promise<{ ok: boolean; note: string }> {
  try {
    await px(HERDR_BIN, buildCapacityMetadataArgs(workspaceId, capacity, source), { timeout: 10000 });
    return { ok: true, note: `capacity=${capacity} -> ${workspaceId}` };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, note: `report-metadata failed: ${(err.stderr || err.stdout || "").slice(0, 160)}` };
  }
}
