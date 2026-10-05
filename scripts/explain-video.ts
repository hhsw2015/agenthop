#!/usr/bin/env tsx
/**
 * explain-video — the Karpathy explainer chain (script -> visuals -> voice -> MP4) as ONE portable file,
 * zero swarm imports, usable by any project (vm-ssh-style slicing). Contract: docs/swarm/explainer-video-brief.md
 * (frozen v1).
 *
 * Tier is chosen by the CONTENT SHAPE, not preference: a ```manim fence in the script => heavy tier (manim
 * renders a continuous transform); otherwise => light tier (discrete steps), handed straight to the installed
 * `am video` skill. Voice goes through CPA's unified /v1/audio/speech (doubao/eleven), never direct to a vendor;
 * CPA unreachable auto-downgrades to the offline `say` and says so. Beat alignment uses each clip's REAL audio
 * duration from ffprobe — never a line-count estimate (estimation-driven alignment is the F22 family of bug).
 *
 * Usage:
 *   tsx scripts/explain-video.ts <script.md> [--voice doubao|eleven|say|off] [--out <file.mp4>] [--tier auto|light|heavy] [--keep]
 *
 * The pure core (selectTier / parseScenes / renderWithRetry / planAlignment) is exported and covered by
 * scripts/explain-video.selftest.mts. Everything that touches the disk, a subprocess, or the network is an IO
 * shell below it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// =================================================================================================
// pure core (no IO) — selftestable
// =================================================================================================

export type Tier = "light" | "heavy";

/** A ```manim fence anywhere in the script routes the whole job to the heavy (manim) tier. */
export function selectTier(script: string): Tier {
  return /(^|\n)```[ \t]*manim\b/.test(script) ? "heavy" : "light";
}

export interface Scene {
  heading: string; // the `## ...` title, or "" for the preamble
  manim: string | null; // the ```manim fenced code, if any
  manimClass: string | null; // the `class X(Scene)` name manim must be told to render
  narration: string[]; // `>` lines (am format): one spoken beat each
}

const MANIM_CLASS_RE = /class\s+([A-Za-z_]\w*)\s*\(\s*\w*Scene\w*\s*\)/;

/** Split the extended-markdown script into scenes (`## ` headings). Extracts each scene's ```manim block,
 *  its Scene class name, and the `>` narration lines. Pure — the same parse the heavy tier walks. */
