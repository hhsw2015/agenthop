#!/usr/bin/env bash
# tern-restore fixture: a fake `tern` keeps state in a JSON file, so start/skip/assert run with no daemon.
# Covers: cold start (all seats start + renamed), idempotent rerun (starts nothing), duplicate block FAIL,
# wrong-model FAIL, posture ABSENT reported and ~/.claude.json NEVER written, codex exclusivity warning.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PY="$HERE/tern-restore.py"
fails=0
ck() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $(printf %q "$3") want $(printf %q "$2"))"; fails=$((fails+1)); fi; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

cat >"$T/tern" <<'FAKE'
#!/usr/bin/env python3
import json, os, shlex, sys
st = os.environ["FAKE_STATE"]
d = json.load(open(st)) if os.path.exists(st) else {"next": 100, "sessions": [{"name": "agenthop", "tabs": []}]}
a = sys.argv[1:]
T = os.path.dirname(st)
open(os.environ["FAKE_LOG"], "a").write(" ".join(a) + "\n")
if a[:2] == ["ls", "--json"]:
    if os.path.exists(T + "/ls-empty-object"):
        print("{}"); sys.exit(0)
    sess = json.loads(json.dumps(d["sessions"]))
    if os.path.exists(T + "/swap-identity-after-list") and d.get("listed_once"):
        for t in sess[0]["tabs"]:
            for b in t["blocks"]:
                if b["id"] == d.get("swap_id"): b["command"] = "tern acp claude --resume other9999 --mode bypassPermissions --model m1"
        for t in d["sessions"][0]["tabs"]:
            for b in t["blocks"]:
                if b["id"] == d.get("swap_id"): b["command"] = "tern acp claude --resume other9999 --mode bypassPermissions --model m1"
    if os.path.exists(T + "/swap-identity-after-list"):
        d["listed_once"] = True
    hidden = d.get("hidden", {})
    for t in sess[0]["tabs"]:
        t["blocks"] = [b for b in t["blocks"] if hidden.get(str(b["id"]), 0) <= 0]
    if os.path.exists(T + "/ls-missing-blocks"):
        sess[0]["tabs"].append({"name": "x"})
    for k in list(hidden):
        hidden[k] -= 1
    d["hidden"] = hidden
    json.dump(d, open(st, "w"))
    print(json.dumps({"sessions": sess, "detached": []})); sys.exit(0)
elif a[:2] == ["new", "tab"]:
    cmd = a[a.index("--") + 1:]
    bid = d["next"]; d["next"] += 1
    d["swap_id"] = bid
    for n in (3, 99):
        if os.path.exists(T + f"/list-delay-{n}"):
            d.setdefault("hidden", {})[str(bid)] = n
    d["sessions"][0]["tabs"].append({"name": None, "blocks": [{"id": bid, "live": True, "exited": None,
        "cwd": a[a.index("--cwd") + 1], "command": " ".join(shlex.quote(x) for x in cmd)}]})
    print(bid)
elif a[0] == "process":
    # mirrors real tern 0.8.3: unreachable daemon / unknown id both exit 1 with distinct messages
    if os.path.exists(T + "/daemon-down"):
        sys.stderr.write("tern process: no Tern is running (no session daemon on /x)\n"); sys.exit(1)
    known = {str(b["id"]) for t in d["sessions"][0]["tabs"] for b in t["blocks"]} | set(d.get("daemon_only", {}))
    if a[1] not in known:
        sys.stderr.write(f"tern process: no block is called `{a[1]}`\n"); sys.exit(1)
    # like real tern: the child's argv is the launch (from the listing, else the daemon-only record)
    cmd = next((b["command"] for t in d["sessions"][0]["tabs"] for b in t["blocks"] if str(b["id"]) == a[1]), None)
    if cmd is None: cmd = (d.get("daemon_only") or {}).get(a[1]) if isinstance(d.get("daemon_only"), dict) else None
    argv = ["/Applications/Tern.app/Contents/MacOS/tern"] + (shlex.split(cmd)[1:] if cmd else [])
    print(json.dumps({"child": {"pid": 5000 + int(a[1]), "argv": argv}}))
elif a[0] == "rename":
    if os.path.exists(T + "/rename-fail-once"):
        os.remove(T + "/rename-fail-once"); sys.stderr.write("block in no tab\n"); sys.exit(1)
    for t in d["sessions"][0]["tabs"]:
        if any(str(b["id"]) == a[1] for b in t["blocks"]): t["name"] = a[2]
else:
    sys.exit(3)
json.dump(d, open(st, "w"))
FAKE
chmod +x "$T/tern"

