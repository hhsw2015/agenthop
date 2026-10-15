-- agenthop agents-bridge v1 — A1 (production). A THIN window-half shim: it mirrors Tern's native cx.agents layer to a file-JSON control
-- plane the bash swarm reads/writes, herdr-style. Authoritative wire contract + claim/recovery semantics: PROTOCOL.md. A2 (promptless
-- patrol sentinel, registered via tern.carly.schedule) ships in this same plugin; A3 (OSC 9;4 alert) reader is in the sentinel, emitter
-- is osc-alert-hook.sh.
--
-- The claim GATE + op classification + sync dispatch live in claim.luau and are REQUIRED here (and loaded by test/claim.test.lua) — ONE
-- shared source, so a single-line change to the gate changes production and turns the test RED together (review TA-A1-GATE). Claim model:
-- execute ONLY after a successful remove-claim; a read failure or an empty/partial read never deletes; at-most-once per claim, NOT
-- crash-safe exactly-once (tern.fs has no rename/O_EXCL). Recovery is the swarm's job, op-class-specific (PROTOCOL.md §3).

local claim = require("./claim")

local HOME = tern.getenv("HOME") or ""
local CTL = HOME .. "/.agenthop/tern-panes" -- control-plane dir shared with the bash swarm
local REQ = CTL .. "/requests"
local RES = CTL .. "/results"
local POLL_MS = 750 -- status-mirror cadence. POLL_MS only sets the scheduling interval; it does NOT bound a tick's duration.

local function ensure()
  for _, d in ipairs({ CTL, REQ, RES }) do
    if not tern.fs.exists(d) then
      pcall(function() tern.fs.mkdir(d) end)
    end
  end
end

-- STATUS mirror (PROTOCOL.md §1): snapshot cx.agents:list() to agents.json. Advisory/overwrite; a torn read self-heals next poll.
local ticks = 0
local function mirror(cx)
  ticks = ticks + 1
  local ok, agents = pcall(function() return cx.agents:list() end)
  local payload = {
    ts = tern.now(),
    tick = ticks, -- liveness: must advance every POLL_MS
    agents = ok and agents or tern.json.array({}),
    error = (not ok) and tostring(agents) or nil,
  }
  pcall(function() tern.fs.write(CTL .. "/agents.json", tern.json.encode(payload)) end)
end

local function answer(id, result)
  pcall(function() tern.fs.write(RES .. "/" .. id .. ".json", tern.json.encode(result)) end)
end

-- CLAIM + DISPATCH via the shared claim.luau. The gate (read -> empty-skip -> remove-claim) is claim.claim; op class is claim.classOf;
-- sync dispatch is claim.execute. `wait` is async and handled here via :next (PROTOCOL.md §2.1).
local function drain(cx)
  local names = {}
  pcall(function() names = tern.fs.list(REQ) end)
  for _, name in ipairs(names) do
    if name:match("%.json$") then
      local id = (name:gsub("%.json$", ""))
      local path = REQ .. "/" .. name
      local claimed, text = claim.claim(
        function(p) return tern.fs.read(p) end,
        function(p) tern.fs.remove(p) end,
        path
      )
      if claimed then -- we hold the claim: exactly this VM owns the request now
        local okDec, req = pcall(function() return tern.json.decode(text) end)
        if okDec and type(req) == "table" and type(req.op) == "string" then
          local class = claim.classOf(req.op)
          if req.op == "wait" then
            -- async: hand to :next so a long idle-wait never stalls the poll
            local okW, aw = pcall(function() return cx.agents:wait(req.agent, { timeout = req.timeout }) end)
            if okW then
              aw:next(function(message, err)
                answer(id, { ok = (err == nil), class = class, message = message, error = err })
              end)
            else
              answer(id, { ok = false, class = class, error = tostring(aw) })
            end
          else
            local result = claim.execute(cx, req)
            result.class = class
            answer(id, result)
          end
        else
          answer(id, { ok = false, error = "bad request json" }) -- claimed but undecodable: report, do not silently drop
        end
      end
    end
  end
end

-- A2: register the promptless patrol sentinel (tern.carly.schedule, every 1m, no model turn). Check source is sentinel.luau (loaded
-- relative to the plugin dir). Dedup by title across reloads/windows: cancel any prior task with our title, then schedule one fresh.
-- tern.carly.* needs a SCOPED window callback, so this runs from inside the poll loop. Returns true only when the arming status was
-- durably recorded, so a transient failure (e.g. control dir missing) is retried next tick (dedup keeps the retry idempotent) — TA-A2-ARM.
local PATROL_TITLE = "agenthop tern patrol"
local function registerSentinel()
  local status = { ts = tern.now(), scheduled = false }
  local okSrc, src = pcall(function() return tern.fs.read("sentinel.luau") end)
  if not okSrc or type(src) ~= "string" then
    status.error = "sentinel.luau unreadable" -- the bridge (A1) still runs without the sentinel
  else
    pcall(function()
      for _, t in ipairs(tern.carly.tasks()) do
        if t.title == PATROL_TITLE then
          pcall(function() tern.carly.cancel(t.id) end)
        end
      end
    end)
    local okSched, idOrErr = pcall(function()
      return tern.carly.schedule({ title = PATROL_TITLE, when = "every 1m", check = src })
    end)
    status.scheduled = okSched
    if okSched then
      status.id = idOrErr
    else
      status.error = tostring(idOrErr)
    end
  end
  local okWrite = pcall(function() tern.fs.write(CTL .. "/sentinel.json", tern.json.encode(status)) end)
  return okWrite -- only "armed" once the status is durably recorded (dir now ensured first)
end

-- TWO independent sleep chains, each RESCHEDULING BEFORE IT WORKS (bridge tick-freeze root fix). Tern kills a window callback that
-- exceeds its ~50ms command budget ("disabled until reload"); pcall cannot catch that external termination. The old single `step` ran
-- mirror THEN drain and rescheduled LAST, so one sync `start` killed mid-drain left NO pending :next and froze the whole poll (tick
-- stuck, reload inert). Now: (1) the liveness mirror never shares a callback with drain's slow sync `start`; (2) each chain queues its
-- next tick FIRST, so a killed tick still has its successor scheduled and the chain self-heals. The one op killed mid-start falls to
-- the swarm's at-most-once recovery (PROTOCOL.md §3/§4). Making `start` async is the deeper follow-up (PROTOCOL.md §4), not needed here.
local sentinelArmed = false
local function mirrorStep(cx)
  tern.sleep(POLL_MS):next(function(_, _, nextCx) mirrorStep(nextCx) end) -- reschedule FIRST: the liveness tick cannot die
  if cx ~= nil then
    ensure() -- TA-A2-ARM: control dirs exist BEFORE arming, so the sentinel.json write cannot ENOENT on first boot
    if not sentinelArmed then -- A2: arm once, from inside a scoped window callback (tern.carly needs one)
      if registerSentinel() then
        sentinelArmed = true -- else leave false: retry next tick (dedup-by-title makes the retry safe)
      end
    end
    mirror(cx)
  end
end

local function drainStep(cx)
  tern.sleep(POLL_MS):next(function(_, _, nextCx) drainStep(nextCx) end) -- reschedule FIRST: a killed slow start cannot freeze it
  if cx ~= nil then
    ensure()
    pcall(function() drain(cx) end)
  end
end

mirrorStep(nil) -- A1 status mirror (liveness) + A2 one-shot arm; the first sleep's :next delivers the window cx
drainStep(nil)  -- A1 claim/dispatch, isolated on its own self-healing chain (the sync `start` lives here)
