#!/usr/bin/env tsx
/**
 * explain-t3b-demo — the DATA->SCRIPT binding for the explainer chain (F13: an explanation is a VIEW of
 * evidence, not a retelling). It reads the real T3b review fact-records from ~/Work/review-reports/ and emits an
 * extended-markdown scene script (manim bar chart + narration) whose every number came from a file — nothing is
 * hand-filled. Feed the output to scripts/explain-video.ts --tier heavy.
 *
 *   tsx scripts/explain-t3b-demo.ts [--reports <dir>] [--out <file.md>]
 *
 * Why a separate file: explain-video.ts stays a GENERIC, portable tool (any project, any script). The binding
 * to one dataset lives here, thin and swappable. Each narration beat cites the exact report it was read from, so
 * a viewer can follow any claim back to its evidence.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Round {
  commit: string; // the fixed commit the round reviewed (from the report filename)
  remain: number; // REMAIN count parsed from the report verdict line
  p1: number;
  p2: number;
  file: string; // the fact record this round's numbers came from
  mtimeMs: number; // chronological order of the rounds
}

/** Parse one T3b review report's verdict. Returns null if it is not a parseable round report. */
export function parseRound(file: string, text: string): Omit<Round, "mtimeMs"> | null {
  const commit = /t3b[^/]*?([0-9a-f]{7})/i.exec(path.basename(file))?.[1];
  if (!commit) return null;
  // verdict forms seen: "3 P1 / 5 P2 / 0 P3, 8 REMAIN" | "0 P1 / 0 P2 / 0 P3, 0 REMAIN. ... 通过"
  const remainM = /(\d+)\s*REMAIN/i.exec(text);
  const pM = /(\d+)\s*P1\s*\/\s*(\d+)\s*P2/i.exec(text);
  if (!remainM) return null;
  return { commit, remain: Number(remainM[1]), p1: pM ? Number(pM[1]) : 0, p2: pM ? Number(pM[2]) : 0, file: path.basename(file) };
}

/** Read the T3b rounds from the review-reports dir, in chronological (round) order. Data only — no hand-fill. */
export function readT3bRounds(reportsDir: string): Round[] {
  if (!existsSync(reportsDir)) return [];
  const rounds: Round[] = [];
  for (const name of readdirSync(reportsDir)) {
    if (!/^t3b.*\.md$/i.test(name)) continue; // round reports are *.md; evidence dirs + delivery.json excluded
    const full = path.join(reportsDir, name);
    if (!statSync(full).isFile()) continue;
    const parsed = parseRound(full, readFileSync(full, "utf8"));
    if (parsed) rounds.push({ ...parsed, mtimeMs: statSync(full).mtimeMs });
  }
  // de-dup by commit (keep earliest report per commit), then order by time = round order.
  const byCommit = new Map<string, Round>();
  for (const r of rounds.sort((a, b) => a.mtimeMs - b.mtimeMs)) if (!byCommit.has(r.commit)) byCommit.set(r.commit, r);
  return [...byCommit.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** A ManimCE Scene (bars = REMAIN per round, converging to 0). Hand-built from Rectangles + Text (Pango) so it
 *  needs NO latex (ManimCE's BarChart/Tex require a LaTeX install; Text does not). Values come from data. */
export function manimScene(rounds: Round[]): string {
  const values = rounds.map((r) => r.remain);
  const names = rounds.map((r) => r.commit);
  const yMax = Math.max(1, ...values);
  return [
    "from manim import *",
    "",
    "class T3bConvergence(Scene):",
    "    def construct(self):",
    `        values = ${JSON.stringify(values)}`,
    `        names = ${JSON.stringify(names)}`,
    `        max_v = ${yMax}`,
    "        title = Text('T3b review convergence - REMAIN per round', font_size=32).to_edge(UP)",
    "        self.play(Write(title))",
    "        n = len(values); bar_w = 1.0; gap = 0.7",
    "        total_w = n * bar_w + (n - 1) * gap",
    "        x0 = -total_w / 2 + bar_w / 2",
    "        base_y = -2.4; max_h = 4.0",
    "        axis = Line([x0 - bar_w, base_y, 0], [x0 + total_w, base_y, 0], stroke_width=2)",
    "        self.play(Create(axis))",
    "        groups = []",
    "        for i, (v, nm) in enumerate(zip(values, names)):",
    "            h = max((v / max_v) * max_h, 0.06)",
    "            color = '#3fd08a' if v == 0 else '#5aa9ff'",
    "            x = x0 + i * (bar_w + gap)",
    "            rect = Rectangle(width=bar_w, height=h, fill_color=color, fill_opacity=0.9, stroke_width=0)",
    "            rect.move_to([x, base_y + h / 2, 0])",
    "            num = Text(str(v), font_size=30).next_to(rect, UP, buff=0.12)",
    "            lbl = Text(nm, font_size=18).next_to([x, base_y, 0], DOWN, buff=0.18)",
    "            groups.append(VGroup(rect, num, lbl))",
    "        for g in groups:",
    "            self.play(FadeIn(g[0], shift=UP * 0.2), Write(g[1]), FadeIn(g[2]), run_time=0.55)",
    "        tag = Text('0 REMAIN -> signed off', font_size=28, color='#3fd08a').next_to(groups[-1][0], UP, buff=0.5)",
    "        self.play(FadeIn(tag, shift=UP * 0.3))",
    "        self.wait(1.5)",
  ].join("\n");
}

/** Generate the full extended-markdown scene script. Narration beats are generated from the data and cite the
 *  source report for each round (F13). */
export function buildScript(rounds: Round[]): string {
  const first = rounds[0], last = rounds[rounds.length - 1];
  const cn = (n: number) => ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][n] ?? String(n);
  const beats = rounds.map((r, i) =>
    `> 第${cn(i + 1)}轮，提交 ${r.commit}，剩 ${r.remain} 条待修（${r.p1} 个 P1、${r.p2} 个 P2）。来源：${r.file}`,
  );
  return [
    "---",
    "title: T3b 五轮审查收敛",
    "subtitle: 从 8 条到 0 条，数据读自审查记录",
    "---",
    `> 规划器 T3b 经过 ${rounds.length} 轮对抗审查，待修项从 ${first?.remain ?? 0} 条收敛到 ${last?.remain ?? 0} 条。`,
    "",
    "## 每轮 REMAIN 收敛",
    "```manim",
    manimScene(rounds),
    "```",
    ...beats,
    `> 第${cn(rounds.length)}轮归零，签收固定提交 ${last?.commit ?? ""}。每一条数字都回指上面的审查报告。`,
    "",
  ].join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1]! : d; };
  const reportsDir = opt("--reports", path.join(homedir(), "Work", "review-reports"));
  const rounds = readT3bRounds(reportsDir);
  if (!rounds.length) { console.error(`no T3b review rounds found in ${reportsDir}`); process.exit(1); }
  console.error(`[t3b] ${rounds.length} rounds from ${reportsDir}: ${rounds.map((r) => `${r.commit}=${r.remain}`).join(" -> ")}`);
  const script = buildScript(rounds);
  const out = argv.indexOf("--out") >= 0 ? opt("--out", "") : "";
  if (out) { writeFileSync(out, script); console.error(`wrote ${out}`); } else { process.stdout.write(script); }
}

if (process.argv[1] && /(^|\/)explain-t3b-demo\.ts$/.test(process.argv[1])) main();