cat >"$T/roster.json" <<'R'
{"session":"agenthop","seats":[
 {"role":"Manager","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"cpa-local/claude-fable-5-1[1m]"},
 {"role":"Infra Dev","tool":"claude","sid":"bbbb2222","cwd":"/tmp/x","model":"cpa-local/claude-opus-5-5[1m]"},
 {"role":"Chief Review","tool":"codex","sid":"cccc3333","cwd":"/tmp/y","model":null}]}
R
printf '{"bypassPermissionsModeAccepted":true,"projects":{"/tmp/x":{"hasTrustDialogAccepted":true}}}' >"$T/claude.json"
# ps table: block 100/101 (claude) -> tern acp child 5100/5101 -> node -> claude stream-json; block 102 (codex) -> node adapter
cat >"$T/ps" <<'P'
5100 1 tern acp claude --resume aaaa1111
6100 5100 node adapter
7100 6100 claude --output-format stream-json --resume=aaaa1111
5101 1 tern acp claude --resume bbbb2222
6101 5101 node adapter
7101 6101 claude --output-format stream-json --resume=bbbb2222
5102 1 tern acp codex --resume cccc3333
6102 5102 /usr/local/bin/node /opt/Tern/agents/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js
6103 6102 /usr/local/bin/codex app-server
P
export RESTORE_PENDING_DIR="$T/pending" PRESENCE_DIR="$T/presence" RESTORE_WAIT_S=1 SEAT_SHELL_CMD="$T/seatshell"
printf '#!/usr/bin/env bash\necho "$@" >>"%s/seatshell.log"\n' "$T" >"$T/seatshell"; chmod +x "$T/seatshell"
export TERN_BIN="$T/tern" FAKE_STATE="$T/state.json" FAKE_LOG="$T/log" CLAUDE_JSON="$T/claude.json" RESTORE_PS="$T/ps"
run() { python3 "$PY" "$T/roster.json" "$@" >"$T/out" 2>&1; echo $?; }
starts() { grep -c '^new tab' "$T/log" 2>/dev/null || true; }

# --- cold start ---
: >"$T/seatshell.log"
rc=$(run); ck "cold: exit 0" "0" "$rc"
ck "cold: 3 seats started" "3" "$(starts)"
ck "cold: result 3/3" "1" "$(grep -c 'result: 3/3' "$T/out")"
ck "cold: claude seat gets bypass mode" "1" "$(grep -c 'new tab agenthop --cwd /tmp/x -- tern acp claude --resume aaaa1111 --mode bypassPermissions --model cpa-local/claude-fable-5-1\[1m\]' "$T/log")"
ck "cold: codex seat gets full access via env (no --mode flag)" "1" "$(grep -c -- '-- env INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume cccc3333$' "$T/log")"
ck "cold: tabs renamed to roles" "3" "$(grep -c '^rename ' "$T/log")"

ck "seat-shell: set called on cold run with tern+pid" "1" "$(grep -c '^set aaaa1111 tern 7100$' "$T/seatshell.log")"
ck "seat-shell: one set per seat" "3" "$(wc -l <"$T/seatshell.log" | tr -d ' ')"
ck "presence: Manager -> its own claude pid" "7100" "$(head -1 "$T/presence/aaaa1111.pid")"
ck "presence: Infra Dev -> its own claude pid" "7101" "$(head -1 "$T/presence/bbbb2222.pid")"
ck "presence: codex -> adapter child pid" "6102" "$(head -1 "$T/presence/cccc3333.pid")"
ck "presence: no leftover temp" "0" "$(find "$T/presence" -name '*.tmp-*' | wc -l | tr -d ' ')"

# --- presence SWAPPED (live pids, wrong seats) is detected by --check and fixed by a run ---
printf '7101' >"$T/presence/aaaa1111.pid"; printf '7100' >"$T/presence/bbbb2222.pid"
rc=$(run --check); ck "swap: --check exit 1" "1" "$rc"; ck "swap: --check names both" "2" "$(grep -c 'presence pid' "$T/out")"
ck "swap: --check does not write" "7101" "$(head -1 "$T/presence/aaaa1111.pid")"
rc=$(run); ck "swap: run fixes, exit 0" "0" "$rc"
ck "swap: Manager corrected" "7100" "$(head -1 "$T/presence/aaaa1111.pid")"; ck "swap: Infra corrected" "7101" "$(head -1 "$T/presence/bbbb2222.pid")"

: >"$T/seatshell.log"; run --check >/dev/null
ck "seat-shell: --check does not register" "0" "$(wc -l <"$T/seatshell.log" | tr -d ' ')"

# --- idempotent rerun: starts nothing ---
: >"$T/log"; rc=$(run); ck "rerun: exit 0" "0" "$rc"; ck "rerun: 0 new starts" "0" "$(starts)"
ck "rerun: 3 skips" "3" "$(grep -c '^skip:' "$T/out")"

# --- duplicate block => FAIL (check mode) ---
python3 - "$FAKE_STATE" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); t=d["sessions"][0]["tabs"][0]
d["sessions"][0]["tabs"].append({"name":"Manager","blocks":[dict(t["blocks"][0],id=999)]}); json.dump(d,open(sys.argv[1],"w"))
PY
rc=$(run --check); ck "dup: exit 1" "1" "$rc"; ck "dup: FAIL line names duplicate" "1" "$(grep -c 'FAIL: Manager: live 2x' "$T/out")"

