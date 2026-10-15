#!/usr/bin/env bash
# install-swarm-skills.sh - copy the repo's swarm skills into the Claude Code skills dir.
#
# Source of truth: docs/swarm/skills/<name>/ (one dir per skill, each with SKILL.md), versioned with the repo.
# Target: ${SWARM_SKILLS_DIR:-$HOME/.claude/skills}/<name>/. Idempotent: a skill whose installed copy is already
# identical is left alone; a changed one is replaced through a staging dir + rename, so a reader never sees half a skill.
# Only <name> dirs that this repo ships are touched; other skills in the target are never read or removed.
# A target <name> that is a symlink (someone else's install) is refused, not replaced.
#
# Usage: scripts/install-swarm-skills.sh [--dry]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/docs/swarm/skills"
DST="${SWARM_SKILLS_DIR:-$HOME/.claude/skills}"
DRY=0
case "${1:-}" in --dry) DRY=1;; "") ;; *) echo "usage: $0 [--dry]" >&2; exit 2;; esac
[ -d "$SRC" ] || { echo "no skills dir: $SRC" >&2; exit 2; }
[ "$DRY" = 1 ] || mkdir -p "$DST"
rc=0; n=0
for dir in "$SRC"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/SKILL.md" ] || { echo "skip $name: no SKILL.md"; continue; }
  n=$((n + 1)); t="$DST/$name"
  if [ -L "$t" ]; then echo "REFUSED $name: $t is a symlink (not ours), left untouched"; rc=1; continue; fi
  if [ -d "$t" ] && diff -r -q "$dir" "$t" >/dev/null 2>&1; then echo "ok $name: up to date"; continue; fi
  if [ "$DRY" = 1 ]; then echo "would install $name -> $t"; continue; fi
  stage="$DST/.$name.new.$$"; old="$DST/.$name.old.$$"
  rm -rf "$stage"; cp -R "$dir" "$stage"
  [ -e "$t" ] && mv "$t" "$old"
  mv "$stage" "$t"; rm -rf "$old"
  echo "installed $name -> $t"
done
[ "$n" -gt 0 ] || { echo "no skills found under $SRC" >&2; exit 2; }
exit $rc
