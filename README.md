# CPA skill family (M2-b) — one source, three skins

Generate CPA (CLIProxyAPI relay) capability skins from a single per-domain source. First batch: **image / tts / stt**
(all synchronous). Contract: the M2-b dispatch (frozen). Source of truth: `~/Dev/CLIProxyAPIPlus/docs/consumer-guide.md`
+ `frontier-aliases.json` (machine-read, refreshed each `cpa regen`). Never push/merge (coordinator integrates).

## The three skins

| Skin | Consumer | Produced by |
|---|---|---|
| `skills/cpa-<domain>/SKILL.md` | swarm seat | **generated** (gen-cpa-skills.py) |
| `snippets/cpa-<domain>.luau` | Carly | **generated** (gen-cpa-skills.py) |
| `cli/cpa-<domain>` | the shared backend both call (+ humans) | **hand-written** (logic in code, tested) |

One source `skills-src/<domain>.md` (a ```json spec block + prose) drives the two generated skins; the generator also
writes `cli/cpa-defaults.env` (the resolved default model per domain) which bridges `frontier-aliases.json` → the
hand-written CLIs, so a `cpa regen` + re-gen refreshes every skin + the CLI default with no drift.

## Layout
```
skills-src/{image,tts,stt}.md   # SOURCE (json spec + prose); edit here, then regenerate
scripts/gen-cpa-skills.py       # generator → SKILL.md + luau + cpa-defaults.env (idempotent)
scripts/gen-cpa-skills.test.sh  # 32 tests (idempotence, output sanity, CLI --dry, key-leak guard)
cli/cpa-common.sh               # shared: load keys.env + defaults, redacted --dry, no-jq JSON parse
cli/{cpa-image,cpa-tts,cpa-stt} # hand-written bash + curl wrappers
cli/cpa-defaults.env            # GENERATED bridge (frontier-aliases → CLI defaults)
skills/cpa-<domain>/SKILL.md    # GENERATED
snippets/cpa-<domain>.luau      # GENERATED
```

## Credentials — `~/.agenthop/cpa/keys.env` (0600, created, keys filled post-deploy)
Consumer-dimension keys (sk-cpa-{swarm,carly,cli}); CPA meters per key×model so domains are already separated. The CLI
wrappers use `CPA_KEY_CLI` + `CPA_BASE_URL`. **The key never appears in any skin/skill text** (even `--dry` shows the
Authorization header redacted). Empty creds ⇒ the CLIs run `--dry` only.

## Run
```sh
python3 scripts/gen-cpa-skills.py          # (re)generate the two skins + cpa-defaults.env
cli/cpa-image "a red fox in snow"          # text→image (downloads the url to a .png)
cli/cpa-tts  "你好世界" --out hi.mp3        # text→speech (raw audio bytes)
cli/cpa-stt  recording.wav                 # speech→text (prints transcript)
cli/cpa-image "x" --dry                     # preview the request without sending (key redacted)
bash scripts/gen-cpa-skills.test.sh        # 32 tests
```

## Decisions (contract-confirmed)
- Generator makes **two** skins (SKILL.md + luau); the **CLI is hand-written** (logic in code, tested). "Three skins" =
  the two generated surfaces + the CLI backend both invoke.
- `cpa-defaults.env` bridges the machine-readable `frontier-aliases.json` to the hand-written CLIs (regen self-refreshes).
- Keys are **consumer-dimension** (one `CPA_KEY_CLI` for all CLI domains), not per-domain — CPA already meters per key×model.
- First batch is **sync-only**; the async submit→poll framework (`/v1/tasks/:id` for video/music/3D) is deferred (YAGNI).
- Carly snippet cache: snippet modules are cached per VM — a regenerated snippet is picked up only on a **VM reset**
  (documented in each `.luau`).

## Acceptance (contract)
- Generator idempotent (rerun = byte-identical) — verified (test + a 2-run hash).
- CLIs: keys/endpoint not yet deployed, so all three verified via `--dry` (request shapes correct). The real image
  sync-hit is one command post-deploy: `cli/cpa-image "<prompt>"` once `keys.env` is filled.
- Key-leak guard: a real key value never appears in `--dry` output — verified.
