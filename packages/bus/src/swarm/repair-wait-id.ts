/**
 * Repair-wait identity (cluster-liveness L1-tail). Shared by the incident layer (which CREATES repair-waits) and the cut
 * assembler (which EXCLUDES them from the business liveness verdict). Two review invariants live here, together, at one source:
 *  - review P1-1: a repair obligation must NOT self-certify recovery. The cut assembler excludes repair-waits from the §1
 *    responsibility map, so an open repair-wait can never be the W that makes INV-1 OK for the very stall it tracks. The
 *    marker is the id PREFIX — detection is RESTART-SAFE (derivable from the waitId alone, no side registry to rebuild).
 *  - review P2-3: the jobId segment is encodeURIComponent-encoded — INJECTIVE, so distinct jobIds ("job:a" vs "job-a") never
 *    collapse to the same repair-wait id (the old lossy '-'-substitution did, letting one incident's wait overwrite another).
 */
export const REPAIR_WAIT_PREFIX = "repair-";
export const makeRepairWaitId = (jobId: string, episode: number): string => `${REPAIR_WAIT_PREFIX}${encodeURIComponent(jobId)}-ep${episode}`;
export const isRepairWaitId = (waitId: string): boolean => waitId.startsWith(REPAIR_WAIT_PREFIX);
