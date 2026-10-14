#!/usr/bin/env sh
# Regenerate the Carly review + runbook board projections from durable swarm facts (A4/A5). Idempotent; cron-safe ("* * * * *") or manual.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
exec lua "$DIR/generate.lua" "$@"
