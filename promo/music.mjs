// The soundtrack, synthesised from nothing: no samples, nothing borrowed. 96 BPM, one chord per
// bar, and every sound effect placed from the cues the page exported (out/cues.json), so a click
// lands on the frame where a character appears and a whoosh follows the packet across the screen.
//
//   node promo/music.mjs [--lang en]    → promo/out[/en]/music.wav (48 kHz, stereo, 16-bit)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out", ...(process.argv.join(" ").includes("--lang en") ? ["en"] : []));
const { duration, cues } = JSON.parse(readFileSync(path.join(OUT, "cues.json"), "utf8"));
const SR = 48000, DUR = duration, N = Math.round(SR * DUR);
const BPM = 96, BEAT = 60 / BPM, BAR = BEAT * 4;

const bus = () => [new Float32Array(N), new Float32Array(N)];
const pad = bus(), bass = bus(), drums = bus(), arp = bus(), sfx = bus(), send = bus();
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const pan = (p) => { const a = ((clamp(p, -1, 1) + 1) * Math.PI) / 4; return [Math.cos(a), Math.sin(a)]; };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const S = (t) => Math.round(t * SR);
function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry(7);
const white = () => rnd() * 2 - 1;
function add(b, i, l, r) { if (i >= 0 && i < N) { b[0][i] += l; b[1][i] += r; } }
/** Piecewise-linear automation: [[t, v], ...]. */
function auto(points) { return (t) => { if (t <= points[0][0]) return points[0][1]; for (let i = 1; i < points.length; i++) if (t <= points[i][0]) { const [t0, v0] = points[i - 1], [t1, v1] = points[i]; return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); } return points[points.length - 1][1]; }; }
/** Topology-preserving state-variable filter (Zavalishin); stable under fast modulation. */
function svf() { let ic1 = 0, ic2 = 0; return (x, fc, q) => { const g = Math.tan((Math.PI * clamp(fc, 20, SR * 0.45)) / SR), k = 1 / q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2; const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3; ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2; return { lp: v2, bp: v1, hp: x - k * v1 - v2 }; }; }
function blep(t, dt) { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; }

// ---------------------------------------------------------------------------------------------
// Harmony: one chord per 2.5-second bar, 55 bars. The acts, in film time:
//   the chat 0–7.5 · the relay speeding up 7.5–17.5 · the name 17.5–22.5 · scenes 22.5–75 (the
//   question that opens them, three scenes of 15 s, the pairs 70–75) · how it works, step by step,
//   and a relay of your own 75–107.5 · contacts 107.5–120 · getting it 120–130 · end 130–137.5
// ---------------------------------------------------------------------------------------------
const CH = {
  Am7: { root: 45, notes: [57, 60, 64, 67] },
  Fmaj7: { root: 41, notes: [53, 57, 60, 64] },
  G6: { root: 43, notes: [55, 59, 62, 64] },
  Em7: { root: 40, notes: [55, 59, 62, 67] },
  Cmaj9: { root: 48, notes: [52, 55, 59, 62] },
  Dm9: { root: 38, notes: [53, 57, 60, 64] },
  Gsus4: { root: 43, notes: [55, 60, 62, 65] },
};
const SCENES = Array.from({ length: 18 }, (_, i) => ["Cmaj9", "G6", "Am7", "Fmaj7"][i % 4]);
const BARS = [
  "Cmaj9", "Fmaj7", "Am7", // the chat
  "Am7", "Fmaj7", "Fmaj7", "Gsus4", // faster and faster, then four become two
  "Cmaj9", "Cmaj9", // the name
  "G6", // what if the agents just talked?
  ...SCENES, "Fmaj7", "Gsus4", // three scenes, and the pairs
  "Fmaj7", "G6", "Em7", "Am7", "Fmaj7", "G6", // how it works: a room, the code, hello, confirm
  "Em7", "Am7", "Fmaj7", // talking, files
  "G6", "Em7", // bye
  "Am7", "Fmaj7", // a relay of your own
  "Dm9", "Fmaj7", "G6", "Em7", "Am7", // contacts
  "Fmaj7", "G6", "Am7", "Gsus4", // getting it
  "Cmaj9", "Fmaj7", "Cmaj9", // end
];
if (BARS.length * BAR < DUR - 0.01) throw new Error(`${BARS.length} bars do not cover ${DUR} s`);
const chordAt = (t) => CH[BARS[clamp(Math.floor(t / BAR), 0, BARS.length - 1)]];
const inRange = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);

