// Bundle entry for the VM-side result reporter. Bun-bundled to dist-swarm/ah-report.js (build:swarm-report) and
// injected into the Railway box; the box runs it with node to seal the task output under the per-launch key and
// post it to the per-task A2A room. Reads the result from stdin:
//   <cli> | node ah-report.js --code <roomAddress> --key <hexKey> --relay <relayUrl>
import { reportResult } from "./room.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const code = flag("--code");
const key = flag("--key");
const relay = flag("--relay");
if (!code || !key) {
  process.stderr.write("ah-report: --code and --key are required\n");
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  reportResult({ code, keyHex: key, text: input, relay })
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`ah-report: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
});
