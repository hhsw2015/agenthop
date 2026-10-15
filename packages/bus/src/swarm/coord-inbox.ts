// The ONE correct way for a hand-written script (a seat's cc / report / review-delivery helper) to address the coordinator's durable
// inbox (#1032 B). Product senders already resolve SWARM_COORDINATOR via resolveSession; ad-hoc scripts did not — they hard-coded a
// sid, so after the coordinator's session id changed (fe0376cd… → c5beaa7c…) their mail kept landing in the old box. This helper
// resolves the CURRENT coordinator from SWARM_COORDINATOR and refuses to guess: unset, unresolvable, or unsafe ⇒ a clear error.

import { resolveSession, listSessions } from "./task-liveness.js";
import { isValidSessionId } from "../send-fallback.js";

export class CoordinatorInboxError extends Error {}

/** The coordinator's durable-inbox key (its session id), resolved from SWARM_COORDINATOR against the live presence sessions. Throws
 *  CoordinatorInboxError when SWARM_COORDINATOR is unset/blank, does not resolve to exactly one session, or resolves to an unsafe
 *  id. `sessions` is injectable for tests. */
export function resolveCoordinatorInbox(home: string, env: NodeJS.ProcessEnv = process.env, sessions: string[] = listSessions(home)): string {
  const ref = (env.SWARM_COORDINATOR ?? "").trim();
  if (!ref) throw new CoordinatorInboxError("SWARM_COORDINATOR is not set — cannot address the coordinator (never hard-code its session id)");
  const sid = resolveSession(ref, sessions);
  if (!sid) throw new CoordinatorInboxError(`SWARM_COORDINATOR=${ref} does not resolve to exactly one live session (no presence match, or ambiguous)`);
  if (!isValidSessionId(sid)) throw new CoordinatorInboxError(`SWARM_COORDINATOR resolved to an unsafe session id: ${sid}`);
  return sid;
}