// ---------------------------------------------------------------------------------------------
// Pad: three detuned saws per note, one filter over the whole bus, following the story.
// ---------------------------------------------------------------------------------------------
{
  const runs = [];
  for (let b = 0; b < BARS.length; b++) {
    const last = runs[runs.length - 1];
    if (last && last.name === BARS[b]) last.end = (b + 1) * BAR;
    else runs.push({ name: BARS[b], start: b * BAR, end: (b + 1) * BAR });
  }
  const level = auto([[0, 0.024], [3.5, 0.028], [7.3, 0.022], [7.5, 0.02], [14.6, 0.025], [15.0, 0.03], [17.5, 0.037], [22.5, 0.03], [25, 0.026], [74.9, 0.026], [75, 0.027], [107.5, 0.034], [112.5, 0.027], [120, 0.025], [130, 0.037], [137.5, 0.037]]);
  for (const run of runs) {
    const attack = run.start < 17.5 ? 1.2 : 0.35, release = 1.1;
    for (const note of CH[run.name].notes) {
      [-9, 0, 9].forEach((cents, v) => {
        const f = mtof(note) * Math.pow(2, cents / 1200), dt = f / SR;
        const [gl, gr] = pan([-0.6, 0, 0.6][v]);
        let ph = rnd();
        const i0 = S(run.start), i1 = Math.min(N, S(run.end + release));
        for (let i = i0; i < i1; i++) {
          const t = i / SR, u = t - run.start;
          let env = Math.min(1, u / attack);
          if (t > run.end) env *= Math.max(0, 1 - (t - run.end) / release);
          ph += dt; if (ph >= 1) ph -= 1;
          const x = (2 * ph - 1 - blep(ph, dt)) * env * env * level(t);
          pad[0][i] += x * gl; pad[1][i] += x * gr;
        }
      });
    }
  }
  const cutoff = auto([[0, 900], [3.5, 1500], [7.0, 2200], [7.4, 1000], [7.5, 600], [14.6, 1100], [17.4, 2500], [17.5, 4000], [22.5, 2800], [74.5, 3000], [74.9, 2300], [107.5, 2000], [108.2, 1000], [112.5, 1800], [119.8, 3000], [120, 2600], [129.8, 3400], [130, 4200], [137.5, 1600]]);
  const fl = svf(), fr = svf();
  for (let i = 0; i < N; i++) { const t = i / SR, c = cutoff(t) * (1 + 0.12 * Math.sin(t * 0.7)); pad[0][i] = fl(pad[0][i], c, 0.8).lp; pad[1][i] = fr(pad[1][i], c * 1.03, 0.8).lp; }
  for (let i = 0; i < N; i++) { send[0][i] += pad[0][i] * 0.35; send[1][i] += pad[1][i] * 0.35; }
}