# --- wrong model => FAIL ---
python3 - "$FAKE_STATE" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); d["sessions"][0]["tabs"]=d["sessions"][0]["tabs"][:3]
b=d["sessions"][0]["tabs"][1]["blocks"][0]; b["command"]=b["command"].replace("opus-5-5","fable-5"); json.dump(d,open(sys.argv[1],"w"))
PY
rc=$(run --check); ck "model: exit 1" "1" "$rc"; ck "model: FAIL names seat" "1" "$(grep -c 'FAIL: Infra Dev: model' "$T/out")"

# --- posture ABSENT is reported, and claude.json is NEVER written ---
printf '{"projects":{}}' >"$T/claude.json"; before="$(shasum "$T/claude.json")"
run --check >/dev/null
ck "posture: bypass ABSENT reported" "1" "$(grep -c 'bypassPermissionsModeAccepted ABSENT' "$T/out")"
ck "posture: trust ABSENT reported" "1" "$(grep -c 'trust /tmp/x ABSENT' "$T/out")"
ck "posture: claude.json unchanged (read-only)" "$before" "$(shasum "$T/claude.json")"

# --- codex exclusivity: a non-Tern process holding the codex sid is reported ---
echo "123 1 codex resume --resume cccc3333 --foo" >>"$T/ps"
run --check >/dev/null
ck "codex: outside holder reported as hint" "1" "$(grep -c 'codex-hint: Chief Review' "$T/out")"
echo "124 1 codex --resume cccc3333-other" >>"$T/ps"
run --check >/dev/null
ck "codex: suffixed sid is NOT reported (P3 TR-CONFLICT-DOC)" "1" "$(grep -c 'codex-hint' "$T/out")"

# --- bad roster => exit 2 ---
echo '{}' >"$T/bad.json"; rc=$(python3 "$PY" "$T/bad.json" >/dev/null 2>&1; echo $?); ck "bad roster: exit 2" "2" "$rc"

# ===== r2: review findings =====
fresh() { rm -f "$FAKE_STATE"; : >"$T/log"; rm -rf "$T/presence" "$T/pending"; }
seed() { python3 - "$FAKE_STATE" "$1" "$2" <<'PY2'
import json,sys
st,tab,cmd,bid=sys.argv[1],sys.argv[2] or None,sys.argv[3],100
d={"next":200,"sessions":[{"name":"agenthop","tabs":[{"name":tab,"blocks":[{"id":bid,"live":True,"exited":None,"cwd":"/tmp/x","command":cmd}]}]}]}
json.dump(d,open(st,"w"))
PY2
}
one() { printf '{"session":"agenthop","seats":[{"role":"Manager","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"m1"}]}' >"$T/one.json"; }
run1() { python3 "$PY" "$T/one.json" "$@" >"$T/out" 2>&1; echo $?; }
one

# TR-IDENTITY: impostor blocks must NOT count as the seat
fresh; seed Manager "tern acp claude --resume aaaa1111-x --model m1" ; run1 --check >/dev/null
ck "identity: suffixed sid is not the seat" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "tern acp codex --resume aaaa1111 --model m1"; run1 --check >/dev/null
ck "identity: wrong tool is not the seat" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "bash -c 'echo --resume aaaa1111 --model m1'"; run1 --check >/dev/null
ck "identity: non-ACP command with same text is not the seat" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "tern acp claude --resume=aaaa1111 --model=m1"; rc=$(run1 --check)
ck "identity: --resume=/--model= form is the seat" "0" "$(grep -c 'FAIL: Manager: not live\|FAIL: Manager: model' "$T/out")"

# TR-ATTACH-RETRY: rename fails once -> retried in-run; half-done block (wrong tab) -> rerun renames, no new start
fresh; touch "$T/rename-fail-once"; rc=$(run1)
ck "attach: rename retried after transient failure, exit 0" "0" "$rc"
ck "attach: one start only" "1" "$(grep -c '^new tab' "$T/log")"
fresh; seed "" "tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"; rc=$(run1)
ck "attach: half-done block renamed on rerun" "0" "$rc"
ck "attach: half-done block not started again" "0" "$(grep -c '^new tab' "$T/log")"
fresh; touch "$T/list-delay-3"; rc=$(run1); rc2=$(run1); ck "attach: delayed listing never starts twice" "1" "$(grep -c '^new tab' "$T/log")"

