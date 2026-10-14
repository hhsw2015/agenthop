#!/usr/bin/env lua
-- Fixture for the A8 16 KiB JSON cap. Lua 5.5. Loads the PRODUCTION budget module (../budget.luau) via loadfile --
-- the SAME file window.luau does require("./budget") on, so there is no mirror copy: a change to the cap turns these
-- checks RED and changes production together (the agenthop-agents-bridge "one source, no drift" rule).
--
-- Proves, for each export shape, that at the 16 KiB boundary the result is trimmed to <= 16 KiB and carries
-- truncated:true, and that a within-budget result is returned untouched with no truncated flag.
--
-- Run from the plugin dir:  lua test/budget.test.lua   (or: luajit test/budget.test.lua)

local here = (arg[0] or ""):match("^(.*/)") or "./"
local budget = assert(loadfile(here .. "../budget.luau"))()

local failures = 0
local function ck(name, cond)
  print((cond and "ok   - " or "FAIL - ") .. name)
  if not cond then
    failures = failures + 1
  end
end

-- ---- a representative JSON encoder, used both to DRIVE fit and to MEASURE size (so the <= BUDGET guarantee holds
-- by construction; production ships with tern.json.encode, same algorithm) --------------------------------------
local function isArray(t)
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" then
      return false
    end
    n = n + 1
  end
  for i = 1, n do
    if t[i] == nil then
      return false
    end
  end
  return true, n
end

local ESC = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function jenc(v)
  local tv = type(v)
  if v == nil then
    return "null"
  elseif tv == "boolean" then
    return v and "true" or "false"
  elseif tv == "number" then
    if v == math.floor(v) then
      return string.format("%d", v)
    end
    return tostring(v)
  elseif tv == "string" then
    local s = v:gsub('[%z\1-\31\\"]', function(c)
      return ESC[c] or string.format("\\u%04x", string.byte(c))
    end)
    return '"' .. s .. '"'
  elseif tv == "table" then
    local arr, n = isArray(v)
    if arr then
      local parts = {}
      for i = 1, n do
        parts[i] = jenc(v[i])
      end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do
      keys[#keys + 1] = k
    end
    table.sort(keys, function(a, b)
      return tostring(a) < tostring(b)
    end)
    local parts = {}
    for _, k in ipairs(keys) do
      parts[#parts + 1] = '"' .. tostring(k) .. '":' .. jenc(v[k])
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local B = budget.BUDGET
ck("BUDGET is 16 KiB (16384)", B == 16384)

local function mkSeat(i)
  return {
    id = string.format("session-%08d-aaaa-bbbb-cccc-dddddddddddd", i),
    title = "Seat " .. i .. " working on a task with a reasonably long descriptive title",
    herdrState = "working",
    inboxDepth = 0,
    task = "Seat " .. i .. " working on a task with a reasonably long descriptive title",
  }
end

-- 1) within budget: untouched, no truncated flag
do
  local seats = {}
  for i = 1, 3 do
    seats[i] = mkSeat(i)
  end
  local result = { seats = seats, ts = 123 }
  budget.fitArray(result, "seats", jenc)
  ck("within-budget array left untouched (3 seats kept)", #result.seats == 3)
  ck("within-budget array has NO truncated flag", result.truncated == nil)
  ck("within-budget array encodes <= BUDGET", #jenc(result) <= B)
end

-- 2) over budget (array, drop from END): trimmed to <= BUDGET, truncated=true, maximal retention
do
  local seats = {}
  for i = 1, 500 do
    seats[i] = mkSeat(i)
  end
  local result = { seats = seats, ts = 123 }
  local over = #jenc(result)
  ck("array fixture really exceeds BUDGET before fit (" .. over .. " > " .. B .. ")", over > B)
  budget.fitArray(result, "seats", jenc)
  ck("array fitted to <= BUDGET", #jenc(result) <= B)
  ck("array sets truncated=true", result.truncated == true)
  ck("array dropped some seats", #result.seats < 500 and #result.seats > 0)
  -- maximal retention: adding one more seat back would exceed the budget
  result.seats[#result.seats + 1] = mkSeat(99999)
  ck("array retention is maximal (one more seat would exceed BUDGET)", #jenc(result) > B)
end

-- 3) over budget (array, keepTail => drop from FRONT, keep NEWEST): used by swarm_progress
do
  local cycles = {}
  for i = 1, 400 do
    local lines = {}
    for j = 1, 6 do
      lines[j] = "cycle " .. i .. " line " .. j .. " some progress content text here"
    end
    cycles[i] = { num = i, title = "cycle " .. i, lines = lines }
  end
  local result = { cycles = cycles, ts = 123 }
  ck("cycles fixture exceeds BUDGET before fit", #jenc(result) > B)
  budget.fitArray(result, "cycles", jenc, nil, true)
  ck("cycles fitted to <= BUDGET", #jenc(result) <= B)
  ck("cycles sets truncated=true", result.truncated == true)
  -- kept cycles must be the NEWEST (a contiguous suffix ending at 400)
  local kept = result.cycles
  local suffixOk = (#kept > 0) and (kept[#kept].num == 400)
  for idx = 2, #kept do
    if kept[idx].num ~= kept[idx - 1].num + 1 then
      suffixOk = false
    end
  end
  ck("cycles kept the NEWEST contiguous suffix (ends at #400)", suffixOk)
end

-- 4) over budget (map => drop keys): used by swarm_flags
do
  local flags = {}
  for i = 1, 3000 do
    flags[string.format("FLAG_%04d", i)] = "on"
  end
  local result = { flags = flags, ts = 123 }
  ck("flags fixture exceeds BUDGET before fit", #jenc(result) > B)
  budget.fitMap(result, "flags", jenc)
  ck("flags fitted to <= BUDGET", #jenc(result) <= B)
  ck("flags sets truncated=true", result.truncated == true)
  local n = 0
  for _ in pairs(result.flags) do
    n = n + 1
  end
  ck("flags dropped some keys", n < 3000 and n > 0)
end

-- 5) within-budget flags map untouched
do
  local result = { flags = { BOARD_ADMIT = "on", TG_ENTRY = "dormant" }, ts = 123 }
  budget.fitMap(result, "flags", jenc)
  ck("within-budget map has NO truncated flag", result.truncated == nil)
end

print("")
if failures == 0 then
  print("PASS (0 failures)")
  os.exit(0)
else
  print("FAIL (" .. failures .. " failure(s))")
  os.exit(1)
end
