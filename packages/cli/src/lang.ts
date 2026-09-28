import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The language everything here speaks to people and agents: English, unless Chinese was chosen —
 * for one process with AGENTHOP_LANG, or for good with `agenthop install --lang zh`, which
 * install.json keeps. Only the words change. State words, the log's layout and the wire are the
 * same in both, so two sides need not speak the same one.
 */
export type Lang = "en" | "zh";

export function parseLang(value: unknown): Lang | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (v === "zh" || v.startsWith("zh-") || v === "cn") return "zh";
  if (v === "en" || v.startsWith("en-")) return "en";
  return undefined;
}

/** The language `install --lang` kept, if it kept one. */
export function savedLang(home = homedir()): Lang | undefined {
  try {
    return parseLang((JSON.parse(readFileSync(path.join(home, ".agenthop", "install.json"), "utf8")) as { lang?: unknown }).lang);
  } catch {
    return undefined;
  }
}

/** The language someone chose, if anyone did: for this process, or for good. */
export function chosenLang(): Lang | undefined {
  return parseLang(process.env.AGENTHOP_LANG) ?? savedLang();
}

let current: Lang = chosenLang() ?? "en";

export function lang(): Lang {
  return current;
}

/** For `install --lang`, which writes the skill in the language it has just chosen, and for tests. */
export function setLang(next: Lang): void {
  current = next;
}

/**
 * One thing said in both languages, English first. Called where the words are used, never kept
 * in a constant: a constant would keep the language that was current when the module loaded.
 */
export function t(en: string, zh: string): string {
  return current === "zh" ? zh : en;
}

const CJK = /[\u4e00-\u9fff]/;

/**
 * What goes back to the other side, which may read either language — or run a version from
 * before English, which recognises some of these by their Chinese words. Both halves, English first.
 */
export function both(en: string, zh: string): string {
  return `${en} / ${zh}`;
}

/** The half of `both` this side reads. Anything else is shown as it came. */
export function ours(text: string): string {
  const cut = text.indexOf(" / ");
  if (cut < 0) return text;
  const en = text.slice(0, cut);
  const zh = text.slice(cut + 3);
  return CJK.test(zh) && !CJK.test(en) ? t(en, zh) : text;
}
