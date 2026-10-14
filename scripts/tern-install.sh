#!/usr/bin/env bash
# tern-install.sh — idempotent installer for the two official swarm Tern plugins.
#
# Installs, in a FIXED SERIAL ORDER (never concurrently):
#   1. agenthop-agents-bridge   (tern/agenthop-agents-bridge)
#   2. agenthop-board           (tern/board)
#
# Why serial: `tern plugin link` rewrites the shared plugins directory, so two links
# running at once drop each other's plugin. This script links one plugin at a time and
# verifies it loaded cleanly before moving to the next, under a single-process lock so a
# second invocation can't race it either.
#
# Discipline:
#   - Never half-installs: any verify failure stops immediately with a clear error.
#   - Idempotent: a plugin already loaded cleanly is skipped; re-running is harmless.
#   - G3 gate: this script DOES NOT change the auto_update setting. It only reports the
#     current value. Flipping auto_update -> controlled restart_to_update is G3's own
#     gated step (master-plan §H, NOT-READY), not this installer's job.
#
# Usage:
#   scripts/tern-install.sh            install (serial, verified, idempotent)
#   scripts/tern-install.sh --dry      preview only: no link, no reload, no writes
#   scripts/tern-install.sh --help     this header
#
# Env overrides (for testing): TERN_BIN (tern binary), TERN_CONFIG_DIR (honored by tern).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TERN="${TERN_BIN:-tern}"

# Fixed serial order. Index i pairs PLUGIN_IDS[i] with PLUGIN_DIRS[i].
PLUGIN_IDS=(agenthop-agents-bridge agenthop-board)
PLUGIN_DIRS=("$REPO_ROOT/tern/agenthop-agents-bridge" "$REPO_ROOT/tern/board")

DRY=0
for a in "${@:-}"; do
  case "$a" in
    --dry|--dry-run) DRY=1 ;;
    -h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    "") ;;
    *) printf 'tern-install: unknown argument: %s\n' "$a" >&2; exit 2 ;;
  esac
done

log(){ printf '%s\n' "$*"; }
die(){ printf 'tern-install: %s\n' "$*" >&2; exit 1; }

command -v "$TERN" >/dev/null 2>&1 || die "tern binary not found: '$TERN' (set TERN_BIN?)"

PLUGINS_DIR="$("$TERN" plugin dir 2>/dev/null)" || die "cannot resolve 'tern plugin dir'"
[ -n "$PLUGINS_DIR" ] || die "'tern plugin dir' returned empty"

# --- G3 auto_update: read-only report, never written ---
report_auto_update(){
  local sj
  if [ -n "${TERN_CONFIG_DIR:-}" ]; then
    sj="$TERN_CONFIG_DIR/settings.json"
  else
    sj="$(dirname "$PLUGINS_DIR")/settings.json"
  fi
  local val="(settings.json not found: $sj)"
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
  log "    cross-update gate is NOT-READY; flipping auto_update -> controlled restart_to_update is G3's gated step, not this installer's."
}

# --- verify: $1 is loaded AND the plugin directory has no problems; else fail-stop ---
verify_plugin(){
  local id="$1" out
  out="$("$TERN" plugin list --json 2>/dev/null)" || die "verify [$id]: 'tern plugin list --json' failed"
  python3 - "$id" "$out" <<'PY' \
    || die "verify [$id]: not loaded cleanly — stopping before the next plugin (no half-install)"
import json, sys
want = sys.argv[1]
try:
    d = json.loads(sys.argv[2])
except Exception as e:
    print("list --json not parseable: %s" % e, file=sys.stderr); sys.exit(1)
ids = {p.get("id") for p in d.get("plugins", []) if isinstance(p, dict)}
problems = d.get("problems", [])
if want not in ids:
    print("plugin %r is not loaded (loaded: %s)" % (want, sorted(i for i in ids if i)), file=sys.stderr)
    sys.exit(1)
if problems:
    print("plugin directory reports problems: %s" % problems, file=sys.stderr)
    sys.exit(1)
PY
}

# --- is $1 already loaded with no problems? (idempotent skip) ---
loaded_clean(){
  local id="$1" out
  out="$("$TERN" plugin list --json 2>/dev/null)" || return 1
  python3 - "$id" "$out" <<'PY'
import json, sys
want = sys.argv[1]
try:
    d = json.loads(sys.argv[2])
except Exception:
    sys.exit(1)
ids = {p.get("id") for p in d.get("plugins", []) if isinstance(p, dict)}
sys.exit(0 if (want in ids and not d.get("problems", [])) else 1)
PY
}

log "tern-install: plugins dir = $PLUGINS_DIR"
report_auto_update

if [ "$DRY" -eq 1 ]; then
  log "--dry: previewing only (no link, no reload, no writes)."
  for i in "${!PLUGIN_IDS[@]}"; do
    id="${PLUGIN_IDS[$i]}"; dir="${PLUGIN_DIRS[$i]}"
    [ -f "$dir/plugin.toml" ] || die "plugin source missing: $dir/plugin.toml"
    if loaded_clean "$id"; then
      log "  [$((i+1))/${#PLUGIN_IDS[@]}] $id — already loaded cleanly, WOULD SKIP"
    else
      log "  [$((i+1))/${#PLUGIN_IDS[@]}] $id — WOULD link $dir, then verify"
    fi
  done
  exit 0
fi

# --- single-process lock so a second invocation can't race the shared plugins dir ---
LOCK="$PLUGINS_DIR/.tern-install.lock"
mkdir "$PLUGINS_DIR" 2>/dev/null || true
if ! mkdir "$LOCK" 2>/dev/null; then
  die "another tern-install appears to be running (lock: $LOCK). Re-run once it finishes."
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

for i in "${!PLUGIN_IDS[@]}"; do
  id="${PLUGIN_IDS[$i]}"; dir="${PLUGIN_DIRS[$i]}"
  step="[$((i+1))/${#PLUGIN_IDS[@]}]"
  [ -f "$dir/plugin.toml" ] || die "$step plugin source missing: $dir/plugin.toml"
  if loaded_clean "$id"; then
    log "$step $id — already loaded cleanly, skipping (idempotent)."
    continue
  fi
  log "$step $id — linking $dir"
  "$TERN" plugin link "$dir" >/dev/null 2>&1 || die "$step 'tern plugin link $dir' failed"
  verify_plugin "$id"
  log "$step $id — linked and verified."
done

log "tern-install: done. Both plugins loaded and verified."