# TR-INVENTORY: well-formed-but-structureless listing => exit 3, zero changes
fresh; touch "$T/ls-empty-object"; rc=$(run); ck "inventory: {} listing exit 3" "3" "$rc"; ck "inventory: {} => zero starts" "0" "$(grep -c '^new tab' "$T/log")"
rm -f "$T/ls-empty-object"
fresh; touch "$T/ls-missing-blocks"; rc=$(run); ck "inventory: tab without blocks exit 3" "3" "$rc"; ck "inventory: zero starts" "0" "$(grep -c '^new tab' "$T/log")"
rm -f "$T/ls-missing-blocks"

# TR-ROSTER: bad roster => exit 2 BEFORE any start
fresh
printf '{"session":"agenthop","seats":[{"role":"A","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"m"},{"role":"B","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"m"}]}' >"$T/r.json"
rc=$(python3 "$PY" "$T/r.json" >/dev/null 2>&1; echo $?); ck "roster: duplicate sid exit 2" "2" "$rc"; ck "roster: dup => zero starts" "0" "$(grep -c '^new tab' "$T/log")"
printf '{"session":"agenthop","seats":[{"role":"A","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"m"},{"role":"B","tool":"claude","cwd":"/tmp/x","model":"m"}]}' >"$T/r.json"
rc=$(python3 "$PY" "$T/r.json" >/dev/null 2>&1; echo $?); ck "roster: later seat missing sid exit 2" "2" "$rc"; ck "roster: no partial start" "0" "$(grep -c '^new tab' "$T/log")"
printf '{"session":"agenthop","seats":[{"role":"A","tool":"gpt","sid":"aaaa1111","cwd":"/tmp/x","model":"m"}]}' >"$T/r.json"
rc=$(python3 "$PY" "$T/r.json" >/dev/null 2>&1; echo $?); ck "roster: unknown tool exit 2" "2" "$rc"
printf '{"session":"agenthop","seats":[{"role":"A","tool":"claude","sid":"aaaa1111","cwd":"/tmp/x","model":"m"},{"role":"A","tool":"codex","sid":"bbbb","cwd":"/tmp/x","model":null}]}' >"$T/r.json"
rc=$(python3 "$PY" "$T/r.json" >/dev/null 2>&1; echo $?); ck "roster: duplicate role exit 2" "2" "$rc"

# ===== r3: review 380e7cf findings =====
# TR-ATTACH-RETRY: listing lags across THREE separate runs ⇒ started exactly once (obligation persisted across processes)
fresh; touch "$T/list-delay-99"
run1 >/dev/null; run1 >/dev/null; run1 >/dev/null
ck "attach-xproc: three runs while unlisted => one start" "1" "$(grep -c '^new tab' "$T/log")"
ck "attach-xproc: pending entry persisted" "1" "$(ls "$T/pending" 2>/dev/null | grep -c 'aaaa1111.json')"
rm -f "$T/list-delay-99"; python3 - "$FAKE_STATE" <<'PY2'
import json,sys; d=json.load(open(sys.argv[1])); d["hidden"]={}; json.dump(d,open(sys.argv[1],"w"))
PY2
rc=$(run1); ck "attach-xproc: once listed, run finishes (exit 0)" "0" "$rc"
ck "attach-xproc: still exactly one start" "1" "$(grep -c '^new tab' "$T/log")"
ck "attach-xproc: pending cleared once live" "0" "$(ls "$T/pending" 2>/dev/null | wc -l | tr -d ' ')"
fresh; mkdir -p "$T/pending"; printf '{"at": 1, "role": "Manager", "block": 4242}' >"$T/pending/aaaa1111.json"
run1 >/dev/null; ck "attach-xproc: stale (>TTL) pending entry => one fresh start" "1" "$(grep -c '^new tab' "$T/log")"
fresh; mkdir -p "$T/pending"; printf '{torn' >"$T/pending/aaaa1111.json"
rc=$(run1); ck "attach-xproc: unreadable pending entry => exit 3 UNKNOWN" "3" "$rc"; ck "attach-xproc: unreadable => zero starts" "0" "$(grep -c '^new tab' "$T/log")"

# TR-INVENTORY: consumed leaf types
for bad in 'live:"true"' 'live:1' 'command:[]'; do
  fresh; seed Manager "tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"
  python3 - "$FAKE_STATE" "$bad" <<'PY2'
