#!/usr/bin/env lua
-- tern-board entrypoint (A4/A5): regenerate BOTH Carly board md files from durable swarm facts. Standalone Lua 5.5 (needs git + stat).
-- Idempotent full-rewrite projection; safe to cron or run manually via generate.sh. Env: AGENTHOP_REPO (git checkout for ancestry;
-- default ~/Dev/agenthop), RETRO_REVIEW_REPORTS_DIR (default ~/Work/review-reports), HOME.
local here = (arg[0] or ""):match("^(.*/)") or "./"
package.path = here .. "?.luau;" .. package.path
local R = require("board-run")
local home = os.getenv("HOME") or ""
local repo = os.getenv("AGENTHOP_REPO") or (home .. "/Dev/agenthop")
local res = R.run(R.default_deps(home, repo))
print(string.format("tern-board: wrote review=%s runbook=%s | Queued=%d Reviewing=%d Needs-human=%d Merged=%d | batches=%d",
  tostring(res.wrote_review), tostring(res.wrote_runbook),
  res.counts.Queued or 0, res.counts.Reviewing or 0, res.counts["Needs-human"] or 0, res.counts.Merged or 0, res.batches))
os.exit((res.wrote_review and res.wrote_runbook) and 0 or 1)
