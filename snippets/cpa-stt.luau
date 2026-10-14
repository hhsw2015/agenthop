-- cpa-stt — Carly snippet (GENERATED from skills-src/stt.md; DO NOT EDIT HERE).
-- Returns a function that runs the hand-written cli/cpa-stt wrapper via tern.process.run and awaits the result.
-- Default model: elevenlabs-speech-to-text-scribe-v2 (resolved from frontier-aliases.json, generated 2026-10-14; pass opts.model to override).
-- CARLY SNIPPET CACHE: Carly caches snippet modules per VM — an edit here is picked up only on a VM RESET
-- (reload). After re-running the generator (e.g. a new strongest model), RESET the VM to refresh this snippet.
-- The CPA key never appears here; the CLI reads CPA_KEY_CLI from ~/.agenthop/cpa/keys.env.
return function(file, opts)
  opts = opts or {}
  local argv = { "cpa-stt", file }
  if opts.model ~= nil then argv[#argv + 1] = "--model"; argv[#argv + 1] = tostring(opts.model) end
  if opts.out ~= nil then argv[#argv + 1] = "--out"; argv[#argv + 1] = tostring(opts.out) end
  return tern.process.run(argv) -- Awaitable<ProcessResult>; Carly awaits it ({status, stdout, stderr})
end