import json,sys; d=json.load(open(sys.argv[1])); k,v=sys.argv[2].split(":",1); d["sessions"][0]["tabs"][0]["blocks"][0][k]=json.loads(v); json.dump(d,open(sys.argv[1],"w"))
PY2
  rc=$(run1); ck "inventory type: $bad => exit 3" "3" "$rc"; ck "inventory type: $bad => zero starts" "0" "$(grep -c '^new tab' "$T/log")"
done
fresh; seed Manager "tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"
python3 - "$FAKE_STATE" <<'PY2'
import json,sys; d=json.load(open(sys.argv[1])); d["sessions"][0]["tabs"][0]["name"]={"x":1}; json.dump(d,open(sys.argv[1],"w"))
PY2
rc=$(run1); ck "inventory type: object tab name => exit 3" "3" "$rc"; ck "inventory type: object tab name => no rename" "0" "$(grep -c '^rename' "$T/log")"

# TR-IDENTITY: compound command / duplicate identity flags are not the seat
fresh; seed Manager "tern acp claude --resume other --model m1 && echo --resume aaaa1111 --model m1"; run1 --check >/dev/null
ck "identity: compound command smuggling the sid => not live" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "tern acp claude --resume aaaa1111 --resume other --model m1"; run1 --check >/dev/null
ck "identity: two --resume => not live" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "tern acp claude --resume aaaa1111 --model m1;echo hi"; run1 --check >/dev/null
ck "identity: glued ';' separator => not live" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"

# TR-ROSTER: trailing LF in the sid
fresh; python3 -c 'import json;print(json.dumps({"session":"agenthop","seats":[{"role":"A","tool":"claude","sid":"aaaa1111\n","cwd":"/tmp/x","model":"m"}]}))' >"$T/r.json"
rc=$(python3 "$PY" "$T/r.json" >/dev/null 2>&1; echo $?); ck "roster: sid with trailing LF => exit 2" "2" "$rc"; ck "roster: LF => zero starts" "0" "$(grep -c '^new tab' "$T/log")"

# TR-PRESENCE-PID: a non-adapter child mentioning codex is not the adapter
fresh
cat >"$T/ps-codex" <<'P'
5100 1 tern acp codex --resume cccc3333
6100 5100 tail -f /tmp/codex.log
P
printf '{"session":"agenthop","seats":[{"role":"Chief Review","tool":"codex","sid":"cccc3333","cwd":"/tmp/y","model":null}]}' >"$T/cx.json"
seed "Chief Review" "tern acp codex --resume cccc3333"
rc=$(RESTORE_PS="$T/ps-codex" python3 "$PY" "$T/cx.json" >"$T/out" 2>&1; echo $?)
ck "presence: tail -f codex.log is not the adapter => exit 1" "1" "$rc"
ck "presence: not found reported" "1" "$(grep -c 'agent pid not found' "$T/out")"
ck "presence: nothing written" "0" "$(ls "$T/presence" 2>/dev/null | wc -l | tr -d ' ')"

# TR-CODEX-HINT: positional `codex resume SID`
: >"$T/ps"; echo "200 1 /usr/local/bin/codex resume cccc3333" >>"$T/ps"; fresh; run --check >/dev/null
ck "codex hint: positional 'codex resume SID' reported" "1" "$(grep -c 'codex-hint: Chief Review' "$T/out")"
: >"$T/ps"; echo "201 1 /usr/local/bin/codex resume cccc3333-x" >>"$T/ps"; fresh; run --check >/dev/null
ck "codex hint: positional suffixed sid not reported" "0" "$(grep -c 'codex-hint' "$T/out")"

