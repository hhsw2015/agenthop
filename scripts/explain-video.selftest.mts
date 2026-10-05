// Selftest for explain-video's pure core (tier select, scene parse, the fail->fix->re-render loop, alignment,
// voice mapping). No manim/ffmpeg/network — those are IO shells exercised by the real acceptance runs.
//   packages/bus/node_modules/.bin/tsx scripts/explain-video.selftest.mts
import {
  amVoiceEnv, lengthUnits, parseScenes, planAlignment, renderWithRetry, selectTier,
  splitSentences, steLint, steSimplify,
  type CpaConfig, type RenderOutcome,
} from "./explain-video.js";

const t = (name: string, cond: boolean) => {
  if (!cond) throw new Error("FAILED: " + name);
  console.log("ok  " + name);
};

// --- tier selection: a ```manim fence => heavy, else light ---
{
  t("no fence -> light", selectTier("## step\n```flow\nA->B\n```\n> narration") === "light");
  t("manim fence -> heavy", selectTier("## x\n```manim\nclass S(Scene): pass\n```") === "heavy");
  t("manim fence with trailing space -> heavy", selectTier("```manim \nclass S(Scene): pass\n```") === "heavy");
  t("a word 'manim' in prose is not a fence", selectTier("we use manim sometimes\n> n") === "light");
}

// --- scene parsing: headings, manim blocks + class name, narration lines ---
{
  const script = [
    "---", "title: T", "---",
    "> intro beat",
    "## First",
    "```manim",
    "class TriState(Scene):",
    "    def construct(self): pass",
    "```",
    "> alive, suspected, dead.",
    "> three faces of liveness.",
    "## Second",
    "```flow", "A -> B", "```",
    "> a discrete step.",
  ].join("\n");
  const scenes = parseScenes(script);
  t("preamble narration captured", scenes[0]!.narration[0] === "intro beat");
  const first = scenes.find((s) => s.heading === "First")!;
  t("manim block captured", first.manim!.includes("class TriState"));
  t("manim class name extracted", first.manimClass === "TriState");
  t("scene narration captured (two beats)", first.narration.length === 2 && first.narration[1] === "three faces of liveness.");
  const second = scenes.find((s) => s.heading === "Second")!;
  t("a non-manim fence is not treated as manim", second.manim === null);
  t("narration after a non-manim fence still captured", second.narration[0] === "a discrete step.");
}
{
  // manim fence with no Scene subclass -> class is null (orchestration surfaces this as an error)
  const s = parseScenes("## x\n```manim\nprint('hi')\n```")[0]!;
  t("manim block without a Scene class -> manimClass null", s.manim !== null && s.manimClass === null);
}

// --- the render/fix/retry loop (the tested heart; contract: max 3 rounds then downgrade) ---
{
  // always-failing render, no fixer -> exactly maxRounds attempts, then downgrade
  let calls = 0;
  const r = await renderWithRetry({
    code: "bad", maxRounds: 3,
    render: async () => { calls++; return { ok: false, error: `boom ${calls}` } as RenderOutcome; },
  });
  t("bad code, no fixer -> downgraded", r.downgraded && !r.ok);
  t("bad code -> exactly maxRounds render attempts", calls === 3 && r.rounds === 3);
  t("downgrade carries the last error", (r.lastError ?? "").includes("boom 3"));
}
{
  // a fixer that eventually produces good code -> succeeds mid-loop, no downgrade
  let round = 0;
  const r = await renderWithRetry({
    code: "v0", maxRounds: 3,
    render: async (code) => { round++; return code === "fixed" ? { ok: true, video: "/x.mp4" } : { ok: false, error: "nope" }; },
    fix: async () => "fixed",
  });
  t("fixer repairs -> success before the cap", r.ok && r.video === "/x.mp4" && !r.downgraded);
  t("succeeded on the second round (after one fix)", r.rounds === 2);
}
{
  // first render already succeeds -> one round, no fix
  let fixCalled = false;
  const r = await renderWithRetry({ code: "good", render: async () => ({ ok: true, video: "/v.mp4" }), fix: async () => { fixCalled = true; return "x"; } });
  t("good code -> one round, fixer never called", r.ok && r.rounds === 1 && !fixCalled);
}
{
  // a throwing fixer must not crash the loop; it degrades like a no-op fixer
  const r = await renderWithRetry({ code: "bad", maxRounds: 2, render: async () => ({ ok: false, error: "e" }), fix: async () => { throw new Error("fixer down"); } });
  t("throwing fixer -> still downgrades cleanly", r.downgraded && r.rounds === 2);
}

