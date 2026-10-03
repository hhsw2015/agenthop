// Standalone entry for the presence daemon, run as a NON-compiled script via `bun` (or `node`) — NOT the bun --compile
// binary, which exits when it has no controlling terminal (backgrounded/detached by a SessionStart hook). A plain bun/
// node script with a ref'd keep-alive survives that, so the SessionStart hook runs this file. See presence.ts.
import { runPresence } from "./presence.js";

runPresence({});
