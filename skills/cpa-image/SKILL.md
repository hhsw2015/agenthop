---
name: cpa-image
description: Generate images through CPA (CLIProxyAPI relay). Use when the user asks to 生成图片 / 文生图 / make an image / text-to-image via the swarm's CPA endpoint. Runs cli/cpa-image (sync /v1/images/generations).
argument-hint: <image prompt> [--size 1024x1024] [--n 1] [--model <id>] [--out <path>]
allowed-tools: [Bash, Read]
---

# cpa-image

<!-- GENERATED from skills-src/image.md by scripts/gen-cpa-skills.py — DO NOT EDIT HERE; edit the source. -->

Swarm-seat skin for CPA **image**. It invokes the hand-written CLI wrapper, which calls CPA's `POST {CPA}/v1/images/generations` (sync).

- **Default model**: `doubao-seedream-5.0` (resolved from frontier-aliases.json, generated 2026-10-14; override with `--model`).
- **Key**: the CLI reads `CPA_KEY_CLI` + `CPA_BASE_URL` from `~/.agenthop/cpa/keys.env` (0600). The key NEVER appears here.

## Invoke

```sh
cli/cpa-image <image prompt> [--size 1024x1024] [--n 1] [--model <id>] [--out <path>]
```

## Parameters

| param | required | default | description |
|---|---|---|---|
| `prompt` | yes | — | the image description (positional) |
| `--size` | no | 1024x1024 | WxH, e.g. 1024x1024 |
| `--n` | no | 1 | number of images |
| `--model` | no | — | override the default model id |
| `--out` | no | — | output file path (default: cwd timestamped .png) |

## Gotchas

- size is WxH like 1024x1024; CPA handles the DashScope/fal/Azure routing internally
- response is sync JSON data[].url — the CLI downloads the first url to --out (urls expire, fetch promptly)
- a listed model id is not a health guarantee; on a transient failure retry the same id (CPA fill-first fails over)

## What it does

`cpa-image` generates an image from a text prompt via CPA's OpenAI-wire `POST /v1/images/generations` (synchronous:
the response carries `data[].url`). The CLI downloads the first returned URL to a local file and prints the path.

## Request shape

```
POST {CPA}/v1/images/generations
Authorization: Bearer <CPA_KEY_CLI>
{ "model": "<default from frontier-aliases>", "prompt": "<prompt>", "size": "1024x1024", "n": 1 }
→ { "data": [ { "url": "https://…" } ] }
```

## Notes

- This is **image generation**. Image *editing* (`/v1/images/edits`) is a separate domain for a later batch.
- The default model is the current strongest `Image generation` id from `frontier-aliases.json`; override with `--model`.
- No async polling — image generation is synchronous. (Async media domains — video/music/3D — poll `/v1/tasks/:id`.)