# ===== r4: TR-ATTACH-RETRY — age only triggers a RE-CHECK by block id; it never erases a successful start =====
old_pending() { mkdir -p "$T/pending"; printf '{"at": 1, "role": "Manager", "block": %s}' "$1" >"$T/pending/aaaa1111.json"; }
# (a) the reviewer's case: block 100 is alive in the daemon but not listed yet; the entry is >TTL old => attach, never block 101
fresh; old_pending 100
python3 - "$FAKE_STATE" <<'PY2'
import json,sys; json.dump({"next":101,"sessions":[{"name":"agenthop","tabs":[]}],"daemon_only":{"100":"tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"}},open(sys.argv[1],"w"))
PY2
run1 >/dev/null
ck "expired+alive-unlisted: no second start" "0" "$(grep -c '^new tab' "$T/log")"
ck "expired+alive-unlisted: reported as attaching" "1" "$(grep -c 'alive in the daemon' "$T/out")"
ck "expired+alive-unlisted: obligation kept" "1" "$(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
# (b) expired and provably gone (daemon answers: no such block) => clear and start once
fresh; old_pending 4242; run1 >/dev/null
ck "expired+gone: exactly one start" "1" "$(grep -c '^new tab' "$T/log")"
ck "expired+gone: reported as provably gone" "1" "$(grep -c 'provably gone' "$T/out")"
# (c) expired and listed exited => gone => one start
fresh; old_pending 100; seed Manager "tern acp claude --resume other --model m1"
python3 - "$FAKE_STATE" <<'PY2'
import json,sys; d=json.load(open(sys.argv[1])); b=d["sessions"][0]["tabs"][0]["blocks"][0]; b["live"]=False; json.dump(d,open(sys.argv[1],"w"))
PY2
run1 >/dev/null
ck "expired+listed-not-live: one start" "1" "$(grep -c '^new tab' "$T/log")"
# (d) expired and the daemon cannot be asked => HOLD: no start, a FAIL line, exit 1
fresh; old_pending 100; touch "$T/daemon-down"
rc=$(run1); rm -f "$T/daemon-down"
ck "expired+daemon-down: no start" "0" "$(grep -c '^new tab' "$T/log")"
ck "expired+daemon-down: HOLD printed for a human" "1" "$(grep -c '^HOLD: Manager' "$T/out")"
ck "expired+daemon-down: FAIL line + exit 1" "1" "$rc"
ck "expired+daemon-down: obligation kept" "1" "$(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
# (e) expired with no recorded block id (crash between claim and start) => unprovable => HOLD, no start
fresh; old_pending null; run1 >/dev/null
ck "expired+no-block-id: HOLD, no start" "0" "$(grep -c '^new tab' "$T/log")"
ck "expired+no-block-id: HOLD printed" "1" "$(grep -c '^HOLD: Manager' "$T/out")"
ck "expired+no-block-id: a FAIL line names the HOLD (not only 'not live')" "1" "$(grep -c '^FAIL: Manager: HOLD' "$T/out")"
# (g) r7 TR-R6-P2-1: the recorded block id now runs ANOTHER seat (recycled) => zero action: no rename, journal kept, no start
fresh; old_pending 100; seed "Other Role" "tern acp claude --resume other9999 --model m1"
rc=$(run1)
ck "foreign block: no rename" "0" "$(grep -c '^rename' "$T/log")"
ck "foreign block: no start" "0" "$(grep -c '^new tab' "$T/log")"
ck "foreign block: journal kept" "1" "$(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
ck "foreign block: HOLD names another identity" "1" "$(grep -c "^HOLD: Manager earlier start recorded block 100, which now runs ANOTHER" "$T/out")"
ck "foreign block: exit 1 for a human" "1" "$rc"
ck "foreign block: other tab name untouched" "Other Role" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sessions"][0]["tabs"][0]["name"])' "$FAKE_STATE")"
# (h) unlisted but the daemon's argv is another identity => same zero action
fresh; old_pending 100
python3 - "$FAKE_STATE" <<'PY2'
import json,sys; json.dump({"next":101,"sessions":[{"name":"agenthop","tabs":[]}],"daemon_only":{"100":"tern acp codex --resume zzz"}},open(sys.argv[1],"w"))
PY2
run1 >/dev/null
ck "foreign unlisted: no start, journal kept" "0 1" "$(grep -c '^new tab' "$T/log") $(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
# (h2) same sid but another TOOL (codex vs claude) is another identity
fresh; old_pending 100; seed "Manager" "tern acp codex --resume aaaa1111"
run1 >/dev/null
ck "foreign tool, same sid: no rename/start, journal kept" "0 0 1" "$(grep -c '^rename' "$T/log") $(grep -c '^new tab' "$T/log") $(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
ck "foreign tool, same sid: HOLD" "1" "$(grep -c 'which now runs ANOTHER' "$T/out")"
# (h3) the recorded block exists but its identity cannot be read (compound command) => unknown => HOLD, no rename/start
fresh; old_pending 100; seed "" "tern acp claude --resume aaaa1111 --model m1 && echo x"
run1 >/dev/null
ck "unreadable identity: no rename/start, journal kept" "0 0 1" "$(grep -c '^rename' "$T/log") $(grep -c '^new tab' "$T/log") $(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
ck "unreadable identity: HOLD (cannot be proven)" "1" "$(grep -c '^HOLD: Manager.*cannot be proven alive or gone' "$T/out")"

# (i) positive control: the recorded block is this seat, listed under a wrong tab name => renamed, journal cleared, exit 0
fresh; old_pending 100; seed "" "tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"
printf '5100 1 tern acp claude --resume aaaa1111\n6100 5100 node adapter\n7100 6100 claude --output-format stream-json --resume=aaaa1111\n' >"$T/ps-own"
rc=$(RESTORE_PS="$T/ps-own" python3 "$PY" "$T/one.json" >"$T/out" 2>&1; echo $?)
ck "own block (wrong tab): renamed once" "1" "$(grep -c '^rename 100 Manager' "$T/log")"
ck "own block: journal cleared" "0" "$(ls "$T/pending" 2>/dev/null | wc -l | tr -d ' ')"
ck "own block: exit 0" "0" "$rc"

