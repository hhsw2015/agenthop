#!/bin/sh
# Box-side REAL task worker: a headless Claude repointed at CPA executes the assignment, then its self-reported outcome
# is merged with the assignment's AUTHORITATIVE identity into result.json (swarm-build-result.mjs), which the supervisor
# publishes via one milestone. Mirrors the demo worker's cooperative-freeze contract (produce output, signal a
# milestone, wait for a CONFIRMED ack, then STOP mutating the result — O2 freeze). The CPA token comes from the sourced
# worker-env, NEVER argv (§4.5-3, the Codex #6 argv-leak lesson). Env: SWARM_WORK_DIR, SWARM_RUNTIME_DIR.
# Files (scp'd by swarm-task.sh): /root/.swarm/{assignment.json, worker-env, swarm-build-result.mjs}.
set -u
WORK="${SWARM_WORK_DIR:-/root/work}"
RT="${SWARM_RUNTIME_DIR:-/root/.swarm-rt}"
SW="/root/.swarm"
NODE="${SWARM_NODE:-/root/.local/share/mise/shims/node}"
command -v "$NODE" >/dev/null 2>&1 || NODE=node
ASG="$SW/assignment.json"
REPORT="$SW/worker-report.json"
[ -f "$ASG" ] || { echo "claude-worker: no assignment.json at $ASG" >&2; exit 2; }
mkdir -p "$RT"

# Wait for a terminal ack for request $1 (consistent snapshot per poll). 0=confirmed, 1=error, 2=timeout. (demo-worker)
await_ack() {
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -f "$RT/checkpoint.ack" ]; then
      ack=$(cat "$RT/checkpoint.ack" 2>/dev/null)
      case "$ack" in
        *"\"requestId\":\"$1\""*)
          case "$ack" in
            *'"status":"confirmed"'*) return 0 ;;
            *'"status":"error"'*) return 1 ;;
          esac ;;
      esac
    fi
    i=$((i + 1)); sleep 0.5
  done
  return 2
}

# Fields from the assignment (node, not fragile JSON-in-shell).
f() { "$NODE" -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(String(a[process.argv[2]]??""))' "$ASG" "$1"; }
GOAL="$(f goal)"; ATTEMPT="$(f attemptId)"; RESULT_REL="$(f resultPath)"
RESULT_ABS="$WORK/$RESULT_REL"
SCOPES="$("$NODE" -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write((a.sourceWriteScope||a.artifactScope||[]).join(", "))' "$ASG")"
OUTS="$("$NODE" -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(((a.outputContract&&a.outputContract.requiredOutputs)||[]).map(o=>o.logicalName+"("+o.kind+")").join(", "))' "$ASG")"

# CPA base-url + ephemeral token for the model calls (sourced; token never on argv).
[ -f "$SW/worker-env" ] && . "$SW/worker-env"

# Materialize dependency inputs (read-only) into /root/inputs/<depNodeId>/ (§4.5-2). EMPTY for a no-dependency T1 node;
# exercised when T2 wires multi-node DAGs. Inputs are fixed SHAs (workCommit), branch-independent. execFileSync arg
# arrays (never a shell string) so a SHA/path can't inject. Full output-tree materialization lands with T2.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $SW/deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
"$NODE" -e '
  const fs=require("fs"), cp=require("child_process");
  const a=JSON.parse(fs.readFileSync(process.argv[1])); const work=process.argv[2];
  for (const ib of (a.inputBindings||[])) {
    const dest="/root/inputs/"+ib.depNodeId; fs.mkdirSync(dest,{recursive:true});
    cp.execFileSync("git",["-C",work,"fetch","-q","origin",ib.workCommit],{stdio:"inherit"});
    const blob=cp.execFileSync("git",["-C",work,"show",ib.workCommit+":"+ib.resultPath]);
    fs.writeFileSync(dest+"/result.json", blob);
  }
' "$ASG" "$WORK" || { echo "claude-worker: input materialization failed" >&2; exit 4; }

PROMPT="You are an autonomous swarm worker on a throwaway VM. The full contract is the JSON at $ASG — read it first.
GOAL: $GOAL
Work inside $WORK. You may modify source files only under: ${SCOPES:-<none declared>}. Produce the required outputs: ${OUTS:-<none>} as files under out/ (the only published path).
When finished, write $REPORT as JSON exactly:
  {\"outcome\":\"success\"|\"failure\", \"failureReason\":\"<only if failure>\", \"outputs\":[{\"logicalName\":\"..\",\"kind\":\"patch|files|report|notes\",\"path\":\"out/..\"}], \"validationEvidence\":[{\"check\":\"..\",\"cmd\":\"..\",\"exitCode\":0}]}
Do NOT fabricate success — if you cannot meet the goal, write outcome=failure with a concrete reason. Do not write outside out/ and the allowed source scope."

cd "$WORK" || exit 2
rm -f "$REPORT"
# Run the headless worker. Q6: the exact CLI form is the open question; this is the current shape. On any failure we
# still fall through to build-result, which turns a missing report into an explicit failure result.
if command -v claude >/dev/null 2>&1; then
  echo "claude-worker: running headless claude for $ATTEMPT"
  claude -p "$PROMPT" --output-format stream-json --dangerously-skip-permissions >"$SW/worker.claude.log" 2>&1 \
    || echo "claude-worker: claude exited non-zero (see $SW/worker.claude.log)" >&2
else
  echo "claude-worker: 'claude' CLI not installed on box — producing a failure result" >&2
fi

# Merge identity (assignment) + outcome (report) -> canonical result.json, atomically.
"$NODE" "$SW/swarm-build-result.mjs" "$ASG" "$REPORT" "$RESULT_ABS" || { echo "claude-worker: build-result failed" >&2; exit 3; }
echo "claude-worker: wrote $RESULT_REL"

# Signal ONE milestone so the supervisor publishes the snapshot (incl. result.json); wait for a confirmed ack, then
# freeze (O2: stop mutating the result). A non-confirmed checkpoint holds the freeze rather than racing ahead.
printf '{"requestId":"m1","kind":"milestone","next":"task result published"}' > "$RT/checkpoint.req.tmp"
mv "$RT/checkpoint.req.tmp" "$RT/checkpoint.req"
echo "claude-worker: signaled milestone m1"
if await_ack "m1"; then echo "claude-worker: m1 confirmed"; else echo "claude-worker: m1 NOT confirmed (rc=$?) — holding freeze" >&2; fi

echo "claude-worker: finished; idling so the box stays alive for the near-death/handoff path"
sleep 3600
