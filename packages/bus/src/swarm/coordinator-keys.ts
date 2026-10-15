// Inbox-sentinel ownership for the COORDINATOR (#1032-C). Why the coordinator is special:
//
// The sentinel credits a live session with its legacy boxes (core's legacyInboxKeys) ONLY when whois() resolves the sid to a
// SINGLE identity entity — because legacyInboxKeys needs the session's real tool+cwd, and for an ambiguous identity the
// alias-log cannot supply them (guessing would over-credit and SUPPRESS a real stall). The long-lived coordinator is exactly
// the session most likely to be ambiguous: it has been resumed under many runs (whois(c5beaa7c) = 44 candidate entities), so
// the sentinel never credited its legacy boxes and reported a false STALL on its previous-native box after a rename, even
// though the coordinator's own core drains that box.
//
// For the coordinator ONLY, the dispatcher has independent, non-alias-log facts: SWARM_COORDINATOR resolves to its sid, and
// its live presence pid gives the real tool (the process name) and cwd (the process's working directory). With those, the
// sentinel can compute exactly the key set the coordinator's core drains — no guessing. Ordinary members keep the existing
// conservative rule (no single entity ⇒ only the direct sid is credited).

import { legacyInboxKeys, type Projection } from "../bus-identity.js";

/** The tool name a live process runs, from its executable basename (`claude`, `codex`). The input is the process NAME (/proc comm or
 *  `ps -o comm=`), not a command line, so the WHOLE basename is compared — never split on whitespace (IWT-COORD-TOOL: an executable
 *  named `claude helper` is not `claude`). Anything else ⇒ null (unknown ⇒ no expansion, only the direct sid is credited). Pure. */
export function toolFromCommand(comm: string): string | null {
  const base = (comm.trim().split("/").pop() ?? "").toLowerCase();
  return base === "claude" || base === "codex" ? base : null;
}

/** The coordinator's legacy box keys from dispatcher-known facts (its sid + its live process's real tool/cwd). Both facts must be
 *  present; a missing one ⇒ [] (fall back to crediting only the direct sid). Pure. */
export function coordinatorLegacyKeys(proj: Projection, sid: string, facts: { tool: string | null; cwd: string | null }): string[] {
  if (!sid || !facts.tool || !facts.cwd) return [];
  return legacyInboxKeys(proj, { id: sid, stableId: sid, title: "", tool: facts.tool, cwd: facts.cwd, pid: 0 });
}
