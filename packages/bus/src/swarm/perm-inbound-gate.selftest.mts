import { isBypassClass, inboundGate, gateByModes } from "./perm-inbound-gate.js";

const t = (n: string, c: boolean) => { if (!c) throw new Error("FAILED: " + n); console.log("ok  " + n); };

// --- class ---
t("bypassPermissions is bypass-class", isBypassClass("bypassPermissions") === true);
t("plan is bypass-class", isBypassClass("plan") === true);
t("auto/acceptEdits/dontAsk/manual/default prompt", ["auto", "acceptEdits", "dontAsk", "manual", "default"].every((m) => !isBypassClass(m as any)));

// --- default two-class gate ---
t("prompting receiver + prompting sender -> deliver", inboundGate({ senderBypass: false, receiverBypass: false }) === "deliver");
t("prompting receiver + BYPASS sender -> hold (anti-launder)", inboundGate({ senderBypass: true, receiverBypass: false }) === "hold");
t("BYPASS receiver + prompting sender -> hold", inboundGate({ senderBypass: false, receiverBypass: true }) === "hold");
t("BYPASS receiver + BYPASS sender -> deliver", inboundGate({ senderBypass: true, receiverBypass: true }) === "deliver");

// --- explicit crossSessionInbound overrides the default ---
t("explicit refuse wins", inboundGate({ senderBypass: false, receiverBypass: false, explicit: "refuse" }) === "refuse");
t("explicit accept wins (even bypass sender)", inboundGate({ senderBypass: true, receiverBypass: false, explicit: "accept" }) === "deliver");
t("explicit hold wins", inboundGate({ senderBypass: false, receiverBypass: false, explicit: "hold" }) === "hold");

// --- gateByModes convenience ---
t("gateByModes: bypass->manual held", gateByModes("bypassPermissions", "manual") === "hold");
t("gateByModes: manual->manual delivered", gateByModes("manual", "manual") === "deliver");
t("gateByModes: plan sender treated as bypass (held to a prompting receiver)", gateByModes("plan", "auto") === "hold");
t("gateByModes: explicit refuse overrides", gateByModes("manual", "manual", "refuse") === "refuse");

console.log("all perm-inbound-gate selftests passed");
