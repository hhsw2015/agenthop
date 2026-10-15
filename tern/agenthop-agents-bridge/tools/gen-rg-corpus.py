#!/usr/bin/env python3 -I
"""Regenerate test/rg-diff/corpus.lua: ripgrep (Rust regex) truth for every regex/line_regex in the herdr manifests over a
seeded corpus of inputs mixing Unicode whitespace, fullwidth punctuation, symbols, spinners and manifest keywords.
Usage: gen-rg-corpus.py /path/to/rg ~/Dev/herdr/src/detect/manifests > test/rg-diff/corpus.lua"""
import subprocess, random, glob, os, tomllib, sys
RG, MAN = sys.argv[1], sys.argv[2]
pats = set()
def walk(g):
    for k in ("regex", "line_regex"):
        for p in g.get(k, []): pats.add(p)
    for k in ("all", "any", "not"):
        for x in g.get(k, []): walk(x)
for f in glob.glob(os.path.join(MAN, "*.toml")):
    for r in tomllib.load(open(f, "rb"))["rules"]: walk(r)
pats = sorted(pats)
random.seed(1041)
atoms = ["❯","⠋","⠙","⠹ ","◐","◑","●","✳","⬡","⬢","🌕","🌗","■","⬝"," ","\u2003","\u3000","\u00a0","\t","x","Yes","yes","no","No","1.","2.","3.",
 "Thinking","working...","using ","Run","Read","Search","List","ing","opencode","esc ","again to ","interrupt","allow","(y)","approve","?",
 "question","tasks","/tasks","background","kimi","[2 agents running]","\uff0c","\u00d7","\u00e9","\u0416","_","9","4;0","\u0085","Action Required"]
inputs = ["".join(random.choice(atoms) for _ in range(random.randint(1, 9))) for _ in range(500)]
data = ("\n".join(inputs) + "\n").encode()
truth = {}
for p in pats:  # (?-m:...) keeps the pattern's own flags but stops rg's default multi-line anchors
    r = subprocess.run([RG, "--no-config", "--text", "-n", "-e", "(?-m:" + p + ")", "-"], input=data, capture_output=True)
    hit = {int(l.split(b":", 1)[0]) for l in r.stdout.split(b"\n") if b":" in l}
    truth[p] = "".join("1" if (i + 1) in hit else "0" for i in range(len(inputs)))
q = lambda s: '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t").replace("\r", "\\r") + '"'
ver = subprocess.run([RG, "--version"], capture_output=True, text=True).stdout.splitlines()[0]
print(f"-- GENERATED: {ver} truth for {len(pats)} manifest patterns x {len(inputs)} Unicode inputs (tools/gen-rg-corpus.py). Do not hand-edit.")
print("return {")
print("  pats = {" + ", ".join(q(p) for p in pats) + "},")
print("  inputs = {" + ", ".join(q(s) for s in inputs) + "},")
print("  truth = {")
for p in pats: print("    [" + q(p) + "] = \"" + truth[p] + "\",")
print("  },")
print("}")