// ---------------------------------------------------------------------------------------------
// Drums.
// ---------------------------------------------------------------------------------------------
const kicks = [];
function kick(t, amp = 0.5) {
  kicks.push(t);
  let ph = 0;
  for (let i = S(t), j = 0; j < SR * 0.5 && i < N; i++, j++) {
    const u = j / SR, f = 46 + 120 * Math.exp(-u * 30);
    ph += f / SR;
    const x = (Math.sin(2 * Math.PI * ph) * Math.exp(-u * 7) * (1 - Math.exp(-u * 3000)) + white() * Math.exp(-u * 400) * 0.4) * amp;
    add(drums, i, x, x);
  }
}
function hat(t, amp = 0.05, p = 0) {
  const f = svf(), [gl, gr] = pan(p);
  for (let i = S(t), j = 0; j < SR * 0.12 && i < N; i++, j++) { const u = j / SR, x = f(white(), 8000, 0.7).hp * Math.exp(-u * 60) * amp; add(drums, i, x * gl, x * gr); }
}
function clap(t, amp = 0.2) {
  const f = svf();
  for (let i = S(t), j = 0; j < SR * 0.4 && i < N; i++, j++) {
    const u = j / SR;
    let env = Math.exp(-u * 16) * 0.6;
    for (const o of [0, 0.011, 0.022]) if (u >= o) env += Math.exp(-(u - o) * 120);
    const x = f(white(), 1300, 1.1).bp * env * amp;
    add(drums, i, x, x);
    send[0][i] += x * 0.25; send[1][i] += x * 0.25;
  }
}
for (let b = 0; b < BARS.length; b++) {
  for (let s = 0; s < 16; s++) {
    const t = b * BAR + (s * BEAT) / 4, beat = s / 4;
    const on8 = s % 2 === 0, off8 = s % 4 === 2;
    // You in the middle: a clock that speeds up with the copying, then silence under the headline.
    if (t >= 8.75 && t < 12.5 && on8) hat(t, 0.028 + 0.012 * (s % 4 === 0), s % 4 === 0 ? -0.2 : 0.2);
    if (t >= 12.5 && t < 14.7) hat(t, 0.03 + 0.02 * ((t - 12.5) / 2.2), s % 2 ? 0.25 : -0.25);
    // The scenes: lighter and brighter than the machinery that follows.
    if (inRange(t, [[25, 74.7]])) {
      if (beat === 0 || beat === 2) kick(t, 0.3);
      if (beat === 1 || beat === 3) clap(t, 0.12);
      if (off8) hat(t, 0.04, 0.15);
      else if (!on8) hat(t, 0.014, s % 4 === 1 ? -0.3 : 0.3);
    }
    // Grooves.
    const grooveA = inRange(t, [[77.5, 107.5], [112.5, 127.5]]);
    if (grooveA && (beat === 0 || beat === 2)) kick(t, 0.33);
    if (grooveA && off8) hat(t, 0.045, 0.15);
    if (grooveA && t >= 120 && (beat === 1 || beat === 3)) clap(t, 0.16);
  }
}
// Sidechain: the pad and the bass breathe with the kick.
function duckAt(t, depth) {
  let lo = 0, hi = kicks.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (kicks[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  const dt = k >= 0 ? t - kicks[k] : 9;
  return dt < 0.5 ? 1 - depth * Math.exp(-dt / 0.12) : 1;
}
kicks.sort((a, b) => a - b);
{
  let k = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    while (k + 1 < kicks.length && kicks[k + 1] <= t) k++;
    const dt = kicks.length && t >= kicks[k] ? t - kicks[k] : 9;
    const d = dt < 0.5 ? 1 - 0.3 * Math.exp(-dt / 0.12) : 1;
    pad[0][i] *= d; pad[1][i] *= d;
  }
}

// ---------------------------------------------------------------------------------------------
// Bass: the root, low and round, pushed by the kick.
// ---------------------------------------------------------------------------------------------
function bassNote(t, len, midi, amp) {
  const f = mtof(midi);
  let ph = 0;
  for (let i = S(t), j = 0; j < SR * (len + 0.08) && i < N; i++, j++) {
    const u = j / SR;
    const env = Math.min(1, u / 0.006) * (u > len ? Math.max(0, 1 - (u - len) / 0.08) : 1) * (0.75 + 0.25 * Math.exp(-u * 6));
    ph += f / SR;
    const x = Math.tanh(1.6 * Math.sin(2 * Math.PI * ph)) * env * amp * duckAt(t + u, 0.55);
    add(bass, i, x, x);
  }
}
for (let b = 0; b < BARS.length; b++) {
  const t0 = b * BAR, root = CH[BARS[b]].root - 12;
  if (inRange(t0, [[25, 107.5], [112.5, 127.5]])) {
    for (const [beat, len] of [[0, 0.7], [1.5, 0.4], [2, 0.7], [3.5, 0.4]]) bassNote(t0 + beat * BEAT, len * BEAT, root, 0.115);
  } else if (inRange(t0, [[17.5, 25], [130, 137.5], [107.5, 112.5]])) {
    bassNote(t0, BAR * 0.95, root, 0.06);
  } else if (inRange(t0, [[0, 7.5]])) {
    bassNote(t0, BAR * 0.95, root, 0.045);
  }
}

// ---------------------------------------------------------------------------------------------
// Arpeggio: a plucked figure over the chord, into a ping-pong delay.
// ---------------------------------------------------------------------------------------------
function pluck(t, midi, amp, p, decay = 6) {
  const f = mtof(midi), [gl, gr] = pan(p);
  for (let i = S(t), j = 0; j < SR * 1.2 && i < N; i++, j++) {
    const u = j / SR, env = Math.min(1, u / 0.003) * Math.exp(-u * decay);
    const x = (Math.sin(2 * Math.PI * f * u) + 0.28 * Math.sin(4 * Math.PI * f * u) * Math.exp(-u * 14) + 0.12 * Math.sin(6 * Math.PI * f * u) * Math.exp(-u * 20)) * env * amp;
    add(arp, i, x * gl, x * gr);
  }
}
const ORDER = [0, 1, 2, 3, 2, 1, 2, 3];
for (let b = 0; b < BARS.length; b++) {
  const t0 = b * BAR, notes = CH[BARS[b]].notes;
  // In the scenes the pluck steps back a little: the bubbles are the melody there.
  const dense = inRange(t0, [[80, 107.5], [110, 127.5], [25, 75]]), soft = inRange(t0, [[25, 75]]) ? 0.75 : 1;
  const shimmer = inRange(t0, [[0, 7.5], [17.5, 22.5], [130, 137.5]]);
  for (let s = 0; s < 16; s++) {
    const t = t0 + (s * BEAT) / 4;
    if (dense) pluck(t, notes[ORDER[s % 8]] + 12, (s % 4 === 0 ? 0.046 : 0.03) * soft, s % 2 ? 0.35 : -0.35);
    if (shimmer && s % 2 === 0 && t >= 1 && t < DUR - 2) pluck(t, notes[ORDER[(s / 2) % 8]] + 24, 0.028, s % 4 ? 0.5 : -0.5, 2.5);
  }
}
{
  // Dotted-eighth ping-pong.
  const d = Math.round(BEAT * 0.75 * SR), fb = 0.38, wet = 0.32;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const l = i >= d ? R[i - d] : 0, r = i >= d ? L[i - d] : 0;
    L[i] = arp[1][i] * 0.5 + l * fb;
    R[i] = arp[0][i] * 0.5 + r * fb;
  }
  for (let i = 0; i < N; i++) { arp[0][i] += L[i] * wet; arp[1][i] += R[i] * wet; send[0][i] += arp[0][i] * 0.3; send[1][i] += arp[1][i] * 0.3; }
}

