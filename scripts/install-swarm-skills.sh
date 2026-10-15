#!/usr/bin/env bash
# Install the swarm role skills from this repo into Claude Code's user skills dir, so any Claude session in any directory can run
# /coordinator or /swarm-member. Codex seats have no skills mechanism: their handoff letter names the same SKILL.md path to read.
#   scripts/install-swarm-skills.sh [dest]     dest defaults to ~/.claude/skills
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/docs/swarm/skills"
dest="${1:-$HOME/.claude/skills}"
for name in coordinator swarm-member; do
  if [ ! -f "$src/$name/SKILL.md" ]; then echo "skip $name: $src/$name/SKILL.md not in this checkout"; continue; fi
  mkdir -p "$dest/$name"
  cp "$src/$name/SKILL.md" "$dest/$name/SKILL.md.new"
  mv "$dest/$name/SKILL.md.new" "$dest/$name/SKILL.md"
  echo "installed $name -> $dest/$name/SKILL.md"
done
