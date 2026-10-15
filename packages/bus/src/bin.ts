// The released program's entry. `agenthop hook subagent` (#1057) fires on every sub-agent start/stop and permission request
// of a TUI seat, so it must not pay for the full CLI's eager module graph (~100ms): it loads only hook-entry.js. Every other
// command loads cli-main.js, unchanged.
const a = process.argv.slice(2);
if (a[0] === "hook" && a[1] === "subagent") await import("./hook-entry.js");
else await import("./cli-main.js");