// ---------------------------------------------------------------------------------------------
// Sound effects, from the page's cues.
// ---------------------------------------------------------------------------------------------
function sine(t, len, f0, f1, amp, p = 0, decay = 10, rev = 0) {
  const [gl, gr] = pan(p);
  let ph = 0;
  for (let i = S(t), j = 0; j < SR * len && i < N; i++, j++) {
    const u = j / SR, f = f0 * Math.pow(f1 / f0, u / len);
    ph += f / SR;
    const x = Math.sin(2 * Math.PI * ph) * Math.min(1, u / 0.002) * Math.exp(-u * decay) * amp;
    add(sfx, i, x * gl, x * gr);
    if (rev) { send[0][i] += x * gl * rev; send[1][i] += x * gr * rev; }
  }
}
function noiseBurst(t, len, fc, q, amp, p = 0, decay = 30, rev = 0, mode = "bp") {
  const f = svf(), [gl, gr] = pan(p);
  for (let i = S(t), j = 0; j < SR * len && i < N; i++, j++) {
    const u = j / SR, x = f(white(), fc, q)[mode] * Math.min(1, u / 0.001) * Math.exp(-u * decay) * amp;
    add(sfx, i, x * gl, x * gr);
    if (rev) { send[0][i] += x * gl * rev; send[1][i] += x * gr * rev; }
  }
}
let lastTick = -1;
for (const c of cues) {
  const t = c.t;
  switch (c.kind) {
    case "key": {
      const a = 0.05 + 0.035 * rnd();
      noiseBurst(t, 0.03, 3200 + 1800 * rnd(), 1.4, a * 2.2, c.pan ?? 0, 180);
      sine(t, 0.012, 1700 + 600 * rnd(), 1500, a * 0.5, c.pan ?? 0, 300);
      break;
    }
    case "whoosh": {
      const f = svf(), dur = c.dur, amp = 0.05 + 0.07 * clamp(dur / 1.2, 0, 1);
      for (let i = S(t), j = 0; j < SR * dur && i < N; i++, j++) {
        const u = j / (SR * dur), bell = Math.pow(Math.sin(Math.PI * u), 1.6);
        const fc = 380 * Math.pow(7, Math.sin(Math.PI * u) * 0.9 + 0.1 * u);
        const x = f(white(), fc, 1.3).bp * bell * amp, [gl, gr] = pan(c.dir * (u * 1.6 - 0.8));
        add(sfx, i, x * gl, x * gr);
        send[0][i] += x * gl * 0.2; send[1][i] += x * gr * 0.2;
      }
      break;
    }
    case "blip": sine(t, 0.25, mtof(71 + c.n), mtof(71 + c.n), 0.05, c.pan, 18, 0.2); sine(t, 0.1, mtof(83 + c.n), mtof(83 + c.n), 0.012, c.pan, 30); break;
    case "land": sine(t, 0.9, 1318.5, 1318.5, 0.05, c.pan, 6, 0.4); sine(t + 0.004, 0.7, 1975.5, 1975.5, 0.02, c.pan, 8, 0.4); break;
    case "hit": sine(t, 0.6, 95, 48, 0.2, 0, 7, 0.2); noiseBurst(t, 0.2, 700, 0.7, 0.12, 0, 22, 0.2, "lp"); break;
    case "slam": sine(t, 1.2, 72, 36, 0.38, 0, 4.2, 0.3); noiseBurst(t, 0.5, 900, 0.7, 0.3, 0, 10, 0.4, "lp"); break;
    case "impact": {
      const k = c.soft ? 0.5 : 1;
      sine(t, 2.2, 60, 30, 0.36 * k, 0, 2.4, 0.3);
      noiseBurst(t, 0.9, 1100, 0.6, 0.35 * k, 0, 6, 0.55, "lp");
      noiseBurst(t, 1.4, 5200, 0.8, 0.05 * k, -0.3, 3.5, 0.6);
      noiseBurst(t, 1.4, 5600, 0.8, 0.05 * k, 0.3, 3.5, 0.6);
      break;
    }
    case "riser": {
      const f = svf(), dur = c.dur;
      let ph = 0;
      for (let i = S(t), j = 0; j < SR * dur && i < N; i++, j++) {
        const u = j / (SR * dur), fc = 250 * Math.pow(24, u), fade = Math.min(1, (1 - u) * dur / 0.015);
        ph += (180 * Math.pow(4, u)) / SR;
        const x = (f(white(), fc, 1.6).bp * u * u * 0.16 + Math.sin(2 * Math.PI * ph) * u * 0.025) * fade;
        add(sfx, i, x, x);
        send[0][i] += x * 0.3; send[1][i] += x * 0.3;
      }
      break;
    }
    case "pop": sine(t, 0.09, 1150, 620, 0.055, 0, 38, 0.1); break;
    case "bubble": { const f = c.pan < 0 ? 1318.5 : 1568; sine(t, 0.28, f * 0.92, f, 0.038, c.pan, 13, 0.25); sine(t, 0.14, f * 2, f * 2, 0.007, c.pan, 20, 0.15); break; }
    case "dot": { const f = mtof([88, 91, 95][c.n]), p = -0.35 + 0.35 * c.n; sine(t, 0.7, f, f, 0.032, p, 6.5, 0.35); sine(t, 0.3, f * 2, f * 2, 0.007, p, 14, 0.2); break; }
    case "lift": sine(t, 0.5, 420, 980, 0.03, -0.3, 5, 0.3); noiseBurst(t, 0.5, 2200, 1.0, 0.03, -0.3, 6, 0.2); break;
    case "split": sine(t, 0.3, 880, 880, 0.035, -0.6, 12, 0.3); sine(t + 0.05, 0.3, 1318.5, 1318.5, 0.035, 0.6, 12, 0.3); break;
    case "notify": sine(t, 1.0, 1318.5, 1318.5, 0.05, 0.5, 5, 0.45); sine(t + 0.13, 1.1, 1760, 1760, 0.05, 0.5, 4.5, 0.45); break;
    case "click": sine(t, 0.02, 1900, 1400, 0.07, 0.5, 120); noiseBurst(t, 0.01, 4000, 1.0, 0.1, 0.5, 400); break;
    case "tick": if (t - lastTick >= 0.045) { sine(t, 0.012, 2400, 2400, 0.03, 0.3, 200); lastTick = t; } break;
    case "chime": [1046.5, 1318.5, 1568, 2093].forEach((f, k) => sine(t + k * 0.04, 1.6, f, f, 0.035, -0.3 + k * 0.2, 2.6, 0.5)); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Reverb on the send bus (Freeverb), then the mix.
// ---------------------------------------------------------------------------------------------
function freeverb(inL, inR, room = 0.86, damp = 0.3) {
  const scale = SR / 44100, combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], apT = [556, 441, 341, 225], spread = 23;
  const outL = new Float32Array(N), outR = new Float32Array(N);
  for (const [input, output, off] of [[inL, outL, 0], [inR, outR, spread]]) {
    const combs = combT.map((c) => ({ buf: new Float32Array(Math.round((c + off) * scale)), i: 0, store: 0 }));
    const aps = apT.map((a) => ({ buf: new Float32Array(Math.round((a + off) * scale)), i: 0 }));
    for (let n = 0; n < N; n++) {
      const x = input[n] * 0.015;
      let y = 0;
      for (const c of combs) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = y + b * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        y = b - y;
      }
      output[n] = y;
    }
  }
  return [outL, outR];
}
const [revL, revR] = freeverb(send[0], send[1]);

