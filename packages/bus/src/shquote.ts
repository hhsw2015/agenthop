/** Shell-quoting pure leaf (D6-1). A zero-dependency pure function, split out of the IO-heavy `spawn.ts` so pure command-builders
 *  (fanout-herdr, railway) can quote shell words WITHOUT value-importing an IO module — removing the `pure-imports-io` edge the
 *  batch-6 architecture review flagged. Behavior is unchanged; `spawn.ts` re-uses this same function. */

/** POSIX single-quote a shell word so metacharacters cannot be re-interpreted. Pure. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