// --- alignment: scene duration = max(video, audio); hold = how long to freeze video; measured, not estimated ---
{
  const plan = planAlignment([
    { videoSec: 5, audioSec: 8 }, // audio longer -> hold 3s
    { videoSec: 10, audioSec: 4 }, // video longer -> no hold
    { videoSec: 0, audioSec: 0 }, // silent/empty -> 0
  ]);
  t("audio longer -> hold the delta", plan.scenes[0]!.holdSec === 3 && plan.scenes[0]!.sceneSec === 8);
  t("video longer -> no hold", plan.scenes[1]!.holdSec === 0 && plan.scenes[1]!.sceneSec === 10);
  t("empty scene -> zero", plan.scenes[2]!.sceneSec === 0);
  t("total is the sum of scene durations", plan.totalSec === 8 + 10 + 0);
  t("negative inputs clamped", planAlignment([{ videoSec: -1, audioSec: -2 }]).scenes[0]!.sceneSec === 0);
}

// --- voice mapping to am-video TTS settings ---
{
  const cpa: CpaConfig = { baseUrl: "http://cpa:8318", apiKey: "k", doubaoModel: "doubao-tts", doubaoVoice: "dv", elevenModel: "eleven_flash_v2_5", elevenVoice: "ev" };
  t("say -> am system", amVoiceEnv("say", cpa).flag === "system");
  t("off -> am off", amVoiceEnv("off", cpa).flag === "off");
  const d = amVoiceEnv("doubao", cpa);
  t("doubao -> am local via CPA", d.flag === "local" && d.env.AM_TTS_URL === "http://cpa:8318" && d.env.AM_TTS_MODEL === "doubao-tts" && d.env.AM_TTS_VOICE === "dv" && d.env.AM_TTS_API_KEY === "k");
  const e = amVoiceEnv("eleven", cpa);
  t("eleven -> am local via CPA with eleven model", e.flag === "local" && e.env.AM_TTS_MODEL === "eleven_flash_v2_5" && e.env.AM_TTS_VOICE === "ev");
  t("no api key -> AM_TTS_API_KEY omitted", amVoiceEnv("doubao", { ...cpa, apiKey: "" }).env.AM_TTS_API_KEY === undefined);
}

// --- controlled-language (ASD-STE100-inspired) narration pass ---
{
  // sentence splitting on Latin + CJK terminators
  t("splits latin sentences", splitSentences("One idea. Two ideas! Three?").length === 3);
  t("splits cjk sentences", splitSentences("第一句。第二句！第三句？").length === 3);
  // length units: words for latin, non-space chars for cjk
  t("latin length = word count", lengthUnits("one two three") === 3);
  t("cjk length = char count", lengthUnits("第一轮提交") === 5);
}
{
  // lint flags overlong + passive
  const longLatin = "this one sentence just keeps going and going with far too many separate ideas crammed in so that nobody listening can follow the thread at all really";
  t("flags an overlong latin sentence", steLint(longLatin).some((w) => w.kind === "too-long"));
  t("flags passive voice", steLint("the file was created by the job.").some((w) => w.kind === "passive"));
  t("short active sentence is clean", steLint("The job writes the file.").length === 0);
  const longCjk = "第一轮提交之后我们发现了很多很多的问题并且这些问题牵涉到好几个不同的模块所以需要分好几轮来逐一修复直到全部归零为止";
  t("flags an overlong cjk sentence", steLint(longCjk).some((w) => w.kind === "too-long"));
}
{
  // deterministic simplify: break an overlong sentence at clause punctuation into shorter sentences
  const out = steSimplify("第一轮，提交 bccf629，剩 8 条待修，其中三个是 P1，五个是 P2，都要逐一关闭才能收敛");
  t("overlong cjk split into multiple sentences", splitSentences(out).length >= 3);
  t("numbers preserved verbatim through split", out.includes("bccf629") && out.includes("8") && out.includes("P1"));
  // a short sentence is left alone (idempotent-ish)
  t("short sentence unchanged in meaning", steSimplify("The job writes the file.").includes("The job writes the file"));
  // nothing to split on -> left as-is (no clause punctuation)
  t("no clause punctuation -> unchanged", steSimplify("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt uuuu").split(".").length <= 2);
}

console.log("all explain-video selftests passed");
