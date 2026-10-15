#!/usr/bin/env python3
"""tern-restore: bring every roster seat back up in Tern with one command.

Truth source = `tern ls --json` (daemon side), never the bridge mirror (agents.json is advisory and has frozen).
Order of operations (nothing in Tern changes before steps 1-2 pass):
  1. roster: fully validated up front (fields, types, tool in {claude,codex}, unique role / sid) -> exit 2, zero starts.
  2. inventory: `tern ls --json` must have the expected shape (sessions[].tabs[].blocks[] with the fields we read); a malformed
     listing is UNKNOWN -> abort before any change (exit 3). A legal empty list is fine.
  3. posture: READ ONLY check of ~/.claude.json (bypass flag + per-cwd trust). Never written (user ruling).
  4. per seat: a block is that seat only if its argv parses to `tern acp <tool> --resume <sid>` (or --resume=<sid>) with the
     exact tool and full sid. Live + named => skip. Live + wrong tab name => rename only (finishes a half-done start). Absent =>
     `tern new tab`; the returned block id is then an obligation: wait (bounded) until it is listed, then rename (retried).
     A block started but not yet listed is reported pending; the next run finds it by argv and only renames it.
  5. assert from a fresh listing: each seat live exactly once, pinned model, tab = role.
  6. presence + seat-shell: `scripts/seat-presence.ts set <sid> <block> <tool>` (the one presence writer: resolves the agent pid,
     writes under the shared per-sid lock), then `scripts/seat-shell.ts set <sid> tern <that pid>`. --check only asserts (reads
     presence/<sid>.pid + .origin, no lock), writes nothing.
Exit: 0 all OK, 1 assertion failed, 2 roster error, 3 inventory UNKNOWN.
Env (tests): TERN_BIN, CLAUDE_JSON, RESTORE_PS (ps file: 'pid ppid command', --check only), AH_HOME (presence home), SEAT_SHELL_CMD (default:
repo tsx scripts/seat-shell.ts), SEAT_PRESENCE_CMD (default: repo tsx scripts/seat-presence.ts), RESTORE_WAIT_S (default 10).
"""
import json, os, re, shlex, subprocess, sys, time

TERN = os.environ.get("TERN_BIN", "tern")
CLAUDE_JSON = os.path.expanduser(os.environ.get("CLAUDE_JSON", "~/.claude.json"))
# ONE normalized home for every helper (seat-presence.ts and seat-shell.ts both read AH_HOME): a raw "~/x" would be expanded by us
# but taken literally (relative to cwd) by node, splitting the two writes across two roots (TR-SV-HOME-REGISTRATION).
AH_HOME = os.path.abspath(os.path.expanduser(os.environ.get("AH_HOME") or "~"))
PRESENCE_DIR = os.path.join(AH_HOME, ".agenthop", "presence")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WAIT_S = float(os.environ.get("RESTORE_WAIT_S", "10"))
PENDING_DIR = os.path.expanduser(os.environ.get("RESTORE_PENDING_DIR", "~/.agenthop/swarm/tern-restore-pending"))
PENDING_TTL_S = float(os.environ.get("RESTORE_PENDING_TTL_S", "120"))
TOOLS = ("claude", "codex")
# Seat permission mode (user, 2026-10-15: every agent starts at the highest permission, no approval prompts). claude takes it as
# `--mode`; codex-acp has no --mode flag and reads INITIAL_AGENT_MODE from the environment (read-only|workspace-write|agent|
# agent-full-access); the global ~/.codex/config.toml is not read by the ACP entry, so the env must be explicit.
MODES = {"claude": ("bypassPermissions",), "codex": ("read-only", "workspace-write", "agent", "agent-full-access")}
DEFAULT_MODE = {"claude": "bypassPermissions", "codex": "agent-full-access"}
SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class RosterError(Exception):
    pass


class InventoryUnknown(Exception):
    pass