const mix = [new Float32Array(N), new Float32Array(N)];
const fade = auto([[0, 0], [0.4, 1], [DUR - 3.5, 1], [DUR - 0.2, 0], [DUR, 0]]);
for (let c = 0; c < 2; c++) {
  let hp = 0, prev = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let x = pad[c][i] + bass[c][i] + drums[c][i] + arp[c][i] * 0.9 + sfx[c][i] + (c ? revR[i] : revL[i]) * 0.9;
    x *= fade(t);
    hp = 0.9985 * (hp + x - prev); prev = x; // DC blocker, ~12 Hz
    mix[c][i] = hp;
  }
}
let peak = 0;
for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[c][i]));
const gain = 0.9 / peak, knee = 0.75;
const limit = (x) => { const a = Math.abs(x); if (a <= knee) return x; return Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))); };
const pcm = Buffer.alloc(44 + N * 4);
pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + N * 4, 4); pcm.write("WAVE", 8); pcm.write("fmt ", 12);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
pcm.write("data", 36); pcm.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) for (let c = 0; c < 2; c++) pcm.writeInt16LE(Math.round(clamp(limit(mix[c][i] * gain), -1, 1) * 32767), 44 + i * 4 + c * 2);
writeFileSync(path.join(OUT, "music.wav"), pcm);
console.log(`music: ${path.join(OUT, "music.wav")} (raw peak ${peak.toFixed(3)}, gain ${gain.toFixed(2)})`);
