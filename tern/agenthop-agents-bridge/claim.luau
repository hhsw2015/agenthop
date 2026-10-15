-- claim.luau — the SHARED claim gate + op classification + sync dispatch for the agents-bridge (A1).
--
-- window.luau (production) does `require("./claim")` and test/claim.test.lua loads this same file: ONE source, so a single-line change
-- to the gate changes production AND turns the test RED together — no mirror copy to drift (review TA-A1-GATE / the EL-3-GATE lesson).
-- Written in the Lua 5.1/5.5 ∩ Luau subset (no type annotations, no += , ipairs/pairs, plain string ops) so both runtimes load it. Pure:
-- every side effect (fs read/remove, cx.agents) is injected by the caller.

local M = {}

M.READ_ONLY = { list = true, transcript = true, wait = true }
function M.classOf(op)
  if M.READ_ONLY[op] then
    return "read-only"
  end
  return "non-idempotent"
end

-- THE CLAIM GATE. `read` and `remove` are injected fs ops over `reqPath`. Returns (claimed, text):
--   read failure                         -> (false, nil)  do NOT delete; retry next tick (never delete what we could not read)
--   empty / nil text (partial write)     -> (false, nil)  do NOT claim; retry (TA-A1-PUBLISH: a half-written request is not bad JSON)
--   remove failure (lost race / EACCES)  -> (false, nil)  do NOT execute (ENOENT = another VM won; EACCES = cannot claim, stay safe)
--   success                              -> (true, text)  caller owns this request exactly once (at-most-once per claim)
function M.claim(read, remove, reqPath)
  local okRead, text = pcall(read, reqPath)
  if not okRead then
    return false, nil
  end
  if text == nil or text == "" then
    return false, nil
  end
  local okRemove = pcall(remove, reqPath)
  if not okRemove then
    return false, nil
  end
  return true, text
end

-- Sync op dispatch over cx.agents. `wait` is async and handled by the caller (never reaches here). Every op is pcall-guarded so one
-- failing op cannot throw out of the drain loop. Returns the result table (without `class`; the caller stamps it).
function M.execute(cx, req)
  local op = req.op
  if op == "list" then
    return { ok = true, agents = cx.agents:list() }
  elseif op == "transcript" then
    local o, t = pcall(function() return cx.agents:transcript(req.agent, { last = req.last }) end)
    return { ok = o, transcript = o and t or nil, error = (not o) and tostring(t) or nil }
  elseif op == "ask" then
    local o, e = pcall(function() cx.agents:ask(req.agent, req.text) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  elseif op == "start" then
    -- WARNING (PROTOCOL.md §4): start is synchronous and may be long; calling it from the status poll is a known design risk.
    local o, p = pcall(function()
      return cx.agents:start({ prompt = req.prompt, cwd = req.cwd, command = req.command, how = req.how })
    end)
    return { ok = o, pane = o and p or nil, error = (not o) and tostring(p) or nil }
  elseif op == "interrupt" then
    local o, e = pcall(function() cx.agents:interrupt(req.agent) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  elseif op == "stop" then
    local o, e = pcall(function() cx.agents:stop(req.agent) end)
    return { ok = o, error = (not o) and tostring(e) or nil }
  elseif op == "eval" then
    -- r2 ④ (user directive: call the plugin's Lua API directly). Compile `req.code` with loadstring (the Tern VM has loadstring; `load`
    -- is nil there) and call it with `cx`; the returned value is the result. Trust boundary unchanged: requests/ lives in the 0700
    -- home dir, and anyone able to write it can already `start` an arbitrary command — eval adds no attack surface (PROTOCOL.md §2.2).
    -- Classified non-idempotent (arbitrary code may have side effects) ⇒ UNKNOWN is HOLD, never auto-reissued (PROTOCOL.md §3.3).
    local compile = loadstring or load
    if type(req.code) ~= "string" then return { ok = false, error = "eval: code must be a string" } end
    if type(compile) ~= "function" then return { ok = false, error = "eval: no loadstring in this VM" } end
    -- `cx` is visible to the snippet both as a named local (`cx.agents:list()`) and as `...` — compile a wrapper that binds it, so
    -- callers need no boilerplate. The snippet's own `return` is the result.
    local fn, cerr = compile("local cx = ...\n" .. req.code)
    if not fn then return { ok = false, error = "eval compile: " .. tostring(cerr) } end
    local o, v = pcall(fn, cx)
    return { ok = o, value = o and v or nil, error = (not o) and tostring(v) or nil }
  else
    return { ok = false, error = "unknown op: " .. tostring(op) }
  end
end

return M
