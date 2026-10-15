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
open(os.environ["FAKE_LOG"], "a").write(" ".join(a) + "\n")
if a[:2] == ["ls", "--json"]:
    print(json.dumps({"sessions": d["sessions"], "detached": []}))
elif a[:2] == ["new", "tab"]:
    cmd = a[a.index("--") + 1:]
    bid = d["next"]; d["next"] += 1
    d["sessions"][0]["tabs"].append({"name": None, "blocks": [{"id": bid, "live": True, "exited": None,
        "cwd": a[a.index("--cwd") + 1], "command": " ".join(shlex.quote(x) for x in cmd)}]})
    print(bid)
elif a[0] == "rename":
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
: >"$T/ps"
export TERN_BIN="$T/tern" FAKE_STATE="$T/state.json" FAKE_LOG="$T/log" CLAUDE_JSON="$T/claude.json" RESTORE_PS="$T/ps"
run() { python3 "$PY" "$T/roster.json" "$@" >"$T/out" 2>&1; echo $?; }
starts() { grep -c '^new tab' "$T/log" 2>/dev/null || true; }

# --- cold start ---
rc=$(run); ck "cold: exit 0" "0" "$rc"
ck "cold: 3 seats started" "3" "$(starts)"
ck "cold: result 3/3" "1" "$(grep -c 'result: 3/3' "$T/out")"
ck "cold: claude seat gets bypass mode" "1" "$(grep -c 'new tab agenthop --cwd /tmp/x -- tern acp claude --resume aaaa1111 --mode bypassPermissions --model cpa-local/claude-fable-5-1\[1m\]' "$T/log")"
ck "cold: codex seat has no model/mode flags" "1" "$(grep -c -- '-- tern acp codex --resume cccc3333$' "$T/log")"
ck "cold: tabs renamed to roles" "3" "$(grep -c '^rename ' "$T/log")"

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
echo "123 codex resume cccc3333 --foo" >"$T/ps"
run --check >/dev/null
ck "codex: outside holder reported" "1" "$(grep -c 'codex-exclusive: Chief Review' "$T/out")"

# --- bad roster => exit 2 ---
echo '{}' >"$T/bad.json"; rc=$(python3 "$PY" "$T/bad.json" >/dev/null 2>&1; echo $?); ck "bad roster: exit 2" "2" "$rc"

if [ "$fails" -eq 0 ]; then echo; echo "PASS (0 failures)"; else echo; echo "FAIL ($fails failure(s))"; fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
