#!/usr/bin/env tsx
/**
 * worklog-backfill — one-time seed of worklog.jsonl from the control-log (brain: worklog-timeline, 90b58f9c).
 *
 * The worklog is a PROJECTION of the control-log, not a second ledger, so history is replayed through the SAME
 * builder the live dispatcher hook uses (packages/bus/src/swarm/worklog.ts) — a backfilled line is byte-identical
 * to a live one. Each `<seq>.json` batch file's mtime is the wall-clock the dispatcher committed that transition;
 * that is the event's ts (the control change itself carries no wall-clock, only a future deadlineSec).
 *
 * Writer-side one-shot, so importing the bus builder is correct (single source of the line format for all
 * writers). The reader (scripts/projection.ts) stays independent of bus by discipline C-2.
 *
 * Usage:
 *   tsx scripts/worklog-backfill.ts [--home DIR] [--dry] [--force]
 *     --dry     print a summary, write nothing (the operator check)
 *     --force   overwrite an existing worklog.jsonl (default: refuse, to not clobber live appends)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { worklogLinesFromBatch, WORKLOG_FILE, type ControlChangeLike } from "../packages/bus/src/swarm/worklog.js";

interface Batch {
  seq: number;
  changes: ControlChangeLike[];
}

export function backfillLines(controlDir: string): string[] {
  if (!existsSync(controlDir)) return [];
  const files = readdirSync(controlDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => ({ f, seq: Number(f.slice(0, -".json".length)) }))
    .sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  for (const { f } of files) {
    const full = path.join(controlDir, f);
    let batch: Batch;
    try {
      batch = JSON.parse(readFileSync(full, "utf8")) as Batch;
    } catch {
      continue; // a torn/partial batch file: skip, replay the rest (replayLog would also reject it)
    }
    const mtimeSec = Math.floor(statSync(full).mtimeMs / 1000);
    lines.push(...worklogLinesFromBatch(batch.changes, mtimeSec));
  }
  return lines;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = opt("--home") ?? homedir();
  const swarm = path.join(home, ".agenthop", "swarm");
  const controlDir = path.join(swarm, "control-log");
  const out = path.join(swarm, WORKLOG_FILE);

  const lines = backfillLines(controlDir);
  const kinds = lines.reduce<Record<string, number>>((m, l) => {
    const k = (JSON.parse(l).event as string) ?? "?";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

  if (flag("--dry")) {
    console.log(`[dry] control-log: ${controlDir}`);
    console.log(`[dry] would write ${lines.length} worklog line(s) to ${out}`);
    console.log(`[dry] event kinds: ${JSON.stringify(kinds)}`);
    if (lines.length) {
      console.log(`[dry] first: ${lines[0]!.trimEnd()}`);
      console.log(`[dry] last:  ${lines[lines.length - 1]!.trimEnd()}`);
    }
    return;
  }

  if (existsSync(out) && !flag("--force")) {
    console.error(`refuse: ${out} already exists. Re-run with --force to overwrite, or --dry to preview.`);
    process.exit(1);
  }

  writeFileSync(out, lines.join(""));
  console.log(`wrote ${lines.length} worklog line(s) to ${out} (kinds ${JSON.stringify(kinds)})`);
}

// Guard so the module can be imported (e.g. by a test) without running (msglog P1 lesson).
if (process.argv[1] && /(^|\/)worklog-backfill\.ts$/.test(process.argv[1])) main();