def tern(*args):
    r = subprocess.run([TERN, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"tern {' '.join(args)} failed rc={r.returncode}: {r.stderr.strip()}")
    return r.stdout


# ---------- 1. roster ----------
def validate_roster(r):
    if not isinstance(r, dict):
        raise RosterError("top level must be an object")
    if not isinstance(r.get("session"), str) or not r["session"]:
        raise RosterError("session must be a non-empty string")
    seats = r.get("seats")
    if not isinstance(seats, list) or not seats:
        raise RosterError("seats must be a non-empty list")
    roles, sids = set(), set()
    for i, s in enumerate(seats):
        where = f"seats[{i}]"
        if not isinstance(s, dict):
            raise RosterError(f"{where} must be an object")
        for k in ("role", "tool", "sid", "cwd"):
            if not isinstance(s.get(k), str) or not s[k]:
                raise RosterError(f"{where}.{k} must be a non-empty string")
        if s["tool"] not in TOOLS:
            raise RosterError(f"{where}.tool {s['tool']!r} not in {TOOLS}")
        if not SID_RE.fullmatch(s["sid"]):
            raise RosterError(f"{where}.sid {s['sid']!r} is not a valid sid")
        if "model" not in s:
            raise RosterError(f"{where}.model missing (use null for codex)")
        m = s["model"]
        if m is not None and (not isinstance(m, str) or not m):
            raise RosterError(f"{where}.model must be null or a non-empty string")
        md = s.get("mode")
        if md is not None and md not in MODES[s["tool"]]:
            raise RosterError(f"{where}.mode {md!r} not valid for {s['tool']} {MODES[s['tool']]}")
        if s["tool"] == "claude" and m is None:
            raise RosterError(f"{where}: claude seat needs a pinned model")
        if s["role"] in roles:
            raise RosterError(f"duplicate role {s['role']!r}")
        if s["sid"] in sids:
            raise RosterError(f"duplicate sid {s['sid']}")
        roles.add(s["role"]); sids.add(s["sid"])
    return r


# ---------- 2. inventory ----------
def inventory(session):
    """[(tab_name, block)] of `session`. Raises InventoryUnknown on any shape it cannot interpret."""
    try:
        d = json.loads(tern("ls", "--json"))
    except (RuntimeError, ValueError) as e:
        raise InventoryUnknown(f"tern ls --json unusable: {e}")
    if not isinstance(d, dict) or not isinstance(d.get("sessions"), list):
        raise InventoryUnknown("listing has no sessions list")
    out = []
    for s in d["sessions"]:
        if not isinstance(s, dict) or not isinstance(s.get("name"), str) or not isinstance(s.get("tabs"), list):
            raise InventoryUnknown("a session lacks name/tabs")
        if s["name"] != session:
            continue
        for t in s["tabs"]:
            if not isinstance(t, dict) or not isinstance(t.get("blocks"), list) or "name" not in t:
                raise InventoryUnknown("a tab lacks name/blocks")
            for b in t["blocks"]:
                if not isinstance(b, dict) or not isinstance(b.get("id"), int) or isinstance(b.get("id"), bool) \
                        or "live" not in b or "exited" not in b or "command" not in b:
                    raise InventoryUnknown("a block lacks id/live/exited/command")
                # the leaf types we actually consume (daemon contract): a wrong type is UNKNOWN, never "not this seat"
                if not isinstance(b["live"], bool):
                    raise InventoryUnknown(f"block {b['id']}: live is {type(b['live']).__name__}, not bool")
                if b["command"] is not None and not isinstance(b["command"], str):
                    raise InventoryUnknown(f"block {b['id']}: command is {type(b['command']).__name__}, not string/null")
                if t["name"] is not None and not isinstance(t["name"], str):
                    raise InventoryUnknown(f"tab of block {b['id']}: name is {type(t['name']).__name__}, not string/null")
                out.append((t["name"], b))
    return out


ENV_ASSIGN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=[^$`\\]*")
SHELL_OPS = {"&&", "||", ";", "|", "&", "(", ")", "<", ">", ">>", "<<", "2>", "2>&1", "&>"}


def _has_unquoted_newline(command):
    quote, i = None, 0
    while i < len(command):
        c = command[i]
        if quote == "'":
            if c == "'": quote = None
        elif quote == '"':
            if c == "\\": i += 1
            elif c == '"': quote = None
        else:
            if c == "\\":
                i += 1  # backslash-newline is a line continuation in sh, not a boundary; any other escaped char is literal
            elif c in ("'", '"'): quote = c
            elif c in ("\n", "\r"): return True
        i += 1
    return False


def _join_continuations(command):
    """Remove backslash-newline the way /bin/sh does BEFORE it splits words or sees comments (outside single quotes; inside double
    quotes too). TR-SV-CONTINUATION-COMMENT: `claude \\<newline># --mode X` is `claude # --mode X` to sh — the # starts a comment —
    so continuations must be gone before _strip_comment decides what is a word start. `a\\<newline>#b` joins to the word `a#b`."""
    out, quote, i = [], None, 0
    while i < len(command):
        c = command[i]
        if quote != "'" and c == "\\" and command[i + 1:i + 2] == "\n":
            i += 2
            continue
        if quote == "'":
            if c == "'": quote = None
        elif quote == '"':
            if c == "\\":
                out.append(command[i:i + 2]); i += 2; continue
            if c == '"': quote = None
        elif c == "\\":
            out.append(command[i:i + 2]); i += 2; continue
        elif c in ("'", '"'):
            quote = c
        out.append(c)
        i += 1
    return "".join(out)


def _strip_comment(command):
    """Cut an sh comment: an unquoted `#` at the START of a word runs to end of line. A `#` inside a word (`X#y`) is literal in sh,
    so it must stay literal here too — shlex's commenter would cut `--resume X#y` to `X` and prove an identity sh never passes."""
    quote, i, word_start = None, 0, True
    while i < len(command):
        c = command[i]
        if quote == "'":
            if c == "'": quote = None
        elif quote == '"':
            if c == "\\": i += 1
            elif c == '"': quote = None
        elif c == "\\":
            i += 1
        elif c in ("'", '"'):
            quote = c
        elif c == "#" and word_start:
            return command[:i]
        word_start = quote is None and c in (" ", "\t")
        i += 1
    return command


def _acp_launch(command):
    """The ONE parse of a launch line that both identity and mode read: {tool, sids, models, modes, env} or None if it is not
    provably exactly one simple `tern acp <tool>` command. Tokens follow /bin/sh: comments removed, quotes give argument boundaries."""
    if not isinstance(command, str) or not command:
        return None
    # TR-SHELL-NEWLINE: an unquoted newline (or CR) ends a shell command — `tern acp claude …\necho --resume X` is TWO commands, and
    # shlex would glue them into one argv. Any newline/CR outside quotes ⇒ not provably one simple command.
    if _has_unquoted_newline(command):
        return None
    try:
        lex = shlex.shlex(_strip_comment(_join_continuations(command)), posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        lex.commenters = ""
        argv = list(lex)
    except ValueError:
        return None
    if any(a in SHELL_OPS or (a and set(a) <= set("&|;<>()")) for a in argv):
        return None
    # r8: an optional literal `env K=V ...` prefix (how codex seats get INITIAL_AGENT_MODE). Each assignment must be a plain
    # NAME=value with no expansion characters; anything else in front of `tern` still makes the identity unprovable.
    env = []
    if argv and os.path.basename(argv[0]) == "env":
        j = 1
        while j < len(argv) and ENV_ASSIGN.fullmatch(argv[j]):
            env.append(tuple(argv[j].split("=", 1)))
            j += 1
        if j < len(argv) and "=" in argv[j]:
            return None  # an assignment that is not literal (e.g. a $VAR or a backtick value)
        argv = argv[j:]
    if len(argv) < 3 or os.path.basename(argv[0]) != "tern" or argv[1] != "acp" or argv[2] not in TOOLS:
        return None
    flags = {"--resume": [], "--model": [], "--mode": []}
    i = 3
    while i < len(argv):
        a = argv[i]
        if a in flags and i + 1 < len(argv):
            flags[a].append(argv[i + 1]); i += 2; continue
        name = a.split("=", 1)[0]
        if "=" in a and name in flags:
            flags[name].append(a.split("=", 1)[1])
        i += 1
    return {"tool": argv[2], "sids": flags["--resume"], "models": flags["--model"], "modes": flags["--mode"], "env": env}


def parse_acp(command):
    """(tool, sid, model) if command is exactly ONE simple `tern acp` launch with one resume, else None.
    A compound command (any shell operator token) or a repeated --resume/--model cannot prove which identity runs ⇒ None."""
    p = _acp_launch(command)
    if p is None or len(p["sids"]) != 1 or len(p["models"]) > 1:
        return None  # zero or several identities: cannot prove which one runs
    return (p["tool"], p["sids"][0], p["models"][0] if p["models"] else None)


# TR-MODE-SOURCE: each tool's mode is proven only from the input that tool actually reads — claude `--mode`, codex-acp the env
# INITIAL_AGENT_MODE (it has no --mode flag). A mode word in the other source proves nothing and is ignored.
def launch_mode(command):
    """The permission mode a launch line gives its agent, or None = not stated / stated more than once / not a parseable launch."""
    if parse_acp(command) is None:
        return None
    p = _acp_launch(command)
    vals = p["modes"] if p["tool"] == "claude" else [v for k, v in p["env"] if k == "INITIAL_AGENT_MODE"]
    return vals[0] if len(vals) == 1 else None


def is_live(b):
    return b.get("live") is True and b.get("exited") is None


def seat_blocks(inv, seat):
    out = []
    for tab, b in inv:
        p = parse_acp(b.get("command"))
        if p and p[0] == seat["tool"] and p[1] == seat["sid"] and is_live(b):
            out.append((tab, b, p))
    return out


def seat_mode(seat):
    return seat.get("mode") or DEFAULT_MODE[seat["tool"]]


def launch_cmd(seat):
    mode = seat_mode(seat)
    if seat["tool"] == "codex":
        parts = ["env", f"INITIAL_AGENT_MODE={mode}", "tern", "acp", "codex", "--resume", seat["sid"]]
    else:
        parts = ["tern", "acp", seat["tool"], "--resume", seat["sid"], "--mode", mode]
    if seat.get("model"):
        parts += ["--model", seat["model"]]
    return parts


# ---------- 3. posture (read only) ----------
def posture_check(roster):
    lines, ok = [], True
    try:
        d = json.load(open(CLAUDE_JSON))
    except (OSError, ValueError) as e:
        return False, [f"posture: cannot read {CLAUDE_JSON}: {e}"]
    bp = d.get("bypassPermissionsModeAccepted") is True
    ok &= bp
    lines.append(f"posture: bypassPermissionsModeAccepted {'present' if bp else 'ABSENT'}")
    projects = d.get("projects") if isinstance(d.get("projects"), dict) else {}
    for cwd in sorted({os.path.expanduser(s["cwd"]) for s in roster["seats"] if s["tool"] == "claude"}):
        p = projects.get(cwd)
        tr = isinstance(p, dict) and p.get("hasTrustDialogAccepted") is True
        ok &= tr
        lines.append(f"posture: trust {cwd} {'present' if tr else 'ABSENT'}")
    if not ok:
        lines.append("posture: ABSENT flags make ACP seats show an approval dialog at first start. This script does not "
                     "change them; setting them is a human decision.")
    return ok, lines


# ---------- process table ----------
def ps_table():
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


def argv_has_resume(command, sid, positional=False):
    """True only if the command carries `--resume <sid>` / `--resume=<sid>` as a whole argument; with positional=True also
    `resume <sid>` (codex's own CLI form). The sid must be a WHOLE argument (a suffixed sid never matches)."""
    try:
        argv = shlex.split(command)
    except ValueError:
        argv = command.split()
    for i, a in enumerate(argv):
        if a == f"--resume={sid}" or (a == "--resume" and i + 1 < len(argv) and argv[i + 1] == sid):
            return True
        if positional and a == "resume" and i + 1 < len(argv) and argv[i + 1] == sid:
            return True
    return False


def codex_conflicts(roster, table):
    """Hint only: non-Tern processes whose argv resumes a roster codex sid. Not proof the thread is held."""
    hits = []
    for s in roster["seats"]:
        if s["tool"] != "codex":
            continue
        for pid, (_, cmd) in sorted(table.items()):
            if "codex" in cmd and "tern acp" not in cmd and argv_has_resume(cmd, s["sid"], positional=True):
                hits.append(f"codex-hint: {s['role']} sid {s['sid'][:8]} may also be open outside Tern (pid {pid}); "
                            f"codex threads are exclusive, check before relying on the Tern seat")
    return hits


# ---------- 4. restore ----------
# TR-ATTACH-RETRY: a started-but-not-yet-listed block is an obligation that must survive THIS process. Before `tern new tab` we
# write pending/<sid>.json (exclusive create); after the start it records the block id. A later run that finds a pending
# entry younger than PENDING_TTL_S does NOT start again: it waits for that block (or reports pending). The entry is removed
# once the seat is seen live. An unreadable entry is UNKNOWN: no start.
# r4 (TR-ATTACH-RETRY): AGE NEVER ERASES A SUCCESSFUL START. Past the TTL the entry is only RE-CHECKED against the daemon by
# its recorded block id (block_status): present and live ⇒ the obligation is discharged by attaching to it (no start); provably
# gone (`tern process` answers "no block is called <id>", or the block is listed with live=false / exited set) ⇒ clear and
# start once; anything unprovable (daemon unreachable, no recorded block id, an unexpected answer) ⇒ HOLD: no start, a line
# for a human. The TTL only decides WHEN to look again, never what the answer is.
class PendingUnknown(Exception):
    pass


def block_status(bid, seat):
    """'live' | 'gone' | 'other' | 'unknown' for a recorded block id, from the daemon (never from age), and only for THIS seat.
    live    = the block exists (listed live, or resolved by `tern process` but not listed yet) AND its launch proves this seat's
              tool + sid (TR-R6-P2-1: a numeric id existing is not proof the block is still this seat's)
    other   = the block exists but its launch is provably ANOTHER identity (tool/sid differ)
    gone    = `tern process` says no such block, or tern ls lists it with live false / exited set
    unknown = the daemon cannot be asked, the identity cannot be read, or any other answer"""
    if not isinstance(bid, int) or isinstance(bid, bool):
        return "unknown"
    r = subprocess.run([TERN, "process", str(bid), "--json"], capture_output=True, text=True)
    if r.returncode != 0:
        msg = (r.stderr or "") + (r.stdout or "")
        return "gone" if f"no block is called `{bid}`" in msg else "unknown"
    try:
        child = json.loads(r.stdout).get("child")
    except (ValueError, AttributeError):
        return "unknown"
    if not isinstance(child, dict) or not isinstance(child.get("pid"), int):
        return "unknown"
    listed_cmd, listed = None, False
    try:
        d = json.loads(tern("ls", "--json"))
        for s_ in d.get("sessions", []):
            for t in s_.get("tabs", []):
                for b in t.get("blocks", []):
                    if b.get("id") == bid:
                        if b.get("live") is False or b.get("exited") is not None:
                            return "gone"
                        listed, listed_cmd = True, b.get("command")
    except (RuntimeError, ValueError, AttributeError, TypeError):
        return "unknown"
    # identity: the listed launch command if listed, else the process argv the daemon reports for the block's child
    if listed:
        ident = parse_acp(listed_cmd)
    else:
        argv = child.get("argv")
        ident = parse_acp(" ".join(shlex.quote(str(a)) for a in argv)) if isinstance(argv, list) and argv else None
    if ident is None:
        return "unknown"
    return "live" if (ident[0] == seat["tool"] and ident[1] == seat["sid"]) else "other"


def pending_path(sid):
    return os.path.join(PENDING_DIR, sid + ".json")


def pending_read(sid):
    """None = no entry; dict = entry; raises PendingUnknown if it exists but cannot be read/parsed."""
    try:
        with open(pending_path(sid)) as f:
            d = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise PendingUnknown(f"pending entry for {sid} unreadable: {e}")
    if not isinstance(d, dict) or not isinstance(d.get("at"), (int, float)) or isinstance(d.get("at"), bool):
        raise PendingUnknown(f"pending entry for {sid} malformed")
    return d


def pending_write(sid, data, create):
    os.makedirs(PENDING_DIR, mode=0o700, exist_ok=True)
    f = pending_path(sid)
    if create:
        with open(f, "x") as h:  # exclusive: two concurrent runs cannot both claim the start
            json.dump(data, h)
        return
    tmp = f"{f}.tmp-{os.getpid()}"
    with open(tmp, "x") as h:
        json.dump(data, h)
    os.replace(tmp, f)


def pending_clear(sid):
    try:
        os.remove(pending_path(sid))
    except FileNotFoundError:
        pass


def wait_listed(session, bid, deadline):
    while True:
        for tab, b in inventory(session):
            if b["id"] == bid:
                return True
        if time.time() >= deadline:
            return False
        time.sleep(0.3)


def try_rename(bid, role, deadline, still_mine):
    """None = renamed; str = last rename error at the deadline; ("hold", status) = before an attempt the block was no longer
    provably this seat's. TR-PENDING-RETRY: identity is re-proven before EVERY attempt — a proof from before a failed rename
    does not authorise the retry, because the block can change hands in between."""
    while True:
        st = still_mine()
        if st != "live":
            return ("hold", st)
        try:
            tern("rename", str(bid), role)
            return None
        except RuntimeError as e:
            last = str(e)
        if time.time() >= deadline:
            return last
        time.sleep(0.3)


def restore(roster):
    session = roster["session"]
    inv = inventory(session)
    report, pending, held = [], [], []
    for seat in roster["seats"]:
        mine = seat_blocks(inv, seat)
        pend = pending_read(seat["sid"])  # PendingUnknown propagates: no guessing about an earlier start
        if mine:
            if pend is not None:
                pending_clear(seat["sid"])  # the earlier start is now visible: obligation discharged
            tab, b, _ = mine[0]
            if tab == seat["role"]:
                report.append(f"skip: {seat['role']} already live (block {b['id']})")
            else:
                err = try_rename(b["id"], seat["role"], time.time() + WAIT_S, lambda b=b, seat=seat: block_status(b["id"], seat))
                if isinstance(err, tuple):
                    report.append(f"HOLD: {seat['role']} block {b['id']} is {'another seat' if err[1] == 'other' else err[1]} "
                                  f"before rename (not provably this seat) — not renaming")
                    held.append(seat["role"])
                else:
                    report.append(f"rename: {seat['role']} block {b['id']} (was {tab!r})" + (f" FAILED: {err}" if err else ""))
            continue
        if pend is not None:
            age = time.time() - pend["at"]
            if age < PENDING_TTL_S:
                bid = pend.get("block")
                report.append(f"pending: {seat['role']} start from an earlier run (block {bid}, {age:.0f}s ago) not listed yet — "
                              f"not starting again")
                if isinstance(bid, int) and not isinstance(bid, bool):
                    pending.append((seat, bid))
                continue
            bid = pend.get("block")
            st = block_status(bid, seat)
            if st == "live":
                report.append(f"pending: {seat['role']} earlier start (block {bid}, {age:.0f}s ago) is alive in the daemon — "
                              f"attaching, not starting again")
                pending.append((seat, bid))
                continue
            if st == "other":
                report.append(f"HOLD: {seat['role']} earlier start recorded block {bid}, which now runs ANOTHER seat's identity — "
                              f"not renaming, attaching or starting. Check {pending_path(seat['sid'])} by hand.")
                held.append(seat["role"])
                continue
            if st == "unknown":
                report.append(f"HOLD: {seat['role']} earlier start (block {bid!r}, {age:.0f}s ago) cannot be proven alive or gone — "
                              f"not starting. Check `tern ls --json` / `tern process {bid} --json`; delete {pending_path(seat['sid'])} "
                              f"only if you are sure it is gone.")
                held.append(seat["role"])
                continue
            report.append(f"gone: {seat['role']} earlier start (block {bid}) is provably gone — clearing and starting once")
            pending_clear(seat["sid"])
        try:
            pending_write(seat["sid"], {"at": time.time(), "role": seat["role"], "block": None}, create=True)
        except FileExistsError:
            report.append(f"pending: {seat['role']} another run is starting it — skipped")
            continue
        out = tern("new", "tab", session, "--cwd", os.path.expanduser(seat["cwd"]), "--", *launch_cmd(seat))
        bid = out.strip().splitlines()[-1].strip() if out.strip() else ""
        if not bid.isdigit():
            raise RuntimeError(f"tern new tab for {seat['role']} returned no block id: {out!r}")
        pending_write(seat["sid"], {"at": time.time(), "role": seat["role"], "block": int(bid)}, create=False)
        pending.append((seat, int(bid)))
        report.append(f"start: {seat['role']} block {bid}")
    for seat, bid in pending:  # obligations: list then rename each started block; never restart inside this run
        deadline = time.time() + WAIT_S
        if not wait_listed(session, bid, deadline):
            report.append(f"pending: {seat['role']} block {bid} not listed yet (rerun renames it; it is not started twice "
                          f"once listed)")
            continue
        # TR-PENDING-IDENTITY / TR-PENDING-RETRY: the SAME identity discipline for every pending block (young or expired, from this
        # run or an earlier one) and for every rename attempt: prove it is still THIS seat's live block (tool + full sid) right
        # before each attempt. A block whose identity changed, or cannot be read, is never renamed and the journal is kept.
        err = try_rename(bid, seat["role"], deadline, lambda bid=bid, seat=seat: block_status(bid, seat))
        if isinstance(err, tuple):
            report.append(f"HOLD: {seat['role']} pending block {bid} is {'another seat' if err[1] == 'other' else err[1]} "
                          f"(not provably this seat) — not renaming, journal kept ({pending_path(seat['sid'])})")
            held.append(seat["role"])
        elif err:
            report.append(f"pending: {seat['role']} block {bid} rename failed: {err} (rerun renames it)")
        else:
            pending_clear(seat["sid"])
    return report, held


def verify(roster):
    fails = []
    inv = inventory(roster["session"])
    for seat in roster["seats"]:
        mine = seat_blocks(inv, seat)
        if not mine:
            fails.append((seat["role"], "not live")); continue
        if len(mine) > 1:
            fails.append((seat["role"], f"live {len(mine)}x (duplicate blocks {[b['id'] for _, b, _ in mine]})"))
        tab, b, (_, _, model) = mine[0]
        if seat.get("model") and model != seat["model"]:
            fails.append((seat["role"], f"model {model!r} != pinned {seat['model']!r}"))
        got_mode = launch_mode(b.get("command"))
        if got_mode != seat_mode(seat):
            # user rule (2026-10-15): seats start at the highest permission. A launch without the pinned mode would sit on
            # approval prompts (codex ACP defaults to on-request), so it is a FAIL, not a note.
            fails.append((seat["role"], f"mode {got_mode!r} != pinned {seat_mode(seat)!r}"))
        if tab != seat["role"]:
            fails.append((seat["role"], f"tab name {tab!r}"))
    return fails


# ---------- 6. presence + seat-shell ----------
def agent_pid(block_id, seat, table):
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
        hits = [p for p in desc if "stream-json" in table[p][1] and argv_has_resume(table[p][1], seat["sid"])]
    else:
        # codex seat (observed live 2026-10-15): tern acp codex → node …/@agentclientprotocol/codex-acp/dist/… → codex app-server.
        # Identity = a DIRECT child whose argv[0] basename is node AND whose argv names the codex-acp adapter path. A child that
        # merely mentions "codex" (e.g. `tail -f /tmp/codex.log`) is not proof ⇒ unresolved.
        def is_codex_adapter(cmd):
            try:
                argv = shlex.split(cmd)
            except ValueError:
                return False
            return bool(argv) and os.path.basename(argv[0]) == "node" and any("/@agentclientprotocol/codex-acp/" in a for a in argv[1:])
        hits = [p for p in kids.get(root, []) if is_codex_adapter(table[p][1])]
    return hits[0] if len(hits) == 1 else None


def seat_shell_set(sid, pid):
    cmd = os.environ.get("SEAT_SHELL_CMD")
    argv = shlex.split(cmd) if cmd else [os.path.join(REPO, "node_modules", ".bin", "tsx"),
                                         os.path.join(REPO, "scripts", "seat-shell.ts")]
    try:
        r = subprocess.run([*argv, "set", sid, "tern", str(pid)], capture_output=True, text=True, env=helper_env())
    except OSError as e:
        return str(e)
    return None if r.returncode == 0 else (r.stderr.strip() or f"rc={r.returncode}")


# presence files (coordinator re-ruling, 2026-10-15): presence/<sid>.pid stays ONE line = the pid — every existing reader
# (task-liveness readPid, shell-succession readPidDetailed, the installed hook's `kill -0 "$(cat …)"`) parses the WHOLE file as
# one number, so a second line would make the seat unparseable. The writer's origin goes to a SIDECAR presence/<sid>.origin,
# one line `origin=agent|bus ts=<epoch ms>`. Authority = the AGENT (host) pid; a missing .origin = the hook's bus process (old
# format). tern-restore never writes these files itself: seat-presence.ts set does (origin=agent, under the per-sid lock).
def read_presence(f):
    """(pid|None, origin|None) for presence/<sid>.pid and its .origin sidecar. Raises OSError (not FileNotFoundError) when a
    file exists but cannot be read. origin None = no sidecar (the hook's bus writer, old format)."""
    try:
        with open(f) as h:
            first = h.read().strip()
    except FileNotFoundError:
        return None, None
    pid = int(first) if first.isascii() and first.isdigit() and int(first) > 0 else None
    origin = None
    try:
        with open(f[: -len(".pid")] + ".origin") as h:
            for tok in h.read().split():
                if tok.startswith("origin="):
                    origin = tok.split("=", 1)[1] or None
    except FileNotFoundError:
        pass
    return pid, origin


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def presence_check(seat, f, want):
    """--check only (reads take no lock): (line, None) or (None, fail) for one seat."""
    try:
        have, origin = read_presence(f)
    except OSError as e:
        return None, f"presence unreadable: {e}"
    if have == want and origin == "agent":
        return f"presence: {seat['role']} ok pid {want}", None
    if have == want:  # right pid, no/other origin sidecar: correct for readers, worth a note
        return f"presence: {seat['role']} ok pid {want} (origin {origin or 'bus/none'})", None
    if origin in (None, "bus") and pid_alive(have):
        # the hook's bus process (sidecar origin=bus, or no sidecar = old format) holds a LIVE pid: readers still see a live
        # seat — a WARN, not a FAIL (coordinator ruling). A run replaces it with the agent pid.
        return f"WARN: {seat['role']} presence pid {have} is the bus process (origin={origin or 'none'}), agent pid is {want}", None
    return None, f"presence pid {have} != agent pid {want}"


def helper_env():
    return {**os.environ, "AH_HOME": AH_HOME}


def writer_response(stdout):
    """TR-SV-WRITER-RESPONSE: the writer's answer is exactly ONE non-empty line holding ONE JSON object. Any extra non-empty line
    (a second record, a log line), a non-object, or no line at all is not an answer ⇒ None."""
    lines = [l for l in (stdout or "").splitlines() if l.strip()]
    if len(lines) != 1:
        return None
    try:
        res = json.loads(lines[0])
    except ValueError:
        return None
    return res if isinstance(res, dict) else None


def seat_presence_set(sid, block_id, tool):
    """The ONE presence writer (#1053 scripts/seat-presence.ts set): it resolves the agent pid under the block itself (kernel exact
    argv), then writes under the shared per-sid lock (re-reads .pid/.origin inside it, origin first). Contract: exit 0 = wrote|kept,
    1 = refused / not exactly one agent, 2 = usage; stdout one JSON line {state, pid, was | reason}.
    Returns (pid, line, None) on 0, else (None, None, fail)."""
    cmd = os.environ.get("SEAT_PRESENCE_CMD")
    argv = shlex.split(cmd) if cmd else [os.path.join(REPO, "node_modules", ".bin", "tsx"), os.path.join(REPO, "scripts", "seat-presence.ts")]
    try:
        r = subprocess.run([*argv, "set", sid, str(block_id), tool], capture_output=True, text=True, timeout=30, env=helper_env())
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, None, f"seat-presence set failed to run: {e}"
    res = writer_response(r.stdout)
    if r.returncode == 0 and isinstance(res, dict) and res.get("state") in ("wrote", "kept") \
            and isinstance(res.get("pid"), int) and not isinstance(res.get("pid"), bool) and res["pid"] > 0:
        return res["pid"], res, None
    why = (res or {}).get("reason") if isinstance(res, dict) else None
    return None, None, f"seat-presence set rc={r.returncode}: {why or (r.stderr or '').strip() or (r.stdout or '').strip() or 'no output'}"


def presence(roster, write):
    table, lines, fails = ps_table(), [], []
    inv = inventory(roster["session"])
    for seat in roster["seats"]:
        mine = seat_blocks(inv, seat)
        if len(mine) != 1:
            continue  # verify() reports missing/duplicate
        bid = mine[0][1]["id"]
        if write:
            # SP-SV-RESTORE-LOCK: every presence write goes through the one TS writer and its lock; its resolved pid is the truth
            # for the seat-shell registration too (restore's own ps view is only used by --check).
            pid, res, fail = seat_presence_set(seat["sid"], bid, seat["tool"])
            if fail:
                fails.append((seat["role"], fail)); continue
            lines.append(f"presence: {seat['role']} {res['state']} pid {pid} (was {res.get('was')})")
            err = seat_shell_set(seat["sid"], pid)
            if err:
                fails.append((seat["role"], f"seat-shell set failed: {err}"))
            continue
        want = agent_pid(bid, seat, table)
        if want is None:
            fails.append((seat["role"], "presence: agent pid not found under block")); continue
        line, fail = presence_check(seat, os.path.join(PRESENCE_DIR, seat["sid"] + ".pid"), want)
        if fail:
            fails.append((seat["role"], fail)); continue
        lines.append(line)
    return lines, fails


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    path = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "roster.json")
    check_only = "--check" in argv
    try:
        roster = validate_roster(json.load(open(path)))
    except (OSError, ValueError, RosterError) as e:
        print(f"roster error: {path}: {e}", file=sys.stderr)
        return 2
    t0 = time.time()
    held = []
    try:
        inventory(roster["session"])  # shape gate before ANY change
        _, lines = posture_check(roster)
        for l in lines:
            print(l)
        for c in codex_conflicts(roster, ps_table()):
            print(c)
        if not check_only:
            report, held = restore(roster)
            for l in report:
                print(l)
        fails = verify(roster)
        plines, pfails = presence(roster, write=not check_only)
    except InventoryUnknown as e:
        print(f"inventory UNKNOWN: {e} — stopped", file=sys.stderr)
        return 3
    except PendingUnknown as e:
        print(f"pending UNKNOWN: {e} — stopped (not starting a seat that may already be starting)", file=sys.stderr)
        return 3
    for l in plines:
        print(l)
    fails += pfails
    for role in held:
        fails.append((role, "HOLD: an earlier start cannot be proven alive or gone (see HOLD line) — not started"))
    for role, msg in fails:
        print(f"FAIL: {role}: {msg}")
    n = len(roster["seats"])
    print(f"result: {n - len({r for r, _ in fails})}/{n} seats OK in {time.time() - t0:.1f}s")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
