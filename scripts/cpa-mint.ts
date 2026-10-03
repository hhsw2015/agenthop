// Mint a CPA ephemeral capability token on the dispatcher (the trusted side that holds the shared secret).
// Run:  npx tsx scripts/cpa-mint.ts [--sub <agent/launch id>] [--ttl <seconds, <=3600>]
// Reads the secret from CPA_EPH_SECRET env or ~/.cpa_eph_secret. Prints the token (use as ANTHROPIC_AUTH_TOKEN
// / OPENAI_API_KEY against CPA). See packages/bus/src/swarm/mint.ts + CLIProxyAPIPlus/docs/cpa-ephemeral-token.md.
import { mintEphToken, readEphSecret } from "../packages/bus/src/swarm/mint.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const sub = flag("--sub") ?? `manual-${Date.now()}`;
const ttlRaw = flag("--ttl");
const ttlSec = ttlRaw ? Number(ttlRaw) : undefined;
if (ttlRaw && !Number.isFinite(ttlSec)) {
  process.stderr.write("--ttl must be a number of seconds\n");
  process.exit(1);
}

try {
  process.stdout.write(`${mintEphToken({ sub, ttlSec, secret: readEphSecret() })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
