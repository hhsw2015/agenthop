-- budget — the shared 16 KiB JSON cap for every A8 export (contract section 2: "16KiB JSON upper bound => each
-- function carries a truncated:true field").
--
-- Pure. No reference to the `tern` global: the JSON encoder is INJECTED (production passes tern.json.encode; the
-- fixture passes a plain-Lua encoder), so this single file is loaded by BOTH window.luau (Luau, via require) AND
-- test/budget.test.lua (Lua 5.5, via loadfile) with no mirror copy — a change to the cap turns the test RED and
-- changes production together, matching the agenthop-agents-bridge "one source, no drift" rule.
--
-- Written in the Lua 5.1/5.5 and Luau subset: ipairs/pairs only, string.find plain, no += , no generalized-for,
-- no type annotations, no continue/goto.

local M = {}

-- The Tern plugin document limit. A serialized export result must not exceed this many bytes.
M.BUDGET = 16 * 1024 -- 16384

-- Fit a result whose payload is an ARRAY under `listKey` (seats / reviews / cycles) within `budget` bytes.
-- Drops whole items until the encoded result fits, and sets result.truncated = true when it drops any.
--   keepTail = false (default): drop from the END   (seats, reviews — order not significant)
--   keepTail = true          : drop from the FRONT  (cycles — keep the NEWEST, shed the oldest)
-- encode(value) -> string must be the SAME encoder the caller will ship the value with.
function M.fitArray(result, listKey, encode, budget, keepTail)
  budget = budget or M.BUDGET
  local list = result[listKey]
  if type(list) ~= "table" then
    return result
  end
  if #encode(result) <= budget then
    return result -- within budget: leave truncated absent (contract: absent/false when within budget)
  end
  result.truncated = true
  while #list > 0 and #encode(result) > budget do
    if keepTail then
      table.remove(list, 1) -- shed the oldest
    else
      table.remove(list) -- shed the last
    end
  end
  return result
end

-- Fit a result whose payload is a MAP under `mapKey` (flags) within `budget` bytes. Drops keys in a deterministic
-- (sorted) order until the encoded result fits, and sets result.truncated = true when it drops any.
function M.fitMap(result, mapKey, encode, budget)
  budget = budget or M.BUDGET
  local map = result[mapKey]
  if type(map) ~= "table" then
    return result
  end
  if #encode(result) <= budget then
    return result
  end
  result.truncated = true
  local keys = {}
  for k in pairs(map) do
    keys[#keys + 1] = k
  end
  table.sort(keys)
  local i = #keys
  while i >= 1 and #encode(result) > budget do
    map[keys[i]] = nil
    i = i - 1
  end
  return result
end

return M