export function parseScenes(script: string): Scene[] {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  const scenes: Scene[] = [];
  const newScene = (heading: string): Scene => { const s: Scene = { heading, manim: null, manimClass: null, narration: [] }; scenes.push(s); return s; };
  let cur: Scene = newScene(""); // preamble scene (front matter / intro narration before the first ##)
  let inFence = false;
  let fenceIsManim = false;
  let fenceBuf: string[] = [];
  for (const line of lines) {
    const fence = /^```[ \t]*(\w+)?/.exec(line);
    if (fence && !inFence) {
      inFence = true; fenceIsManim = (fence[1] ?? "").toLowerCase() === "manim"; fenceBuf = [];
      continue;
    }
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        if (fenceIsManim) {
          cur.manim = fenceBuf.join("\n");
          cur.manimClass = MANIM_CLASS_RE.exec(cur.manim)?.[1] ?? null;
        }
        inFence = false; fenceIsManim = false; fenceBuf = [];
      } else {
        fenceBuf.push(line);
      }
      continue;
    }
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { cur = newScene(h[1]!.trim()); continue; }
    const n = /^>\s?(.*)$/.exec(line);
    if (n) cur.narration.push(n[1]!.trim());
  }
  return scenes.filter((s) => s.heading || s.manim || s.narration.length);
}

export interface RenderOutcome { ok: boolean; video?: string; error?: string }
export interface RetryResult { ok: boolean; video?: string; rounds: number; downgraded: boolean; lastError?: string; code: string }

/**
 * Render manim code with a "render -> read error -> fix -> re-render" loop, capped at maxRounds, then DOWNGRADE.
 * `render` and `fix` are injected so the loop is pure/testable: a model-written Scene will have errors, and the
 * cap + downgrade is the safety the contract demands (never spin forever, never ship a broken render). `fix` is
 * optional — without one the same code is retried then downgraded (a fixer makes each round an improvement).
 */
export async function renderWithRetry(opts: {
  code: string;
  render: (code: string) => Promise<RenderOutcome>;
  fix?: (code: string, error: string) => Promise<string>;
  maxRounds?: number;
}): Promise<RetryResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? 3);
  let code = opts.code;
  let lastError: string | undefined;
  for (let round = 1; round <= maxRounds; round++) {
    const out = await opts.render(code);
    if (out.ok) return { ok: true, video: out.video, rounds: round, downgraded: false, code };
    lastError = out.error ?? "unknown render error";
    if (opts.fix && round < maxRounds) {
      try { code = await opts.fix(code, lastError); } catch { /* fixer failed: retry the same code, then downgrade */ }
    }
  }
  return { ok: false, rounds: maxRounds, downgraded: true, lastError, code };
}

export interface AlignedScene { index: number; videoSec: number; audioSec: number; holdSec: number; sceneSec: number }
export interface AlignPlan { scenes: AlignedScene[]; totalSec: number }

/**
 * Align each scene to the LONGER of its rendered video and its real narration audio (durations measured, never
 * estimated — F22). holdSec = how long to freeze the last video frame so the voice is not cut off. Pure.
 */
export function planAlignment(scenes: { videoSec: number; audioSec: number }[]): AlignPlan {
  let total = 0;
  const out: AlignedScene[] = scenes.map((s, index) => {
    const videoSec = Math.max(0, s.videoSec);
    const audioSec = Math.max(0, s.audioSec);
    const sceneSec = Math.max(videoSec, audioSec);
    total += sceneSec;
    return { index, videoSec, audioSec, holdSec: Math.max(0, audioSec - videoSec), sceneSec };
  });
  return { scenes: out, totalSec: total };
}

// ---- controlled-language narration (ASD-STE100-inspired) ----------------------------------------
// Karpathy's writing tip: ask for ASD-STE100 Simplified Technical English (or "80% of it") for clean, readable
// output. For SPOKEN narration the useful subset is: one idea per sentence, short sentences, active voice,
// present tense, plain words. The pure core LINTS and can deterministically SPLIT overlong sentences; the
// optional LLM pass (steRewrite) does the full rewrite when CPA is reachable.

export interface SteLimits { wordMax: number; cjkCharMax: number }
export const STE_DEFAULT: SteLimits = { wordMax: 20, cjkCharMax: 30 };

const SENT_TERM = /[.。!！?？;；]$/;
const isCjk = (s: string): boolean => /[一-鿿]/.test(s);

/** Split text into sentences at terminal punctuation (keeps the terminator with its sentence). */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.。!！?？;；])\s*/).map((s) => s.trim()).filter(Boolean);
}

/** Length in STE units: words for Latin text, non-space characters for CJK. */
export function lengthUnits(s: string): number {
  return isCjk(s) ? [...s].filter((c) => !/\s/.test(c) && !SENT_TERM.test(c)).length : s.split(/\s+/).filter(Boolean).length;
}

export interface SteWarning { sentence: string; units: number; limit: number; kind: "too-long" | "passive" }

/** Flag sentences that break the controlled-language limits (too long, or passive voice). Pure. */
export function steLint(text: string, limits: SteLimits = STE_DEFAULT): SteWarning[] {
  const out: SteWarning[] = [];
  for (const s of splitSentences(text)) {
    const limit = isCjk(s) ? limits.cjkCharMax : limits.wordMax;
    const units = lengthUnits(s);
    if (units > limit) out.push({ sentence: s, units, limit, kind: "too-long" });
    if (/\b(?:was|were|is|are|be|been|being)\s+\w+ed\b/i.test(s)) out.push({ sentence: s, units, limit, kind: "passive" });
  }
  return out;
}

const addTerm = (s: string, cjk: boolean): string => (SENT_TERM.test(s) ? s : s + (cjk ? "。" : "."));

/** Deterministic "toward STE" with no LLM: break each overlong sentence at clause punctuation into shorter
 *  sentences. Technical nouns and numbers are untouched (we only split, never reword). Pure. */
export function steSimplify(text: string, limits: SteLimits = STE_DEFAULT): string {
  const pieces: string[] = [];
  for (const s of splitSentences(text)) {
    const cjk = isCjk(s);
    const limit = cjk ? limits.cjkCharMax : limits.wordMax;
    if (lengthUnits(s) <= limit) { pieces.push(addTerm(s, cjk)); continue; }
    const clauses = s.replace(SENT_TERM, "").split(/[,，、;；]/).map((p) => p.trim()).filter(Boolean);
    if (clauses.length < 2) { pieces.push(addTerm(s, cjk)); continue; } // nothing to split on; leave it
    for (const c of clauses) pieces.push(addTerm(c, cjk));
  }
  return pieces.join(" ");
}

/** Map the contract's --voice to the am-video skill's TTS settings (light tier delegates TTS to am). */
export function amVoiceEnv(voice: Voice, cpa: CpaConfig): { flag: string; env: Record<string, string> } {
  if (voice === "say") return { flag: "system", env: {} };
  if (voice === "off") return { flag: "off", env: {} };
  // doubao / eleven both ride CPA's OpenAI-compatible /v1/audio/speech via am's `local` provider.
  const model = voice === "eleven" ? cpa.elevenModel : cpa.doubaoModel;
  const voiceId = voice === "eleven" ? cpa.elevenVoice : cpa.doubaoVoice;
  const env: Record<string, string> = { AM_TTS_URL: cpa.baseUrl, AM_TTS_MODEL: model, AM_TTS_VOICE: voiceId };
  if (cpa.apiKey) env.AM_TTS_API_KEY = cpa.apiKey;
  return { flag: "local", env };
}

// =================================================================================================
// IO shells
// =================================================================================================

export type Voice = "doubao" | "eleven" | "say" | "off";
export interface CpaConfig {
  baseUrl: string; apiKey: string;
  doubaoModel: string; doubaoVoice: string;
  elevenModel: string; elevenVoice: string;
}

function cpaFromEnv(): CpaConfig {
  return {
    baseUrl: process.env.CPA_BASE_URL ?? "http://127.0.0.1:8318",
    apiKey: process.env.CPA_API_KEY ?? "",
    doubaoModel: process.env.CPA_DOUBAO_MODEL ?? "doubao-tts",
    doubaoVoice: process.env.CPA_DOUBAO_VOICE ?? "zh_female_xiaohe_uranus_bigtts",
    elevenModel: process.env.CPA_ELEVEN_MODEL ?? "eleven_flash_v2_5",
    elevenVoice: process.env.CPA_ELEVEN_VOICE ?? "21m00Tcm4TlvDq8ikWAM",
  };
}

/** ffprobe a media file's duration in seconds (REAL duration — the only input to alignment). */
export async function audioDurationSec(file: string): Promise<number> {
  const { stdout } = await pexec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const sec = Number(stdout.trim());
  if (!Number.isFinite(sec)) throw new Error(`ffprobe: no duration for ${file}`);
  return sec;
}

/** Synthesize narration to an audio file. doubao/eleven go through CPA /v1/audio/speech; say is the offline
 *  fallback. Returns the file path and which engine actually produced it (CPA-unreachable auto-downgrades). */
export async function synthesize(text: string, voice: Voice, outFile: string, cpa: CpaConfig): Promise<{ file: string; engine: string }> {
  if (voice === "off") return { file: "", engine: "off" };
  if (voice === "doubao" || voice === "eleven") {
    try {
      const model = voice === "eleven" ? cpa.elevenModel : cpa.doubaoModel;
      const voiceId = voice === "eleven" ? cpa.elevenVoice : cpa.doubaoVoice;
      const res = await fetch(`${cpa.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cpa.apiKey ? { authorization: `Bearer ${cpa.apiKey}` } : {}) },
        body: JSON.stringify({ model, input: text, voice: voiceId, response_format: "wav" }),
      });
      if (!res.ok) throw new Error(`CPA /v1/audio/speech ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64) throw new Error("CPA returned an empty audio body");
      writeFileSync(outFile, buf);
      return { file: outFile, engine: voice };
    } catch (e) {
      console.error(`[voice] ${voice} via CPA failed (${(e as Error).message}); downgrading to offline say.`);
      return synthesize(text, "say", outFile.replace(/\.\w+$/, ".aiff"), cpa);
    }
  }
  // say (offline). Output AIFF; ffprobe/ffmpeg read it fine.
  const aiff = outFile.endsWith(".aiff") ? outFile : outFile.replace(/\.\w+$/, ".aiff");
  await pexec("say", ["-o", aiff, text]);
  return { file: aiff, engine: "say" };
}

/** Render a manim Scene to an mp4. Throws with the manim stderr on failure (the loop reads it). */
export async function renderManim(code: string, className: string, workDir: string): Promise<string> {
  mkdirSync(workDir, { recursive: true });
  const py = path.join(workDir, "scene.py");
  writeFileSync(py, code);
  const mediaDir = path.join(workDir, "media");
  try {
    await pexec("manim", ["render", "-ql", "--media_dir", mediaDir, "--format", "mp4", py, className], { maxBuffer: 1 << 24 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message: string };
    throw new Error((err.stderr || err.stdout || err.message || "manim failed").slice(-1500));
  }
  const found = findFile(mediaDir, (f) => f.endsWith(".mp4") && f.includes(className))
    ?? findFile(mediaDir, (f) => f.endsWith(".mp4"));
  if (!found) throw new Error("manim reported success but no mp4 was found");
  return found;
}

function findFile(dir: string, pred: (name: string) => boolean): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = findFile(full, pred); if (hit) return hit; }
    else if (pred(entry.name)) return full;
  }
  return null;
}

/** Mux one scene: freeze the video's last frame for holdSec so the narration is never cut off, then add audio. */
async function muxScene(video: string, audio: string | null, holdSec: number, out: string): Promise<void> {
  const args = ["-y", "-i", video];
  if (audio) args.push("-i", audio);
  const vf = holdSec > 0.01 ? ["-vf", `tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`] : [];
  args.push(...vf);
  if (audio) args.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-shortest");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  await pexec("ffmpeg", args, { maxBuffer: 1 << 24 });
}

/** Concatenate scene mp4s into the final video (re-encode for safe concat across differing GOPs). */
async function concatScenes(parts: string[], out: string): Promise<void> {
  if (parts.length === 1) { await pexec("ffmpeg", ["-y", "-i", parts[0]!, "-c", "copy", out], { maxBuffer: 1 << 24 }); return; }
  const inputs = parts.flatMap((p) => ["-i", p]);
  const filter = parts.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("") + `concat=n=${parts.length}:v=1:a=1[v][a]`;
  await pexec("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out], { maxBuffer: 1 << 24 });
}

/** am's --mp4 export spawns a Chromium headless. Prefer the EGO browser already installed (ego-lite, a Chromium)
 *  over downloading anything; fall through to AM_CHROME/CHROME_PATH or a system Chrome. Returns a path to set as
 *  AM_CHROME, or "" to let am search. */
export function chromeBin(): string {
  if (process.env.AM_CHROME || process.env.CHROME_PATH) return ""; // caller already chose; let am use it
  const candidates = [
    "/Applications/ego lite.app/Contents/MacOS/ego lite", // ego-browser (ego-lite) — the installed Chromium, preferred
    "/Applications/Arc.app/Contents/MacOS/Arc", // Arc — also Chromium, another installed browser
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  return candidates.find((p) => existsSync(p)) ?? "";
}

/** am's --mp4 export needs Node >=22 (built-in WebSocket). Pick one: AM_NODE, else the newest nvm node >=22, else
 *  the current node (am will report if it is too old). */
export function nodeBin(): string {
  if (process.env.AM_NODE && existsSync(process.env.AM_NODE)) return process.env.AM_NODE;
  const nvm = path.join(process.env.HOME ?? "", ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    const good = readdirSync(nvm)
      .map((v) => ({ v, major: Number(/^v(\d+)/.exec(v)?.[1] ?? 0), bin: path.join(nvm, v, "bin", "node") }))
      .filter((x) => x.major >= 22 && existsSync(x.bin))
      .sort((a, b) => b.major - a.major);
    if (good.length) return good[0]!.bin;
  }
  return "node";
}

export type OutFormat = "mp4" | "html" | "both";
export interface AmResult { mp4?: string; html?: string }

/** Light tier: hand the whole script to the installed `am video` skill. The interactive HTML player page is
 *  always produced; --mp4 additionally exports a video (needs a browser + Node>=22). `format` picks what to keep:
 *  html (skip the export, no browser needed), mp4, or both. Returns the kept artifact path(s). */
export async function runAmVideo(scriptFile: string, voice: Voice, out: string, cpa: CpaConfig, format: OutFormat = "mp4"): Promise<AmResult> {
  const am = path.join(process.env.HOME ?? "", ".claude", "skills", "answer-me-with-html", "scripts", "am.mjs");
  if (!existsSync(am)) throw new Error(`am video skill not found at ${am}`);
  const { flag, env } = amVoiceEnv(voice, cpa);
  const wantMp4 = format !== "html";
  if (wantMp4) { const chrome = chromeBin(); if (chrome) env.AM_CHROME = chrome; } // prefer an installed browser; never download
  const args = [am, "video", scriptFile, "--no-open", "--voice", flag, ...(wantMp4 ? ["--mp4"] : [])];
  const { stdout, stderr } = await pexec(nodeBin(), args, { env: { ...process.env, ...env }, maxBuffer: 1 << 24 });
  const text = stdout + "\n" + stderr;
  const srcHtml = /(\/\S+\.html)/.exec(text)?.[1];
  const srcMp4 = wantMp4 ? /(\/\S+\.mp4)/.exec(text)?.[1] : undefined;
  if (wantMp4 && (!srcMp4 || !existsSync(srcMp4))) throw new Error(`am video did not report an mp4 path. Output:\n${text.slice(-800)}`);
  if (!wantMp4 && (!srcHtml || !existsSync(srcHtml))) throw new Error(`am video did not report an html path. Output:\n${text.slice(-800)}`);
  const result: AmResult = {};
  const copyTo = async (src: string, dstExt: string) => { const dst = out.replace(/\.\w+$/, dstExt); if (path.resolve(src) !== path.resolve(dst)) { mkdirSync(path.dirname(dst), { recursive: true }); await pexec("cp", [src, dst]); } return dst; };
  if (srcMp4 && (format === "mp4" || format === "both")) result.mp4 = await copyTo(srcMp4, ".mp4");
  if (srcHtml && (format === "html" || format === "both")) result.html = await copyTo(srcHtml, ".html");
  return result;
}

// =================================================================================================
// orchestration
// =================================================================================================

async function heavy(script: string, outMp4: string, voice: Voice, cpa: CpaConfig, keep: boolean): Promise<string> {
  const scenes = parseScenes(script).filter((s) => s.manim); // heavy tier assembles the manim scenes
  if (!scenes.length) throw new Error("heavy tier selected but no ```manim scene found");
  const work = mkdtempSync(path.join(tmpdir(), "explain-video-"));
  const sceneMp4s: string[] = [];
  try {
    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i]!;
      if (!sc.manimClass) throw new Error(`scene ${i} has a manim block with no 'class X(Scene)'`);
      const r = await renderWithRetry({
        code: sc.manim!,
        render: async (code) => {
          try { return { ok: true, video: await renderManim(code, sc.manimClass!, path.join(work, `s${i}-r`)) }; }
          catch (e) { return { ok: false, error: (e as Error).message }; }
        },
        fix: cpa.apiKey ? (code, err) => fixManimViaCpa(code, err, cpa) : undefined,
      });
      if (!r.ok || !r.video) {
        console.error(`[heavy] scene ${i} failed after ${r.rounds} rounds; downgrading the whole job to light (am video).`);
        const dg = await runAmVideo(writeTmp(work, "downgrade.md", script), voice, outMp4, cpa, "mp4");
        return dg.mp4 ?? outMp4;
      }
      const narration = sc.narration.join(" ");
      let audio: string | null = null, holdSec = 0;
      if (narration && voice !== "off") {
        const a = await synthesize(narration, voice, path.join(work, `s${i}.wav`), cpa);
        audio = a.file || null;
        if (audio) {
          const [vSec, aSec] = [await audioDurationSec(r.video), await audioDurationSec(audio)];
          holdSec = planAlignment([{ videoSec: vSec, audioSec: aSec }]).scenes[0]!.holdSec;
        }
      }
      const out = path.join(work, `scene-${i}.mp4`);
      await muxScene(r.video, audio, holdSec, out);
      sceneMp4s.push(out);
    }
    mkdirSync(path.dirname(path.resolve(outMp4)), { recursive: true });
    await concatScenes(sceneMp4s, outMp4);
    return outMp4;
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
    else console.error(`[keep] work dir: ${work}`);
  }
}

