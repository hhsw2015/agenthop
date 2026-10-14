---
name: cpa-stt
description: Speech-to-text transcription through CPA (CLIProxyAPI relay). Use when the user asks to 转写 / 语音转文字 / transcribe audio via the swarm's CPA endpoint. Runs cli/cpa-stt (sync /v1/audio/transcriptions, multipart).
argument-hint: <audio file path> [--model <id>] [--out transcript.txt]
allowed-tools: [Bash, Read]
---

# cpa-stt

<!-- GENERATED from skills-src/stt.md by scripts/gen-cpa-skills.py — DO NOT EDIT HERE; edit the source. -->

Swarm-seat skin for CPA **stt**. It invokes the hand-written CLI wrapper, which calls CPA's `POST {CPA}/v1/audio/transcriptions` (sync).

- **Default model**: `elevenlabs-speech-to-text-scribe-v2` (resolved from frontier-aliases.json, generated 2026-10-14; override with `--model`).
- **Key**: the CLI reads `CPA_KEY_CLI` + `CPA_BASE_URL` from `~/.agenthop/cpa/keys.env` (0600). The key NEVER appears here.

## Invoke

```sh
cli/cpa-stt <audio file path> [--model <id>] [--out transcript.txt]
```

## Parameters

| param | required | default | description |
|---|---|---|---|
| `file` | yes | — | path to the audio file to transcribe (positional) |
| `--model` | no | — | override the default model id (e.g. whisper for the Azure path) |
| `--out` | no | — | write the transcript text to this file (default: stdout) |

## Gotchas

- multipart/form-data: the file goes as -F file=@<path>, the model as -F model=<id> (NOT a JSON body)
- response is JSON {text: ...}; the CLI prints .text (or writes it to --out)
- scribe_v2 (elevenlabs) gives Simplified Chinese; whisper returns Traditional — pick via --model if that matters

## What it does

`cpa-stt` transcribes an audio file via CPA's `POST /v1/audio/transcriptions` (synchronous, multipart form). The CLI
sends the file + model as form fields and prints the returned transcript text.

## Request shape

```
POST {CPA}/v1/audio/transcriptions   (multipart/form-data)
Authorization: Bearer <CPA_KEY_CLI>
-F file=@<audio>  -F model=<default from frontier-aliases>
→ { "text": "…transcript…" }
```

## Notes

- The default model is the current strongest `STT (speech-to-text)` id from `frontier-aliases.json`; override with `--model`.
- Multipart (not JSON). Synchronous — no polling.
