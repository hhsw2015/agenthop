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
    f = T + "/list-delay-3"
    if os.path.exists(f):
        d.setdefault("hidden", {})[str(bid)] = 3
    d["sessions"][0]["tabs"].append({"name": None, "blocks": [{"id": bid, "live": True, "exited": None,
        "cwd": a[a.index("--cwd") + 1], "command": " ".join(shlex.quote(x) for x in cmd)}]})
    print(bid)
elif a[0] == "process":
    print(json.dumps({"child": {"pid": 5000 + int(a[1])}}))
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
6102 5102 node codex-adapter
P
export PRESENCE_DIR="$T/presence" RESTORE_WAIT_S=1 SEAT_SHELL_CMD="$T/seatshell"
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
ck "cold: codex seat has no model/mode flags" "1" "$(grep -c -- '-- tern acp codex --resume cccc3333$' "$T/log")"
ck "cold: tabs renamed to roles" "3" "$(grep -c '^rename ' "$T/log")"

ck "seat-shell: set called on cold run with tern+pid" "1" "$(grep -c '^set aaaa1111 tern 7100$' "$T/seatshell.log")"
ck "seat-shell: one set per seat" "3" "$(wc -l <"$T/seatshell.log" | tr -d ' ')"
ck "presence: Manager -> its own claude pid" "7100" "$(cat "$T/presence/aaaa1111.pid")"
ck "presence: Infra Dev -> its own claude pid" "7101" "$(cat "$T/presence/bbbb2222.pid")"
ck "presence: codex -> adapter child pid" "6102" "$(cat "$T/presence/cccc3333.pid")"
ck "presence: no leftover temp" "0" "$(find "$T/presence" -name '*.tmp-*' | wc -l | tr -d ' ')"

# --- presence SWAPPED (live pids, wrong seats) is detected by --check and fixed by a run ---
printf '7101' >"$T/presence/aaaa1111.pid"; printf '7100' >"$T/presence/bbbb2222.pid"
rc=$(run --check); ck "swap: --check exit 1" "1" "$rc"; ck "swap: --check names both" "2" "$(grep -c 'presence pid' "$T/out")"
ck "swap: --check does not write" "7101" "$(cat "$T/presence/aaaa1111.pid")"
rc=$(run); ck "swap: run fixes, exit 0" "0" "$rc"
ck "swap: Manager corrected" "7100" "$(cat "$T/presence/aaaa1111.pid")"; ck "swap: Infra corrected" "7101" "$(cat "$T/presence/bbbb2222.pid")"

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
fresh() { rm -f "$FAKE_STATE"; : >"$T/log"; rm -rf "$T/presence"; }
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
fresh; seed "" "tern acp claude --resume aaaa1111 --model m1"; rc=$(run1)
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

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
