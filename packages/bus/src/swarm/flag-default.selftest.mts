// Run: packages/bus/node_modules/.bin/tsx packages/bus/src/swarm/flag-default.selftest.mts
// Covers the 2026-10-10 "flags default ON" ruling: the shared flagDefaultOn helper truth table + each of the five flipped
// flags' enabled() (default ⇒ ON, explicit 0|false|no|off ⇒ OFF). SWARM_TG_ENTRY is the exception (opt-in, unchanged) and is
// NOT asserted here — its reader is a script-local const in scripts/swarm-tg-entry.ts (default OFF by design).
import { flagDefaultOn } from "./flag-default.js";
import { boardAdmitEnabled } from "./task-board.js";
import { autoscaleEnabled } from "./review-seat-autoscale.js";
import { successionEnabled } from "./shell-succession.js";
import { coordEscalateEnabled } from "./coordinator-report.js";
import { gaugeSamplingEnabled } from "./dual-bandwidth-store.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- flagDefaultOn truth table: unset/empty/non-negation ⇒ true; explicit negation (trimmed, case-insensitive) ⇒ false ---
t("flagDefaultOn(undefined) -> true (unset ⇒ ON)", flagDefaultOn(undefined) === true);
t("flagDefaultOn('') -> true (empty ⇒ ON)", flagDefaultOn("") === true);
t("flagDefaultOn('   ') -> true (whitespace ⇒ ON)", flagDefaultOn("   ") === true);
t("flagDefaultOn('0') -> false", flagDefaultOn("0") === false);
t("flagDefaultOn('false') -> false", flagDefaultOn("false") === false);
t("flagDefaultOn('FALSE') -> false (case-insensitive)", flagDefaultOn("FALSE") === false);
t("flagDefaultOn('no') -> false", flagDefaultOn("no") === false);
t("flagDefaultOn('off') -> false", flagDefaultOn("off") === false);
t("flagDefaultOn('  off  ') -> false (trimmed)", flagDefaultOn("  off  ") === false);
t("flagDefaultOn('Off') -> false (case)", flagDefaultOn("Off") === false);
t("flagDefaultOn('1') -> true", flagDefaultOn("1") === true);
t("flagDefaultOn('yes') -> true", flagDefaultOn("yes") === true);
t("flagDefaultOn('on') -> true", flagDefaultOn("on") === true);
t("flagDefaultOn('true') -> true", flagDefaultOn("true") === true);
t("flagDefaultOn('garbage') -> true (non-negation ⇒ ON)", flagDefaultOn("garbage") === true);
// near-miss negations must NOT disable (exact-word match only)
t("flagDefaultOn('0x') -> true (not exactly '0')", flagDefaultOn("0x") === true);
t("flagDefaultOn('offen') -> true (not exactly 'off')", flagDefaultOn("offen") === true);
t("flagDefaultOn('false positive') -> true (not exactly 'false')", flagDefaultOn("false positive") === true);

// --- each flipped flag: default (unset) ⇒ ON; explicit kill ⇒ OFF; explicit truthy ⇒ ON ---
const flags: Array<[string, (env: NodeJS.ProcessEnv) => boolean, string]> = [
  ["BOARD_ADMIT", boardAdmitEnabled, "SWARM_BOARD_ADMIT"],
  ["REVIEW_AUTOSCALE", autoscaleEnabled, "SWARM_REVIEW_AUTOSCALE"],
  ["SUCCESSION", successionEnabled, "SWARM_SUCCESSION"],
  ["COORD_ESCALATE", coordEscalateEnabled, "SWARM_COORD_ESCALATE"],
  ["GAUGE_SAMPLING", gaugeSamplingEnabled, "SWARM_GAUGE_SAMPLING"],
];
for (const [label, fn, env] of flags) {
  t(`${label}: unset -> ON (default-on)`, fn({}) === true);
  t(`${label}: ${env}=0 -> OFF (kill-switch)`, fn({ [env]: "0" }) === false);
  t(`${label}: ${env}=false -> OFF`, fn({ [env]: "false" }) === false);
  t(`${label}: ${env}=off -> OFF`, fn({ [env]: "off" }) === false);
  t(`${label}: ${env}=1 -> ON (explicit)`, fn({ [env]: "1" }) === true);
  t(`${label}: ${env}=garbage -> ON (non-negation)`, fn({ [env]: "garbage" }) === true);
}

console.log("all flag-default selftests passed");
