#!/usr/bin/env python3
"""tern-restore: bring every roster seat back up in Tern with one command.

Truth source = `tern ls --json` (daemon side), never the bridge mirror (agents.json can freeze).
Steps: (1) read roster  (2) READ-ONLY posture check of ~/.claude.json (never written)
       (3) per seat: skip if a live block already runs `--resume <sid>`, else `tern new tab` + `tern rename`
       (4) codex exclusivity check (a codex thread can be held by only one client)
       (5) assert via tern ls --json: every seat live, once, with the pinned model in its command.
Idempotent: a second run starts nothing. Exit: 0 all seats OK, 1 assertion failed, 2 usage/roster error.
Env (tests): TERN_BIN (default tern), CLAUDE_JSON (default ~/.claude.json), RESTORE_PS (ps output file instead of `ps`).
"""
import json, os, shlex, subprocess, sys, time

TERN = os.environ.get("TERN_BIN", "tern")
CLAUDE_JSON = os.path.expanduser(os.environ.get("CLAUDE_JSON", "~/.claude.json"))


def tern(*args):
    r = subprocess.run([TERN, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"tern {' '.join(args)} failed rc={r.returncode}: {r.stderr.strip()}")
    return r.stdout


def blocks(session):
    """Every block of `session` as (tab_name, block) from tern ls --json."""
    d = json.loads(tern("ls", "--json"))
    out = []
    for s in d.get("sessions", []):
        if s.get("name") != session:
            continue
        for t in s.get("tabs", []):
            for b in t.get("blocks", []):
                out.append((t.get("name"), b))
    return out


def launch_cmd(seat):
    parts = ["tern", "acp", seat["tool"], "--resume", seat["sid"]]
    if seat["tool"] == "claude":
        parts += ["--mode", "bypassPermissions"]
    if seat.get("model"):
        parts += ["--model", seat["model"]]
    return parts


def runs_sid(block, sid):
    cmd = block.get("command") or ""
    return block.get("live") and block.get("exited") is None and (f"--resume {sid}" in cmd or f"--resume={sid}" in cmd)


def posture_check(roster):
    """READ ONLY. Never writes ~/.claude.json: global security posture is a human decision."""
    lines, ok = [], True
    try:
        d = json.load(open(CLAUDE_JSON))
    except (OSError, ValueError) as e:
        return False, [f"posture: cannot read {CLAUDE_JSON}: {e}"]
    bp = d.get("bypassPermissionsModeAccepted") is True
    ok &= bp
    lines.append(f"posture: bypassPermissionsModeAccepted {'present' if bp else 'ABSENT'}")
    projects = d.get("projects", {})
    for cwd in sorted({os.path.expanduser(s["cwd"]) for s in roster["seats"] if s["tool"] == "claude"}):
        p = projects.get(cwd)
        tr = isinstance(p, dict) and p.get("hasTrustDialogAccepted") is True
        ok &= tr
        lines.append(f"posture: trust {cwd} {'present' if tr else 'ABSENT'}")
    if not ok:
        lines.append("posture: ABSENT flags make ACP seats show an approval dialog at first start. "
                     "This script does not change them. Set them by hand (a human decision), e.g. "
                     "accept the dialog once in each seat, or edit ~/.claude.json after a backup.")
    return ok, lines


def codex_conflicts(roster):
    """A codex thread is exclusive. Report non-Tern processes that hold a roster codex sid."""
    if os.environ.get("RESTORE_PS"):
        text = open(os.environ["RESTORE_PS"]).read()
    else:
        text = subprocess.run(["ps", "axo", "pid,command"], capture_output=True, text=True).stdout
    hits = []
    for s in roster["seats"]:
        if s["tool"] != "codex":
            continue
        for line in text.splitlines():
            if s["sid"] in line and "tern acp" not in line and "codex" in line:
                hits.append(f"codex-exclusive: {s['role']} sid {s['sid'][:8]} also held outside Tern: {line.strip()[:120]}")
    return hits


def restore(roster, wait_s=8.0):
    session = roster["session"]
    report = []
    existing = blocks(session)
    for seat in roster["seats"]:
        live = [b for _, b in existing if runs_sid(b, seat["sid"])]
        if live:
            report.append(f"skip: {seat['role']} already live (block {live[0]['id']})")
            continue
        out = tern("new", "tab", session, "--cwd", os.path.expanduser(seat["cwd"]), "--", *launch_cmd(seat))
        bid = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if not bid.isdigit():
            raise RuntimeError(f"tern new tab for {seat['role']} returned no block id: {out!r}")
        tern("rename", bid, seat["role"])
        report.append(f"start: {seat['role']} block {bid}")
    # assertion phase reads tern ls fresh; give new blocks a moment to register as live
    deadline = time.time() + wait_s
    while True:
        fails = verify(roster)
        if not fails or time.time() >= deadline:
            break
        time.sleep(0.5)
    return report, fails


def verify(roster):
    fails = []
    now = blocks(roster["session"])
    for seat in roster["seats"]:
        live = [(tab, b) for tab, b in now if runs_sid(b, seat["sid"])]
        if len(live) == 0:
            fails.append((seat["role"], "not live"))
            continue
        if len(live) > 1:
            fails.append((seat["role"], f"live {len(live)}x (duplicate blocks {[b['id'] for _, b in live]})"))
        tab, b = live[0]
        cmd = b.get("command") or ""
        if seat.get("model"):
            argv = shlex.split(cmd) if cmd else []
            got = argv[argv.index("--model") + 1] if "--model" in argv[:-1] else None
            if got != seat["model"]:
                fails.append((seat["role"], f"model {got!r} != pinned {seat['model']!r}"))
        if tab != seat["role"]:
            fails.append((seat["role"], f"tab name {tab!r}"))
    return fails


def main(argv):
    path = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "roster.json")
    check_only = "--check" in argv
    try:
        roster = json.load(open(path))
        assert roster["session"] and roster["seats"]
    except (OSError, ValueError, KeyError, AssertionError) as e:
        print(f"roster error: {path}: {e}", file=sys.stderr)
        return 2
    t0 = time.time()
    _, lines = posture_check(roster)
    for l in lines:
        print(l)
    for c in codex_conflicts(roster):
        print(c)
    if check_only:
        fails = verify(roster)
    else:
        report, fails = restore(roster)
        for l in report:
            print(l)
    for role, msg in fails:
        print(f"FAIL: {role}: {msg}")
    n = len(roster["seats"])
    print(f"result: {n - len({r for r, _ in fails})}/{n} seats OK in {time.time() - t0:.1f}s")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
