#!/usr/bin/env python3
"""tern-restore: bring every roster seat back up in Tern with one command.

Truth source = `tern ls --json` (daemon side), never the bridge mirror (agents.json can freeze).
Steps: (1) read roster  (2) READ-ONLY posture check of ~/.claude.json (never written)
       (3) per seat: skip if a live block already runs `--resume <sid>`, else `tern new tab` + `tern rename`
       (4) codex exclusivity check (a codex thread can be held by only one client)
       (5) assert via tern ls --json: every seat live, once, with the pinned model in its command.
Idempotent: a second run starts nothing. Exit: 0 all seats OK, 1 assertion failed, 2 usage/roster error.
Presence: ACP seats do not run the SessionStart hook, so nothing writes ~/.agenthop/presence/<sid>.pid for them (F40
addressing goes blind, inbox sentinel reports STALL). After the assert, write <sid>.pid = the agent pid found by walking
DOWN from the block's `tern acp` child (tern process BLOCK --json) to its descendant that resumes <sid> (claude stream-json;
for codex the node adapter child). Bare pid, temp+rename. Keep an existing pid only if it is alive AND is that same
descendant; a live pid of a DIFFERENT process is replaced (a wrong pid routes by another seat's liveness). --check asserts it.
Env (tests): TERN_BIN (default tern), CLAUDE_JSON (default ~/.claude.json), RESTORE_PS (ps output file instead of `ps`),
PRESENCE_DIR (default ~/.agenthop/presence).
"""
import json, os, shlex, subprocess, sys, time

TERN = os.environ.get("TERN_BIN", "tern")
CLAUDE_JSON = os.path.expanduser(os.environ.get("CLAUDE_JSON", "~/.claude.json"))
PRESENCE_DIR = os.path.expanduser(os.environ.get("PRESENCE_DIR", "~/.agenthop/presence"))


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


def ps_table():
    """{pid: (ppid, command)} from ps (or RESTORE_PS file: lines 'pid ppid command')."""
    if os.environ.get("RESTORE_PS"):
        text = open(os.environ["RESTORE_PS"]).read()
    else:
        text = subprocess.run(["ps", "axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    t = {}
    for line in text.splitlines():
        f = line.split(None, 2)
        if len(f) >= 2 and f[0].isdigit() and f[1].isdigit():
            t[int(f[0])] = (int(f[1]), f[2] if len(f) > 2 else "")
    return t


def agent_pid(block_id, seat, table):
    """Walk down from the block's `tern acp` child to the agent process for this seat. None if not found."""
    try:
        root = json.loads(tern("process", str(block_id), "--json"))["child"]["pid"]
    except (RuntimeError, ValueError, KeyError, TypeError):
        return None
    kids = {}
    for pid, (ppid, _) in table.items():
        kids.setdefault(ppid, []).append(pid)
    frontier, seen, desc = [root], set(), []
    while frontier:
        p = frontier.pop()
        for c in kids.get(p, []):
            if c not in seen:
                seen.add(c); desc.append(c); frontier.append(c)
    if seat["tool"] == "claude":
        hits = [p for p in desc if "stream-json" in table[p][1] and seat["sid"] in table[p][1]]
    else:  # codex: the adapter (node) child of tern acp; codex app-server below it carries no sid
        hits = [p for p in kids.get(root, []) if "node" in table[p][1] or "codex" in table[p][1]]
    return hits[0] if len(hits) == 1 else None


def presence(roster, write):
    """Write (or with write=False only check) presence/<sid>.pid for every live seat. Returns (lines, fails)."""
    table, lines, fails = ps_table(), [], []
    live = {}
    for _, b in blocks(roster["session"]):
        for seat in roster["seats"]:
            if runs_sid(b, seat["sid"]):
                live.setdefault(seat["sid"], b["id"])
    for seat in roster["seats"]:
        if seat["sid"] not in live:
            continue
        want = agent_pid(live[seat["sid"]], seat, table)
        f = os.path.join(PRESENCE_DIR, seat["sid"] + ".pid")
        try:
            raw = open(f).read().strip()
            have = int(raw) if raw.isascii() and raw.isdigit() else None
        except FileNotFoundError:
            have = None
        except OSError as e:
            fails.append((seat["role"], f"presence unreadable: {e}")); continue
        if want is None:
            fails.append((seat["role"], "presence: agent pid not found under block")); continue
        if have == want:
            lines.append(f"presence: {seat['role']} ok pid {want}")
            continue
        if not write:
            fails.append((seat["role"], f"presence pid {have} != agent pid {want}")); continue
        try:
            os.makedirs(PRESENCE_DIR, exist_ok=True)
            tmp = f"{f}.tmp-{os.getpid()}"
            with open(tmp, "x") as h:
                h.write(str(want))
            os.replace(tmp, f)
            lines.append(f"presence: {seat['role']} wrote pid {want} (was {have})")
        except OSError as e:
            fails.append((seat["role"], f"presence write failed: {e}"))
    return lines, fails


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
    plines, pfails = presence(roster, write=not check_only)
    for l in plines:
        print(l)
    fails += pfails
    for role, msg in fails:
        print(f"FAIL: {role}: {msg}")
    n = len(roster["seats"])
    print(f"result: {n - len({r for r, _ in fails})}/{n} seats OK in {time.time() - t0:.1f}s")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
