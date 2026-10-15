#!/usr/bin/env bash
# One-command Tern seat restore. Reads tern/restore/roster.json, starts only missing seats, asserts via `tern ls --json`.
# Never writes ~/.claude.json (posture is read-only: present/ABSENT + a hint). `--check` = assert only, start nothing.
exec python3 "$(cd "$(dirname "$0")/.." && pwd)/tern/restore/tern-restore.py" "${ROSTER:-$(cd "$(dirname "$0")/.." && pwd)/tern/restore/roster.json}" "$@"
