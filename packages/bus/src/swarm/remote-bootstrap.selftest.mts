import {
  buildBootstrapScript,
  buildCapacityMetadataArgs,
  parseLinkage,
  addLinkage,
  removeLinkage,
  linkageLabels,
  HERDR_INSTALL_URL,
} from "./remote-bootstrap.js";
import { CAPACITY_PROBE_CMD } from "./remote-capacity.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- buildBootstrapScript: has the install, the (shared) probe cmd, and the exec -a claude requirement ---
const script = buildBootstrapScript();
t("bootstrap: shebang + set -eu", script.startsWith("#!/bin/sh\nset -eu"));
t("bootstrap: installs herdr from the canonical url", script.includes(`curl -fsSL ${HERDR_INSTALL_URL} | sh`));
t("bootstrap: reuses CAPACITY_PROBE_CMD (DRY)", script.includes(CAPACITY_PROBE_CMD));
t("bootstrap: documents exec -a claude argv0 requirement", script.includes("exec -a claude"));
t("bootstrap: custom install url honored", buildBootstrapScript({ herdrInstallUrl: "https://x/i.sh" }).includes("curl -fsSL https://x/i.sh | sh"));

// --- buildCapacityMetadataArgs: exact CLI shape ---
t("capacity meta args exact", JSON.stringify(buildCapacityMetadataArgs("w3", 2)) ===
  JSON.stringify(["workspace", "report-metadata", "--source", "remote-herdr-view", "--token", "capacity=2", "w3"]));
t("capacity meta: custom source", buildCapacityMetadataArgs("w3", 1, "probe")[3] === "probe");

// --- linkage algebra (immutable) ---
const e1 = { vmId: "vm-railway-rhv1", backend: "railway", createdSec: 100 };
const base = addLinkage({}, "vm-railway-rhv1", e1);
t("add -> one label", linkageLabels(base).has("vm-railway-rhv1") && linkageLabels(base).size === 1);
const two = addLinkage(base, "vm-gha-x", { vmId: "vm-gha-x", backend: "gha", createdSec: 200 });
t("add second -> base UNCHANGED (immutable)", linkageLabels(base).size === 1 && linkageLabels(two).size === 2);
const less = removeLinkage(two, "vm-gha-x");
t("remove -> new record, two UNCHANGED", linkageLabels(two).size === 2 && linkageLabels(less).size === 1);
t("remove missing label is a no-op copy", linkageLabels(removeLinkage(base, "nope")).size === 1);

// --- parseLinkage: tolerant ---
t("parse round-trip", JSON.stringify(parseLinkage(JSON.stringify(two))) === JSON.stringify(two));
t("parse garbage -> {}", Object.keys(parseLinkage("not json")).length === 0);
t("parse array -> {} (not an object map)", Object.keys(parseLinkage("[1,2]")).length === 0);
t("parse null -> {}", Object.keys(parseLinkage("null")).length === 0);

// --- the ②↔③ seam: linkageLabels feeds remote-recycle sweepRecycled({ ephemeralLabels }) ---
t("seam: labels is a Set ready for ephemeralLabels", linkageLabels(two) instanceof Set && linkageLabels(two).has("vm-railway-rhv1"));

console.log("all remote-bootstrap selftests passed");
