import { parseAddress, redactAddress, classify, stripAddress, readAddress, addressFile, PROBES, probeById } from "./node-introspect.js";
const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

const real = "tcpGFwWCCUAxZS2gvHI8pgV0AzabL7_xhr9nqcH-cHgzuOtyvXQ2FrWCA1XH9TCgGeLJBT5YTXgEK0bRPRPYzjKjmfMgd45oJHM2FxWCAL6JTRdGCwgWmLZ3CicBzdMvnOr0cp3hVftQ7wN6PafmFpGQEv";
t("a real address parses", parseAddress(real) === real);
t("trailing newline tolerated", parseAddress(real + "\n") === real);
t("whitespace tolerated", parseAddress("  " + real + "  ") === real);
t("empty -> undefined", parseAddress("") === undefined);
t("garbage -> undefined (never a credential)", parseAddress("hello world") === undefined);
t("too short -> undefined", parseAddress("tcSHORT") === undefined);
t("redaction keeps a head, never the body", redactAddress(real) === "tcpGFw…(154)" && !redactAddress(real).includes(real.slice(10)));
t("redaction of nothing", redactAddress(undefined) === "(none)");

t("timeout -> unreachable, NOT failure", classify(null, "", "", true) === "unreachable");
t("permission denied -> unreachable", classify(1, "", "Permission denied (publickey).", false) === "unreachable");
t("no such host -> unreachable", classify(1, "", "dial tcp: no such host", false) === "unreachable");
t("a real command error -> failed", classify(2, "", "cat: no such file", false) === "failed");
// Measured against a KILLED server — this is the expired-VM case and must read as unreachable.
t("measured: tailcat ping deadline -> unreachable", classify(1, "", '2026/10/02 20:59:01 tailcat Ping: context deadline exceeded', false) === "unreachable");
t("measured: tlsdial failure -> unreachable", classify(1, "", 'tlsdial: error: server cert for "tc302a.ipn.dev" failed both system roots & Let\'s Encrypt root validation', false) === "unreachable");
t("a malformed address is OUR bug -> failed, not a dead box", classify(1, "", 'invalid tailcat address "x": CBOR unmarshal', false) === "failed");
t("exit 0 with output -> ok", classify(0, "line\n", "", false) === "ok");
t("exit 0 with no output -> empty (not ok)", classify(0, "   \n", "", false) === "empty");

t("address stripped from diagnostics", stripAddress(`error connecting to ${real} failed`, real) === "error connecting to <redacted-address> failed");
t("unsafe launchId refused", (() => { try { addressFile("/h", "../evil"); return false; } catch { return true; } })());
t("readAddress on a missing file -> undefined", readAddress("/tmp/no-such-home", "rw-x") === undefined);
// A read-only probe must not contain a mutating subcommand. Match on the FIRST token of each argv
// (the program) plus any explicit mutator name, instead of a loose regex over the joined string.
const MUTATORS = new Set(["send-keys", "kill", "kill-server", "rm", "mv", "cp", "tee", "truncate", "sed", "dd", "chmod", "mkfs"]);
t("no probe runs a mutating program", PROBES.every(p => !MUTATORS.has(p.argv[0]!)));
t("no probe names a tmux mutator", PROBES.every(p => !p.argv.some(a => a === "send-keys" || a === "kill-session")));
t("read-only programs only", PROBES.every(p => ["tmux","cat","tail","ps","sh","free","uptime","vm_stat"].includes(p.argv[0]!)));
t("screen probe uses capture-pane", probeById("screen")!.argv.join(" ") === "tmux capture-pane -t swarm -p");
t("no probe uses a literal -- separator (verified broken)", PROBES.every(p => !p.argv.includes("--")));
console.log("all node-introspect selftests passed");
