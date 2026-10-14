---
name: cpa-tts
description: Text-to-speech through CPA (CLIProxyAPI relay). Use when the user asks to 朗读 / 合成语音 / read this aloud / text-to-speech via the swarm's CPA endpoint. Runs cli/cpa-tts (sync /v1/audio/speech → audio bytes).
argument-hint: <text to speak> [--voice <id>] [--model <id>] [--out out.mp3]
allowed-tools: [Bash, Read]
---

# cpa-tts

<!-- GENERATED from skills-src/tts.md by scripts/gen-cpa-skills.py — DO NOT EDIT HERE; edit the source. -->

Swarm-seat skin for CPA **tts**. It invokes the hand-written CLI wrapper, which calls CPA's `POST {CPA}/v1/audio/speech` (sync).

- **Default model**: `doubao-tts-2.0` (resolved from frontier-aliases.json, generated 2026-10-14; override with `--model`).
- **Key**: the CLI reads `CPA_KEY_CLI` + `CPA_BASE_URL` from `~/.agenthop/cpa/keys.env` (0600). The key NEVER appears here.

## Invoke

```sh
cli/cpa-tts <text to speak> [--voice <id>] [--model <id>] [--out out.mp3]
```

## Parameters

| param | required | default | description |
|---|---|---|---|
| `input` | yes | — | the text to speak (positional) |
| `--voice` | no | zh_female_xiaohe_uranus_bigtts | speaker/voice id (doubao default shown; ElevenLabs needs a voice_id; OpenAI tts uses alloy/echo/…) |
| `--model` | no | — | override the default model id |
| `--out` | no | cpa-tts-<ts>.mp3 | output audio file path |

## Gotchas

- the response is RAW AUDIO BYTES (wav/mp3), NOT JSON — the CLI writes them straight to --out
- voice is model-family specific: doubao wants a doubao speaker (default zh_female_xiaohe_uranus_bigtts), ElevenLabs wants a voice_id, OpenAI tts wants alloy/echo/fable/onyx/nova/shimmer
- doubao-tts is single-shot (~2.8s whole clip), not streaming — use it for quality

## What it does

`cpa-tts` synthesizes speech from text via CPA's `POST /v1/audio/speech` (synchronous; the body is raw audio). The CLI
writes the audio bytes to a file and prints the path.

## Request shape

```
POST {CPA}/v1/audio/speech
Authorization: Bearer <CPA_KEY_CLI>
{ "model": "<default from frontier-aliases>", "input": "<text>", "voice": "<voice id>" }
→ raw audio bytes (mp3/wav)
```

## Notes

- The default model is the current strongest `TTS / voice` id from `frontier-aliases.json`; override with `--model`.
- Match the `--voice` to the model family (see gotchas). Synchronous — no polling.
