export { startAgenthop, enhancedInstructions } from "./agenthop.js";
export { startBusMcp, registerBusTools, busInstructions } from "./mcp.js";
export { startBusCore, type BusCore, type UnifiedPeer, type BusMessage } from "./core.js";
export { startLocalBus, socketPath, type LocalBus, type Peer, type Inbound } from "./broker.js";
export { selfInfo, detectTool, type SelfInfo } from "./label.js";
export { version } from "./version.js";
