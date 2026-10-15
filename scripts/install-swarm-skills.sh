#!/usr/bin/env bash
# install-swarm-skills.sh - copy the repo's swarm skills into the Claude Code skills dir.
#
# Source of truth: docs/swarm/skills/<name>/ (one dir per skill, each with SKILL.md), versioned with the repo.
# Target: ${SWARM_SKILLS_DIR:-$HOME/.claude/skills}/<name>/. Idempotent: a skill whose installed copy is already
# identical is left alone; a changed one is replaced through a staging dir + rename, so a reader never sees half a skill.
# If the final rename fails, the previous installation is renamed back to its own path; if that also fails, both copies
# are kept (paths printed) and the exit code is 1. Staging/hold dirs come from mktemp -d; nothing else is removed.
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
  # temp paths are created exclusively by mktemp for THIS run; only they are ever removed (never a pre-existing path)
  stage=$(mktemp -d "$DST/.$name.new.XXXXXX") || { echo "FAILED $name: cannot create a staging dir; $t untouched"; rc=1; continue; }
  if ! { cp -R "$dir/." "$stage/" && chmod 755 "$stage"; }; then rm -rf "$stage"; echo "FAILED $name: cannot stage a copy; $t untouched"; rc=1; continue; fi
  hold=""
  if [ -e "$t" ]; then
    hold=$(mktemp -d "$DST/.$name.old.XXXXXX") || { rm -rf "$stage"; echo "FAILED $name: cannot create a hold dir; $t untouched"; rc=1; continue; }
    if ! mv "$t" "$hold/prev"; then rm -rf "$stage"; rmdir "$hold"; echo "FAILED $name: cannot move the old copy aside; $t untouched"; rc=1; continue; fi
  fi
  if ! mv "$stage" "$t"; then
    # publication failed: put the previous installation back at its own path (same inode), never leave the name absent
    if [ -n "$hold" ] && ! mv "$hold/prev" "$t"; then
      echo "FAILED $name: publish AND rollback failed; previous copy kept at $hold/prev, new copy at $stage"; rc=1; continue
    fi
    rm -rf "$stage"; [ -z "$hold" ] || rmdir "$hold"
    echo "FAILED $name: cannot publish; previous installation restored at $t"; rc=1; continue
  fi
  [ -z "$hold" ] || rm -rf "$hold"
  echo "installed $name -> $t"
done
[ "$n" -gt 0 ] || { echo "no skills found under $SRC" >&2; exit 2; }
exit $rc
