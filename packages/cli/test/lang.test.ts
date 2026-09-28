import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rememberSkillDirs, writeSkillFiles } from "../src/install.js";
import { both, lang, ours, parseLang, savedLang, setLang, t } from "../src/lang.js";
import { skillMarkdown, skillMarkdownZh } from "../src/skill-text.js";

afterEach(() => setLang("en"));

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agenthop-lang-"));
}

describe("language", () => {
  it("is English unless Chinese was chosen", () => {
    expect(lang()).toBe("en");
    expect(t("hello", "你好")).toBe("hello");
    setLang("zh");
    expect(t("hello", "你好")).toBe("你好");
  });

  it("reads the ways people write a language, and nothing else", () => {
    for (const zh of ["zh", "ZH", "zh-CN", "zh_CN", "zh-Hans", "cn", " zh "]) expect(parseLang(zh), zh).toBe("zh");
    for (const en of ["en", "EN", "en-US", "en_GB"]) expect(parseLang(en), en).toBe("en");
    for (const other of ["", "fr", "chinese", undefined, 1]) expect(parseLang(other), String(other)).toBeUndefined();
  });

  it("sends a reason in both languages, and shows the half this side reads", () => {
    const reason = both("Someone has already joined", "已经有人加入了");
    expect(reason).toContain("Someone has already joined");
    expect(reason).toContain("已经有人加入了");
    expect(ours(reason)).toBe("Someone has already joined");
    setLang("zh");
    expect(ours(reason)).toBe("已经有人加入了");
    // One language only, or a slash in ordinary words, is shown as it came.
    expect(ours("只有中文的理由")).toBe("只有中文的理由");
    expect(ours("either a / b will do")).toBe("either a / b will do");
  });
});

describe("install --lang", () => {
  it("keeps the language beside the skill directories", async () => {
    const dir = await home();
    const skills = path.join(dir, "skills");
    await mkdir(skills);
    expect(savedLang(dir)).toBeUndefined();
    rememberSkillDirs([skills], dir);
    rememberSkillDirs([], dir, "zh");
    expect(JSON.parse(await readFile(path.join(dir, ".agenthop", "install.json"), "utf8"))).toEqual({ skillDirs: [skills], lang: "zh" });
    // A later install that names no language leaves the one already chosen.
    rememberSkillDirs([], dir);
    expect(savedLang(dir)).toBe("zh");
    await writeFile(path.join(dir, ".agenthop", "install.json"), "{ not json");
    expect(savedLang(dir)).toBeUndefined();
  });

  it("writes the skill in the language it speaks", async () => {
    const dir = await home();
    const skills = path.join(dir, "skills");
    setLang("zh");
    writeSkillFiles([skills], dir);
    expect(await readFile(path.join(skills, "SKILL.md"), "utf8")).toBe(skillMarkdownZh);
    setLang("en");
    writeSkillFiles([skills], dir);
    expect(await readFile(path.join(skills, "SKILL.md"), "utf8")).toBe(skillMarkdown);
    expect(skillMarkdown).not.toMatch(/[一-鿿]/);
    expect(skillMarkdownZh).toMatch(/[一-鿿]/);
  });
});
