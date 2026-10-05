// Selftest for the whois tool (scripts/whois.ts) — no top-level side effects; run:
//   tsx scripts/whois.selftest.mts
// Fixtures freeze tonight's real-fire ids (bus-identity-design §0 F18 + the run drift) so the exact bus
// failures the alias table/whois was built to fix stay regression-caught: a handle short id (from source A)
// and a reply `from=run` (source B) must now resolve to the SAME entity, and a restart's run drift must
// surface as explicit candidates on the stable native. Tool-only; the 0/0 kernel is imported, not touched.
import { buildProjection, whois, type IdentityEvent } from "../packages/bus/src/bus-identity.js";
import { entityView, probeFacts, queryJson, replyTo } from "./whois.js";

const t = (name: string, cond: boolean) => { if (!cond) throw new Error("FAILED: " + name); console.log("ok  " + name); };
const eid = (p: ReturnType<typeof buildProjection>, id: string) => { const r = whois(p, id); return r.kind === "entity" ? r.entity.entityId : ""; };

// an announce = run + native + (native-derived) handle, as recordSelfObserve emits.
const announce = (run: string, native: string, handle: string, over: { ts: number; busPid?: number; hostPid?: number; scope?: "local" | "relay"; eventId: string }): IdentityEvent => ({
  v: 1, eventId: over.eventId, ts: over.ts, type: "observe",
  incarnation: {
    key: run, scope: over.scope ?? "local", busPid: over.busPid, hostPid: over.hostPid,
    claims: [
      { value: run, form: "run", confidence: "hard", provenance: "same-announce" },
      { value: native, form: "native", confidence: "hard", provenance: "same-announce" },
      { value: handle, form: "handle", confidence: "hard", provenance: "same-announce", derivedFrom: { value: native, form: "native" } },
    ],
  },
});

// Tonight's real-fire ids (roster + F18 three-plus examples), each: handle short-id = native, reply from = run.
const events: IdentityEvent[] = [
  announce("673c6525", "01a0ead5", "codex:Work-01a0ead5", { ts: 1, busPid: 63436, eventId: "f18-1" }),
  announce("2e5d2a89", "f32a0507", "claude:agenthop-f32a0507", { ts: 1, busPid: 6498, eventId: "f18-2" }),
  announce("47b3cd90", "fe0376cd", "claude:agenthop-fe0376cd", { ts: 1, busPid: 64665, eventId: "f18-3" }),
  // F18 #3 / run drift: native 01a0ff49 (codex thread id, stable) seen under run 7fa8a9ee then af1962e4 (restart).
  announce("7fa8a9ee", "01a0ff49", "codex:happycapy-01a0ff49", { ts: 1, busPid: 66897, eventId: "drift-old" }),
  announce("af1962e4", "01a0ff49", "codex:happycapy-01a0ff49", { ts: 2, busPid: 62144, eventId: "drift-new" }),
];
const proj = buildProjection(events);

// --- F18 translation: handle short-id, native, and reply-from run all resolve to the SAME entity ---
for (const [run, native, handle, label] of [
  ["673c6525", "01a0ead5", "codex:Work-01a0ead5", "01a0ead5"],
  ["2e5d2a89", "f32a0507", "claude:agenthop-f32a0507", "f32a0507"],
  ["47b3cd90", "fe0376cd", "claude:agenthop-fe0376cd", "fe0376cd"],
] as const) {
  const r = eid(proj, run);
  t(`F18 ${label}: run + native + handle resolve to one entity`, r !== "" && eid(proj, native) === r && eid(proj, handle) === r);
  t(`F18 ${label}: prefix of the run id resolves too (resolvePeer parity)`, whois(proj, run.slice(0, 6)).kind === "entity");
}

// --- run drift (af1962e4 ← 7fa8a9ee): the stable native surfaces BOTH runs as candidates, not a silent merge ---
{
  const wNative = whois(proj, "01a0ff49");
  t("run drift: the stable native 01a0ff49 → candidates (both runs), explicit ambiguity", wNative.kind === "candidates" && wNative.entities.length === 2);
  t("run drift: each run id resolves to its own distinct entity", whois(proj, "af1962e4").kind === "entity" && whois(proj, "7fa8a9ee").kind === "entity" && eid(proj, "af1962e4") !== eid(proj, "7fa8a9ee"));
  t("run drift: the shared handle also surfaces the drift as candidates", whois(proj, "codex:happycapy-01a0ff49").kind === "candidates");
}

// --- three faces (§4.2): identity recorded / reachability / liveness produced for a resolved entity ---
{
  const r = whois(proj, "673c6525");
  t("resolved to a single entity for the view checks", r.kind === "entity");
  if (r.kind === "entity") {
    const v = entityView(r.entity, 1000);
    t("face 1 identity: aliases include run+native+handle", ["673c6525", "01a0ead5", "codex:Work-01a0ead5"].every((val) => v.identity.aliases.some((a) => a.value === val && a.confidence === "hard")));
    t("face 2 reachability: reply-to = the recorded hard handle, marked unverified", v.reachability.replyTo === "codex:Work-01a0ead5" && v.reachability.verified === false);
    t("face 3 liveness: a three-state verdict with a reason + probed busPid evidence", ["alive", "suspected", "dead"].includes(v.liveness.state) && typeof v.liveness.reason === "string" && v.liveness.evidence.some((f) => f.target === "busPid"));
    t("liveness: last-activity is inferred from recorded lastSeen (not verified output)", v.liveness.lastActivitySecAgo === 999);
    t("replyTo helper agrees with the view", replyTo(r.entity).handle === "codex:Work-01a0ead5");
    t("probeFacts emits a probed busPid fact for the latest incarnation", probeFacts(r.entity, 1000).some((f) => f.target === "busPid" && f.pid === 63436));
  }
}

// --- --json shape (viz / script consumption) ---
{
  const j = queryJson(proj, "673c6525");
  t("--json: entity result carries query + kind + one entity with three faces", j.query === "673c6525" && j.kind === "entity" && j.entities.length === 1 && j.entities[0]!.reachability.replyTo === "codex:Work-01a0ead5" && typeof j.entities[0]!.liveness.state === "string");
  const jd = queryJson(proj, "01a0ff49");
  t("--json: run-drift query carries both candidate entities", jd.kind === "candidates" && jd.entities.length === 2);
  const jn = queryJson(proj, "never-seen-xyz");
  t("--json: an unseen id is kind not-seen with zero entities", jn.kind === "not-seen" && jn.entities.length === 0);
}

// --- batch is just one query per id; a pid-only hit is the unverified `pid` kind ---
{
  t("batch: an unseen id resolves not-seen without affecting others", whois(proj, "nope").kind === "not-seen" && whois(proj, "673c6525").kind === "entity");
  t("pid: a raw busPid resolves to the unverified `pid` kind (needs a probe)", whois(proj, "63436").kind === "pid");
}

console.log("all whois selftests passed");
