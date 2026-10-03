// Bundle entry for the VM-side bus client. Bun-bundled to dist-swarm/ah-report.mjs (build:swarm-report) and
// injected into the Railway box; the box runs it with node. Two modes over the per-task A2A room:
//   --post:  seal the task output (stdin) under the per-launch key and POST it to the room (VM -> dispatcher).
//            <cli> | node ah-report.mjs --post --code <addr> --key <hex> --relay <url>
//   --pull:  read the room and print the newest dispatcher COMMAND (dispatcher -> VM). Two-way networking.
//            node ah-report.mjs --pull --code <addr> --key <hex> --relay <url>
import { reportResult, pullMessages, SWARM_CMD_PREFIX } from "./room.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);

const code = flag("--code");
const key = flag("--key");
const relay = flag("--relay");
if (!code || !key) {
  process.stderr.write("ah-report: --code and --key are required\n");
  process.exit(2);
}

if (has("--pull")) {
  pullMessages({ code, keyHex: key, relay, prefix: SWARM_CMD_PREFIX })
    .then(({ messages }) => {
      if (messages.length) process.stdout.write(messages[messages.length - 1]!); // newest command
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`ah-report: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
} else {
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
}