# (f) a bigger TTL is not the fix: with TTL 0 every entry is "expired" and the alive case still never starts twice
fresh; old_pending 100
python3 - "$FAKE_STATE" <<'PY2'
import json,sys; json.dump({"next":101,"sessions":[{"name":"agenthop","tabs":[]}],"daemon_only":{"100":"tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1"}},open(sys.argv[1],"w"))
PY2
RESTORE_PENDING_TTL_S=0 run1 >/dev/null; RESTORE_PENDING_TTL_S=0 run1 >/dev/null
ck "TTL=0, two runs, block alive unlisted: still zero starts" "0" "$(grep -c '^new tab' "$T/log")"

# ===== r6: presence = ONE-line .pid + .origin sidecar (coordinator re-ruling; every reader parses the whole .pid) =====
cat >"$T/ps" <<'P'
5100 1 tern acp claude --resume aaaa1111
6100 5100 node adapter
7100 6100 claude --output-format stream-json --resume=aaaa1111
5101 1 tern acp claude --resume bbbb2222
6101 5101 node adapter
7101 6101 claude --output-format stream-json --resume=bbbb2222
5102 1 tern acp codex --resume cccc3333
6102 5102 /usr/local/bin/node /opt/Tern/agents/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js
P
fresh; run >/dev/null
ck "presence r6: .pid is exactly one line (what every reader parses)" "1" "$(wc -l <"$T/presence/aaaa1111.pid" | tr -d ' ' | sed 's/^0$/1/')"
ck "presence r6: .pid content is the bare agent pid" "7100" "$(cat "$T/presence/aaaa1111.pid")"
ck "presence r6: readers' Number(trim(file)) parses it" "7100" "$(python3 -c 'import sys;print(int(open(sys.argv[1]).read().strip()))' "$T/presence/aaaa1111.pid")"
ck "presence r6: hook's kill -0 \"\$(cat)\" form works" "0" "$(kill -0 "$(cat "$T/presence/aaaa1111.pid")" 2>/dev/null; [ "$(cat "$T/presence/aaaa1111.pid")" = 7100 ] && echo 0 || echo 1)"
ck "presence r6: sidecar .origin says origin=agent" "1" "$(grep -c '^origin=agent ts=[0-9]*$' "$T/presence/aaaa1111.origin")"
ck "presence r6: no temp left" "0" "$(find "$T/presence" -name '*.tmp-*' | wc -l | tr -d ' ')"
# a live bus record (hook: .pid only, no sidecar) with a different pid: --check WARNs, does not FAIL; a run replaces it
printf '%s' "$$" >"$T/presence/aaaa1111.pid"; rm -f "$T/presence/aaaa1111.origin"
rc=$(run --check); ck "presence r6: live bus pid (no sidecar) => --check exit 0" "0" "$rc"
ck "presence r6: ... reported as WARN" "1" "$(grep -c '^WARN: Manager presence pid' "$T/out")"
printf 'origin=bus ts=1\n' >"$T/presence/aaaa1111.origin"
rc=$(run --check); ck "presence r6: live pid with origin=bus sidecar => WARN, exit 0" "0" "$rc"
run >/dev/null
ck "presence r6: a run replaces the bus pid with the agent pid" "7100" "$(cat "$T/presence/aaaa1111.pid")"
ck "presence r6: ... and the sidecar says origin=agent" "1" "$(grep -c origin=agent "$T/presence/aaaa1111.origin")"
# a DEAD bus pid is not excused
printf '999999' >"$T/presence/aaaa1111.pid"; printf 'origin=bus ts=1\n' >"$T/presence/aaaa1111.origin"
rc=$(run --check); ck "presence r6: dead bus pid => --check exit 1" "1" "$rc"
# right pid but no sidecar (old format): ok, noted
printf '7100' >"$T/presence/aaaa1111.pid"; rm -f "$T/presence/aaaa1111.origin"
rc=$(run --check); ck "presence r6: right pid, no sidecar => --check exit 0" "0" "$rc"
ck "presence r6: ... noted" "1" "$(grep -c 'ok pid 7100 (origin bus/none)' "$T/out")"
# a wrong pid with an origin=agent sidecar is still a FAIL (the label is not trusted over the pid)
printf '999998' >"$T/presence/aaaa1111.pid"; printf 'origin=agent ts=1\n' >"$T/presence/aaaa1111.origin"
rc=$(run --check); ck "presence r6: wrong pid labelled origin=agent => FAIL" "1" "$rc"
# write order: .origin before .pid (a .pid write failure must leave the new origin, never a new pid without its origin)
fresh; mkdir -p "$T/presence"; printf '%s' "$$" >"$T/presence/aaaa1111.pid"; chmod 444 "$T/presence/aaaa1111.pid"; chmod 555 "$T/presence"
run >/dev/null 2>&1; chmod 755 "$T/presence"; chmod 644 "$T/presence/aaaa1111.pid"
ck "presence r6 order: dir not writable => .pid untouched" "$$" "$(cat "$T/presence/aaaa1111.pid")"

