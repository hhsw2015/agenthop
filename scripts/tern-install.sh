#!/usr/bin/env bash
# tern-install.sh — installer for the official swarm Tern plugin(s), with a real load proof.
#
# Installs, in a FIXED SERIAL ORDER (never concurrently), under a single-process lock:
#   1. agenthop-agents-bridge   (tern/agenthop-agents-bridge)
# tern/board is NOT a Tern plugin (standalone lua generator; Tern only views its md) and is not installed.
#
# PRODUCTION RULE: the live Tern runs only an INSTALLED COPY (`tern plugin install`), never a link, and the copy's
# source commit is recorded in <plugins dir>/<id>.installed-sha. `tern plugin link` is for development only: this
# script never links, and it refuses to replace an existing link.
#
# THE TERN DAEMON IS GLOBAL. TERN_CONFIG_DIR does NOT isolate the CLI from the running daemon: `tern plugin install`,
# `reload` and `ctl plugins run` all act on the live Tern (an accidental live reload happened this way at 13:37:27
# on 2026-10-15). So:
#   - the default run is a DRY RUN that changes nothing;
#   - only `--live` installs. It prints that it will reload the live daemon before doing anything;
#   - offline/failure tests of this script run against a FAKE `tern` (TERN_BIN) only.
#
# LOAD PROOF. `tern plugin list` falls back to reading the plugins DIRECTORY when the daemon is unreachable and still
# reports "ready", so it is not proof that anything loaded. After install + reload, the script runs the plugin's
# `mirror` command and requires agents.json to be rewritten by the reloaded instance (its `vm` id differs from the
# one before, or the file is written after the reload), and checks tern.log since the reload for
# `failed to load` / `exceeded its budget` lines for this plugin. Results:
#   exit 0  loaded and proven
#   exit 1  failed (install/reload error, load failure in tern.log, or a stopped step)
#   exit 2  UNKNOWN: installed, but the load could not be proven — never reported as installed-and-loaded
#
# Other rules: never half-installs (any failure stops before the next plugin); a plugin whose installed copy already
# matches this checkout's commit is skipped (idempotent); G3: auto_update is only REPORTED, never changed (flipping it
# to a controlled restart_to_update is G3's own gated step, master-plan §H).
#
# Usage:
#   scripts/tern-install.sh            dry run: show what --live would do (default; no install, no reload, no writes)
#   scripts/tern-install.sh --live     install the copy, reload the live daemon, prove the load
#   scripts/tern-install.sh --help     this header
#
# Env (testing only): TERN_BIN (a fake tern), TERN_CONFIG_DIR, BRIDGE_CTRL_DIR (agents.json dir), TERN_LOG,
# PROOF_WAIT (seconds to wait for the proof, default 3).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TERN="${TERN_BIN:-tern}"
CTRL="${BRIDGE_CTRL_DIR:-$HOME/.agenthop/tern-panes}"
TERN_LOG="${TERN_LOG:-$HOME/Library/Logs/Tern/tern.log}"
PROOF_WAIT="${PROOF_WAIT:-3}"

# Fixed serial order. Index i pairs PLUGIN_IDS[i] with PLUGIN_DIRS[i].
PLUGIN_IDS=(agenthop-agents-bridge)
PLUGIN_DIRS=("$REPO_ROOT/tern/agenthop-agents-bridge")

LIVE=0
for a in "${@:-}"; do
  case "$a" in
    --live) LIVE=1 ;;
    --dry|--dry-run) LIVE=0 ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    "") ;;
    *) printf 'tern-install: unknown argument: %s\n' "$a" >&2; exit 2 ;;
  esac
done

log(){ printf '%s\n' "$*"; }
die(){ printf 'tern-install: %s\n' "$*" >&2; exit 1; }
unknown(){ printf 'tern-install: UNKNOWN — %s\n' "$*" >&2; exit 2; }

command -v "$TERN" >/dev/null 2>&1 || die "tern binary not found: '$TERN' (set TERN_BIN?)"
PLUGINS_DIR="$("$TERN" plugin dir 2>/dev/null)" || die "cannot resolve 'tern plugin dir'"
[ -n "$PLUGINS_DIR" ] || die "'tern plugin dir' returned empty"

# --- G3 auto_update: read-only report, never written ---
report_auto_update(){
  local sj val
  if [ -n "${TERN_CONFIG_DIR:-}" ]; then sj="$TERN_CONFIG_DIR/settings.json"; else sj="$(dirname "$PLUGINS_DIR")/settings.json"; fi
  val="(settings.json not found: $sj)"
  if [ -f "$sj" ]; then
    val="$(python3 - "$sj" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("(unreadable: %s)" % e); sys.exit(0)
v = d.get("auto_update")
print("unset (absent)" if v is None else json.dumps(v))
PY
)"
  fi
  log "G3 auto_update (read-only — NOT modified here): $val"
}

# Commit of the plugin source in this checkout (dirty tree => the commit plus "-dirty", and --live refuses).
source_sha(){
  local dir="$1" sha
  sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null)" || { echo "unknown"; return; }
  if [ -n "$(git -C "$dir" status --porcelain -- . 2>/dev/null)" ]; then echo "$sha-dirty"; else echo "$sha"; fi
}

