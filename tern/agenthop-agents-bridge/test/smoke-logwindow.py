#!/usr/bin/env python3
"""Log window for bridge-smoke.sh check 4. Prints the tern.log lines inside the window on stdout.

  smoke-logwindow.py mark   LOG             -> prints "<dev>:<ino>:<size>" (the log's identity at script start)
  smoke-logwindow.py since  LOG ISO_TIME    -> lines whose leading ISO timestamp is >= ISO_TIME
  smoke-logwindow.py offset LOG MARK        -> lines appended after MARK; whole file if it was replaced or truncated

Exit 0 = window read; exit 2 = cannot decide (unreadable log, unparseable SINCE, unparseable line timestamp in
`since` mode). The caller must treat exit 2 as a FAIL, never as "0 kills".

Times: ISO 8601 with optional fractional seconds and zone (Z / +HH:MM). A timestamp without a zone is taken as
LOCAL time (tern.log writes +08:00 locally; a bare SINCE from `date` is local too). Compared as epoch floats, so
11:00:00.900 is after 11:00:00.100 and 2026-10-14T20:00:00Z is after 2026-10-15T03:00:00+08:00.
"""
import datetime
import os
import re
import sys

STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)")


def epoch(text):
    s = text.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.datetime.fromisoformat(s)  # raises ValueError on anything it cannot parse
    if dt.tzinfo is None:
        dt = dt.astimezone()  # local zone
    return dt.timestamp()


def die(msg):
    print(f"smoke-logwindow: {msg}", file=sys.stderr)
    sys.exit(2)


def read_lines(path):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read().splitlines()
    except OSError as e:
        die(f"cannot read {path}: {e.strerror}")


def identity(path):
    try:
        st = os.stat(path)
    except OSError as e:
        die(f"cannot stat {path}: {e.strerror}")
    return st.st_dev, st.st_ino, st.st_size


def main(argv):
    if len(argv) < 2:
        die("usage: mark LOG | since LOG ISO | offset LOG MARK")
    mode, path = argv[0], argv[1]
    if mode == "mark":
        dev, ino, size = identity(path)
        print(f"{dev}:{ino}:{size}")
        return
    if mode == "since":
        if len(argv) < 3:
            die("since needs ISO_TIME")
        try:
            t0 = epoch(argv[2])
        except ValueError:
            die(f"SINCE not an ISO time: {argv[2]!r}")
        out = []
        for line in read_lines(path):
            m = STAMP.match(line)
            if not m:
                continue  # continuation / stack lines carry no timestamp; they are never kill lines
            try:
                if epoch(m.group(1)) >= t0:
                    out.append(line)
            except ValueError:
                die(f"unparseable log timestamp: {m.group(1)!r}")
        print("\n".join(out))
        return
    if mode == "offset":
        if len(argv) < 3:
            die("offset needs MARK")
        try:
            dev0, ino0, size0 = (int(x) for x in argv[2].split(":"))
        except ValueError:
            die(f"bad MARK {argv[2]!r}")
        dev, ino, size = identity(path)
        try:
            with open(path, "rb") as f:
                if (dev, ino) == (dev0, ino0) and size >= size0:
                    f.seek(size0)  # same file, grown: only what was appended since start
                # else: replaced (rotation) or truncated -> the whole current file is new to us
                data = f.read()
        except OSError as e:
            die(f"cannot read {path}: {e.strerror}")
        sys.stdout.write(data.decode(errors="replace"))
        return
    die(f"unknown mode {mode!r}")


if __name__ == "__main__":
    main(sys.argv[1:])