# ===== r8 =====
# TR-PENDING-IDENTITY: a block we started, whose identity changes to another seat while we wait => never renamed, journal kept
fresh; touch "$T/swap-identity-after-list"; rc=$(run1); rm -f "$T/swap-identity-after-list"
ck "pending identity: identity changed during the wait => no rename" "0" "$(grep -c '^rename' "$T/log")"
ck "pending identity: journal kept" "1" "$(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"
ck "pending identity: HOLD names another seat" "1" "$(grep -c '^HOLD: Manager pending block .* is another seat' "$T/out")"
ck "pending identity: exit 1" "1" "$rc"
# young (in-TTL) pending entry pointing at a block that is another seat's => no rename, journal kept
fresh; mkdir -p "$T/pending"; printf '{"at": %s, "role": "Manager", "block": 100}' "$(date +%s)" >"$T/pending/aaaa1111.json"
seed "Other Role" "tern acp claude --resume other9999 --mode bypassPermissions --model m1"; run1 >/dev/null
ck "young pending, foreign block: no rename" "0" "$(grep -c '^rename' "$T/log")"
ck "young pending, foreign block: journal kept" "1" "$(ls "$T/pending" 2>/dev/null | grep -c aaaa1111.json)"

# TR-SHELL-NEWLINE: an unquoted newline is a command boundary (checked against the real /bin/sh)
NL="tern acp claude --resume aaaa1111 --mode bypassPermissions --model m1
echo --resume TARGET"
ck "newline: /bin/sh really runs two commands" "2" "$(printf '%s' "$NL" | sed 's/^tern acp claude.*$/echo one/' | /bin/sh | wc -l | tr -d ' ')"
fresh; seed Manager "$NL"; run1 --check >/dev/null
ck "newline: compound-by-newline is not the seat" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
# the reviewer's exact shape: no --resume before the newline, the target sid only AFTER it (shlex alone would glue them)
NL2="tern acp claude --mode bypassPermissions --model m1
echo --resume aaaa1111"
fresh; seed Manager "$NL2"; run1 --check >/dev/null
ck "newline: sid only after an unquoted newline is not the seat" "1" "$(grep -c 'FAIL: Manager: not live' "$T/out")"
fresh; seed Manager "tern acp claude --resume aaaa1111 --mode bypassPermissions \\
 --model m1"; run1 --check >/dev/null
ck "newline: backslash-continuation is still one command (the seat)" "0" "$(grep -c 'FAIL: Manager: not live' "$T/out")"

# mode: roster pins a mode per seat; a launch without it is a FAIL; codex gets INITIAL_AGENT_MODE env, claude --mode
fresh; seed Manager "tern acp claude --resume aaaa1111 --model m1"; run1 --check >/dev/null
ck "mode: claude launch without --mode => FAIL names mode" "1" "$(grep -c "FAIL: Manager: mode None != pinned 'bypassPermissions'" "$T/out")"
printf '{"session":"agenthop","seats":[{"role":"A","tool":"codex","sid":"zz1","cwd":"/tmp/y","model":null,"mode":"agent-full-access"}]}' >"$T/cxm.json"
fresh; seed A "env INITIAL_AGENT_MODE=agent-full-access tern acp codex --resume zz1"
python3 "$PY" "$T/cxm.json" --check >"$T/out" 2>&1
ck "mode: codex env-prefixed launch is the seat (not 'not live')" "0" "$(grep -c 'FAIL: A: not live' "$T/out")"
ck "mode: codex env mode matches pin (no mode FAIL)" "0" "$(grep -c 'FAIL: A: mode' "$T/out")"
fresh; seed A "env INITIAL_AGENT_MODE=\$X tern acp codex --resume zz1"; python3 "$PY" "$T/cxm.json" --check >"$T/out" 2>&1
ck "mode: env with an expansion is not provable => not the seat" "1" "$(grep -c 'FAIL: A: not live' "$T/out")"
printf '{"session":"agenthop","seats":[{"role":"A","tool":"codex","sid":"zz1","cwd":"/tmp/y","model":null,"mode":"bypassPermissions"}]}' >"$T/bad.json"
rc=$(python3 "$PY" "$T/bad.json" >/dev/null 2>&1; echo $?); ck "mode: a claude mode on a codex seat => roster exit 2" "2" "$rc"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
