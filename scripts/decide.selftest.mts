// Selftest for decide.ts PURE core (classifyArgs + parseSubmitInput). Run: tsx scripts/decide.selftest.mts
// The IO (openBatch/listBatches) is the SIGNED store — exercised by the sandbox loop proof, not here.
import { classifyArgs, parseSubmitInput } from "./decide.js";

let pass = 0;
const ok = (cond: boolean, msg: string): void => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } pass++; console.log(`ok  ${msg}`); };

// ── classifyArgs ──
{
  ok(classifyArgs([]).mode === "usage", "classify: no args ⇒ usage");
  const s = classifyArgs(["submit", "f.json", "--owner", "coord", "--notify", "box", "--batch-id", "b1", "--home", "/tmp/h"]);
  ok(s.mode === "submit" && s.src === "f.json" && s.owner === "coord" && s.notifyTo === "box" && s.batchId === "b1" && s.home === "/tmp/h", "classify: submit with all flags");
  const s2 = classifyArgs(["submit", "-"]);
  ok(s2.mode === "submit" && s2.src === "-" && s2.owner === undefined, "classify: submit from stdin, no flags");
  ok(classifyArgs(["submit"]).mode === "usage", "classify: submit without source ⇒ usage");
  ok(classifyArgs(["submit", "--owner"]).mode === "usage", "classify: submit with flag-as-source ⇒ usage");
  const miss = classifyArgs(["submit", "f.json", "--owner"]);
  ok(miss.mode === "usage" && miss.error?.includes("--owner") === true, "classify: dangling --owner ⇒ usage error");
  ok(classifyArgs(["submit", "f.json", "--bogus"]).mode === "usage", "classify: unknown submit option ⇒ usage");
  // DEC-P2-4: a flag must not swallow the NEXT flag as its value.
  const sw = classifyArgs(["submit", "f.json", "--owner", "--notify", "box"]);
  ok(sw.mode === "usage" && sw.error?.includes("--owner") === true, "classify: --owner swallowing --notify ⇒ usage (DEC-P2-4)");
  ok(classifyArgs(["submit", "f.json", "--notify", "--batch-id", "b"]).mode === "usage", "classify: --notify swallowing --batch-id ⇒ usage");
  ok(classifyArgs(["list", "--home", "--x"]).mode === "usage", "classify: list --home swallowing a flag ⇒ usage");
  const stdinOwner = classifyArgs(["submit", "f.json", "--owner", "-"]);
  ok(stdinOwner.mode === "submit" && stdinOwner.owner === "-", "classify: a lone '-' is still a legal flag value");
  const l = classifyArgs(["list", "--home", "/tmp/h"]);
  ok(l.mode === "list" && l.home === "/tmp/h", "classify: list with --home");
  ok(classifyArgs(["list"]).mode === "list", "classify: bare list");
  ok(classifyArgs(["nonsense"]).mode === "usage", "classify: unknown command ⇒ usage");
}

// ── parseSubmitInput ──
{
  const items = '[{"id":"a","kind":"呈批","summary":"s1","suggestedAction":"approve"},{"id":"b","kind":"呈批","summary":"s2","suggestedAction":"reject","hardGate":true,"evidenceRef":"e"}]';
  const r = parseSubmitInput(items, { owner: "coord" });
  ok(r.ok && r.batch.items.length === 2 && r.batch.owner === "coord" && r.batch.items[1]!.hardGate === true, "parse: bare array + --owner");
  // object form, flags override
  const obj = '{"owner":"fromjson","notifyTo":"box","batchId":"b9","items":[{"id":"x","kind":"k","summary":"s","suggestedAction":"go"}]}';
  const ro = parseSubmitInput(obj, {});
  ok(ro.ok && ro.batch.owner === "fromjson" && ro.batch.notifyTo === "box" && ro.batch.batchId === "b9", "parse: object form carries owner/notifyTo/batchId");
  const rov = parseSubmitInput(obj, { owner: "flagwins" });
  ok(rov.ok && rov.batch.owner === "flagwins", "parse: flag overrides JSON owner");
  // errors
  ok(!parseSubmitInput("{bad", {}).ok, "parse: malformed JSON ⇒ error");
  ok(!parseSubmitInput("[]", { owner: "c" }).ok, "parse: empty items ⇒ error");
  const noOwner = parseSubmitInput(items, {});
  ok(!noOwner.ok && noOwner.error!.includes("owner"), "parse: missing owner ⇒ error");
  const badItem = parseSubmitInput('[{"id":"a","kind":"k","summary":"s"}]', { owner: "c" }); // no suggestedAction
  ok(!badItem.ok && badItem.error!.includes("item[0]"), "parse: invalid item ⇒ error naming the index");
  const dup = parseSubmitInput('[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"},{"id":"a","kind":"k","summary":"t","suggestedAction":"h"}]', { owner: "c" });
  ok(!dup.ok && dup.error!.includes("duplicate"), "parse: duplicate id ⇒ error");
  ok(!parseSubmitInput('"a string"', { owner: "c" }).ok, "parse: non-array/object JSON ⇒ error");
  ok(!parseSubmitInput('{"owner":"c"}', {}).ok, "parse: object without items ⇒ error");
  // DEC-P2-4: a DECLARED field of the wrong type is an error, never silently defaulted.
  const numId = parseSubmitInput('{"batchId":123,"items":[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"}]}', { owner: "c" });
  ok(!numId.ok && numId.error!.includes("batchId"), "parse: numeric batchId ⇒ error (not a silent random id)");
  ok(!parseSubmitInput('{"notifyTo":5,"items":[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"}]}', { owner: "c" }).ok, "parse: non-string notifyTo ⇒ error");
  ok(!parseSubmitInput('{"owner":9,"items":[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"}]}', {}).ok, "parse: non-string owner ⇒ error");
  // an unknown key (e.g. the draft artifact's _comment) is still ignored.
  const wc = parseSubmitInput('{"_comment":"draft","owner":"c","items":[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"}]}', {});
  ok(wc.ok && wc.batch.owner === "c", "parse: unknown _comment key ignored");
  // a valid item keeps optional fields clean
  const clean = parseSubmitInput('[{"id":"a","kind":"k","summary":"s","suggestedAction":"g"}]', { owner: "c" });
  ok(clean.ok && !("evidenceRef" in clean.batch.items[0]!) && !("hardGate" in clean.batch.items[0]!), "parse: optional item fields omitted when absent");
}

console.log(`\nall decide selftests passed (${pass})`);
