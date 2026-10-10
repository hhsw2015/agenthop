/**
 * flag-default — the ONE shared reader for swarm wiring flags that are LIVE BY DEFAULT (opt-out).
 *
 * User ruling (2026-10-10, "不要开机脚本,把全局变量设成默认的"): the swarm wiring flags were opt-in (default OFF, needed
 * `=1` to turn on), so every shell restart that didn't re-export them came up with the features OFF — the dormant protection
 * period is over and the flags should be ON by default. Rather than a boot script that re-exports them (fragile, host-specific),
 * the DEFAULT itself flips: a flag is ON unless it is explicitly turned OFF. One env no longer set ⇒ the feature is live, which
 * is what a restart should preserve.
 *
 * Semantics (opt-out): unset / empty / any non-negation value ⇒ ON (true); an EXPLICIT negation — `0`, `false`, `no`, `off`
 * (case-insensitive, surrounding whitespace ignored) ⇒ OFF (false). The kill-switch is therefore `SWARM_<X>=0` (or false/no/off).
 *
 * This is the inverse of the opt-in reader `/^(1|true|yes|on)$/` that these flags used while dormant. SWARM_TG_ENTRY is the ONE
 * flag that KEEPS opt-in semantics (it needs a user-seeded bridge token; default-ON would spin an errored bridge), so it does
 * NOT use this helper — see scripts/swarm-tg-entry.ts.
 *
 * Pure.
 */
export function flagDefaultOn(envVal: string | undefined): boolean {
  return !/^(0|false|no|off)$/i.test((envVal ?? "").trim()); // unset/empty/non-negation ⇒ ON; explicit 0|false|no|off ⇒ OFF
}