function writeTmp(dir: string, name: string, content: string): string {
  const p = path.join(dir, name); writeFileSync(p, content); return p;
}

/** Best-effort model repair of broken manim code via a CPA chat model. Failure -> original code (-> downgrade). */
async function fixManimViaCpa(code: string, error: string, cpa: CpaConfig): Promise<string> {
  const model = process.env.CPA_FIX_MODEL ?? "claude-haiku-4.5";
  const res = await fetch(`${cpa.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cpa.apiKey ? { authorization: `Bearer ${cpa.apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You fix Python manim (ManimCE) Scene code. Return ONLY the corrected full Python file, no prose, no markdown fence." },
        { role: "user", content: `This manim code failed to render.\n\nERROR:\n${error}\n\nCODE:\n${code}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`CPA fix ${res.status}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const fixed = j.choices?.[0]?.message?.content?.trim();
  if (!fixed) throw new Error("CPA fix: empty");
  return fixed.replace(/^```(?:python)?\s*\n?/, "").replace(/\n?```\s*$/, "");
}

/** Rewrite narration lines toward ASD-STE100. With CPA + llm:true, a model does the full rewrite; otherwise the
 *  deterministic steSimplify (split overlong sentences) runs. Best-effort — any failure falls back to steSimplify. */
export async function steRewrite(lines: string[], cpa: CpaConfig, opts: { llm: boolean; strictness: number }): Promise<string[]> {
  if (!lines.length) return lines;
  if (!opts.llm || !cpa.apiKey) return lines.map((l) => steSimplify(l));
  try {
    const model = process.env.CPA_STE_MODEL ?? "claude-haiku-4.5";
    const pct = Math.round(opts.strictness * 100);
    const sys = `Rewrite each input line toward ASD-STE100 Simplified Technical English at ${pct}% strictness: one idea per sentence, active voice, present tense, short sentences (<=20 words, or <=30 characters for Chinese), plain approved vocabulary. Keep technical nouns, identifiers and NUMBERS exactly. Keep each line in its original language. Return EXACTLY ${lines.length} lines, one rewritten line per input line, in order, no numbering, no commentary.`;
    const res = await fetch(`${cpa.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cpa.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: lines.join("\n") }] }),
    });
    if (!res.ok) throw new Error(`CPA ste ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const got = (j.choices?.[0]?.message?.content ?? "").split("\n").map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
    if (got.length !== lines.length) throw new Error(`ste: expected ${lines.length} lines, got ${got.length}`);
    return got;
  } catch (e) {
    console.error(`[ste] LLM rewrite unavailable (${(e as Error).message}); using deterministic split.`);
    return lines.map((l) => steSimplify(l));
  }
}

/** Rewrite the `>` narration lines of a script in place (toward STE), leaving everything else untouched. */
export async function applySte(script: string, cpa: CpaConfig, opts: { llm: boolean; strictness: number }): Promise<string> {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  const idx: number[] = [];
  const texts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^>\s?(.*)$/.exec(lines[i]!);
    if (m && m[1]!.trim()) { idx.push(i); texts.push(m[1]!.trim()); }
  }
  if (!texts.length) return script;
  const rewritten = await steRewrite(texts, cpa, opts);
  idx.forEach((lineNo, k) => { lines[lineNo] = `> ${rewritten[k]}`; });
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pos = argv.filter((a) => !a.startsWith("--"));
  const opt = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1]! : d; };
  const scriptFile = pos[0];
  if (!scriptFile) { console.error("usage: explain-video.ts <script.md> [--voice doubao|eleven|say|off] [--out <file>] [--tier auto|light|heavy] [--format mp4|html|both] [--ste[=0.8]] [--ste-llm] [--keep]"); process.exit(2); }
  if (!existsSync(scriptFile)) { console.error(`no such script: ${scriptFile}`); process.exit(2); }
  let script = readFileSync(scriptFile, "utf8");
  const voice = (opt("--voice", "doubao") as Voice);
  const tierOpt = opt("--tier", "auto")!;
  const tier: Tier = tierOpt === "auto" ? selectTier(script) : (tierOpt as Tier);
  const format = (opt("--format", "mp4") as OutFormat);
  const out = path.resolve(opt("--out", path.join(process.cwd(), `${path.basename(scriptFile).replace(/\.\w+$/, "")}.mp4`))!);
  const cpa = cpaFromEnv();
  const keep = argv.includes("--keep");

  // Controlled-language narration pass (ASD-STE100-inspired). --ste[=strictness] on; --ste-llm uses a CPA model,
  // otherwise a deterministic split. Lint always surfaces what is still over the limit.
  let lightScriptFile = scriptFile;
  const steArg = argv.find((a) => a === "--ste" || a.startsWith("--ste="));
  if (steArg) {
    const strictness = steArg.includes("=") ? Math.max(0, Math.min(1, Number(steArg.split("=")[1]))) : 0.8;
    script = await applySte(script, cpa, { llm: argv.includes("--ste-llm"), strictness });
    const left = steLint(script.split("\n").filter((l) => l.startsWith(">")).join(" "));
    console.error(`[ste] narration rewritten (strictness ${strictness}${argv.includes("--ste-llm") ? ", llm" : ", deterministic"}); ${left.length} sentence(s) still over limit`);
    if (tier === "light") { lightScriptFile = out.replace(/\.\w+$/, ".ste.md"); writeFileSync(lightScriptFile, script); } // am reads a file
  }

  console.error(`[explain-video] tier=${tier} voice=${voice} format=${format} -> ${out}`);
  if (tier === "heavy" && format !== "mp4") console.error(`[explain-video] note: heavy (manim) tier produces mp4 only; --format ${format} -> mp4.`);

  const result: AmResult = tier === "light"
    ? await runAmVideo(lightScriptFile, voice, out, cpa, format)
    : { mp4: await heavy(script, out, voice, cpa, keep) };
  for (const p of [result.mp4, result.html].filter(Boolean)) console.log(p);
}

// Guard so the pure core can be imported by the selftest without running (msglog P1 lesson).
if (process.argv[1] && /(^|\/)explain-video\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