# State of one plugin in the plugins dir: "link:<src>" | "copy:<sha or unrecorded>" | "absent"
installed_state(){
  local id="$1"
  if [ -f "$PLUGINS_DIR/$id.path" ]; then echo "link:$(cat "$PLUGINS_DIR/$id.path")"
  elif [ -d "$PLUGINS_DIR/$id" ]; then
    if [ -f "$PLUGINS_DIR/$id.installed-sha" ]; then echo "copy:$(cat "$PLUGINS_DIR/$id.installed-sha")"; else echo "copy:unrecorded"; fi
  else echo "absent"; fi
}

json_field(){ # $1 file, $2 jq expr
  jq -r "$2 // empty" "$1" 2>/dev/null || true
}

# Load proof after reload. $1 = id, $2 = vm before, $3 = ISO time of the reload.
prove_loaded(){
  local id="$1" vm_before="$2" since="$3" out vm_after i
  # tern.log since the reload: any load failure or budget kill for this plugin => FAIL
  if [ -r "$TERN_LOG" ]; then
    out="$(python3 - "$TERN_LOG" "$since" "$id" <<'PY'
import datetime, re, sys
log, since, pid = sys.argv[1:4]
t0 = datetime.datetime.fromisoformat(since).timestamp()
bad = []
for line in open(log, errors="replace"):
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)", line)
    if not m:
        continue
    ts = m.group(1).replace("Z", "+00:00")
    try:
        t = datetime.datetime.fromisoformat(ts)
        t = (t if t.tzinfo else t.astimezone()).timestamp()
    except ValueError:
        continue
    if t >= t0 and f'plugin="{pid}"' in line and ("failed to load" in line or "exceeded its budget" in line):
        bad.append(line.strip()[:200])
print("\n".join(bad))
PY
)" || unknown "could not scan $TERN_LOG"
    [ -z "$out" ] || die "$id did not load cleanly after reload (tern.log): $out"
  else
    log "  note: $TERN_LOG not readable; load proof rests on agents.json only"
  fi
  # the reloaded instance must write agents.json: drive one mirror, then require a new vm
  timeout 5 "$TERN" ctl plugins run "plugin.$id.mirror" >/dev/null 2>&1 \
    || unknown "\`tern ctl plugins run plugin.$id.mirror\` failed: the daemon may be unreachable; load not proven"
  for ((i = 0; i < PROOF_WAIT * 10; i++)); do
    vm_after="$(json_field "$CTRL/agents.json" '.vm')"
    if [ -n "$vm_after" ] && [ "$vm_after" != "$vm_before" ]; then
      log "  load proven: agents.json written by the reloaded instance (vm ${vm_before:-none} -> $vm_after)"
      return 0
    fi
    sleep 0.1
  done
  unknown "$id installed, but no agents.json write from a reloaded instance within ${PROOF_WAIT}s (vm still ${vm_after:-none}); load not proven"
}

log "tern-install: plugins dir = $PLUGINS_DIR"
report_auto_update

plan=()
for i in "${!PLUGIN_IDS[@]}"; do
  id="${PLUGIN_IDS[$i]}"; dir="${PLUGIN_DIRS[$i]}"
  step="[$((i+1))/${#PLUGIN_IDS[@]}]"
  [ -f "$dir/plugin.toml" ] || die "$step plugin source missing: $dir/plugin.toml"
  want="$(source_sha "$dir")"; have="$(installed_state "$id")"
  case "$have" in
    link:*) die "$step $id is LINKED from ${have#link:}. Production runs an installed copy only; not replacing someone's link. Run \`tern plugin unlink $id\` first if that is intended." ;;
    "copy:$want") log "$step $id — installed copy already at $want, skipping (idempotent)." ;;
    *) log "$step $id — WOULD install a copy of $dir at $want (now: $have), then reload the live daemon and prove the load"
       plan+=("$i") ;;
  esac
done

if [ "$LIVE" -eq 0 ]; then
  log "dry run: nothing installed, nothing reloaded. Re-run with --live to do the steps above."
  exit 0
fi
[ "${#plan[@]}" -eq 0 ] && { log "tern-install: nothing to do."; exit 0; }

log "*** --live: this WILL install into $PLUGINS_DIR and RELOAD THE LIVE TERN DAEMON (all plugins restart). ***"

LOCK="$PLUGINS_DIR/.tern-install.lock"
mkdir "$LOCK" 2>/dev/null || die "another tern-install appears to be running (lock: $LOCK). Re-run once it finishes."
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

for i in "${plan[@]}"; do
  id="${PLUGIN_IDS[$i]}"; dir="${PLUGIN_DIRS[$i]}"; step="[$((i+1))/${#PLUGIN_IDS[@]}]"
  want="$(source_sha "$dir")"
  case "$want" in unknown|*-dirty) die "$step $dir has no clean commit ($want); production installs only committed sources" ;; esac
  vm_before="$(json_field "$CTRL/agents.json" '.vm')"
  since="$(python3 -c 'import datetime; print(datetime.datetime.now().astimezone().isoformat())')"
  log "$step $id — installing a copy at $want"
  "$TERN" plugin install "$dir" --force >/dev/null 2>&1 || die "$step 'tern plugin install $dir --force' failed"
  printf '%s\n' "$want" >"$PLUGINS_DIR/$id.installed-sha" || die "$step could not record $PLUGINS_DIR/$id.installed-sha"
  "$TERN" plugin reload >/dev/null 2>&1 || die "$step 'tern plugin reload' reported a failing plugin or directory problem"
  prove_loaded "$id" "$vm_before" "$since"
  log "$step $id — installed, reloaded, load proven."
done

log "tern-install: done. All plugins installed and their load proven."
