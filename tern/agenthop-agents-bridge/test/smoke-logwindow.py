#!/usr/bin/env python3
"""Log window for bridge-smoke.sh check 4. Prints the tern.log lines inside the window on stdout.

  smoke-logwindow.py mark   LOG             -> prints a MARK for the log as it is now (see below)
  smoke-logwindow.py since  LOG ISO_TIME [PLUGIN_ID] -> lines whose leading timestamp is >= ISO_TIME
  smoke-logwindow.py offset LOG MARK        -> lines appended after MARK; the whole file if continuity can't be shown

Exit 0 = window read; exit 2 = cannot decide. The caller must treat exit 2 as a FAIL, never as "0 kills". Exit 2 when:
the log cannot be opened/read, SINCE is not an ISO time, or (in `since` mode) a KILL line's timestamp is malformed.

MARK = "<dev>:<ino>:<size>:<sha256 of the first min(size, 4096) bytes>". `offset` opens the log ONCE and works only on
that open file descriptor: fstat(fd) gives dev/ino/size and the prefix hash is read from the same fd, so a rename
between stat and open cannot mix two files. The old offset is reused only if dev, ino match, size did not shrink AND
the first bytes are unchanged; anything else (rotation, copytruncate, truncate-and-regrow, rewrite) => read the whole
file from byte 0. Continuity beyond the hashed prefix is not proven; that ceiling is accepted (a rewrite would have to
keep the first 4 KB identical).

Times: ISO 8601 with optional fractional seconds and zone (Z / +HH:MM). No zone = LOCAL time. Compared as epoch
floats. A kill line is a line containing "exceeded its budget" and, if PLUGIN_ID is given, plugin="<PLUGIN_ID>"; its
timestamp must parse completely (the whole leading token), or the window is undecidable. Lines without a timestamp that are not kill lines (stack traces,
continuations) are skipped.
"""
import datetime
import hashlib
import os
import re
import sys

PREFIX = 4096
TOKEN = re.compile(r"^(\S+)")
KILL = "exceeded its budget"


def epoch(text):
    s = text.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2})?", s):
        raise ValueError(text)
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.timestamp()


def die(msg):
    print(f"smoke-logwindow: {msg}", file=sys.stderr)
    sys.exit(2)


def open_log(path):
    try:
        return os.open(path, os.O_RDONLY)
    except OSError as e:
        die(f"cannot read {path}: {e.strerror}")


def read_all(fd, start=0):
    os.lseek(fd, start, os.SEEK_SET)
    chunks = []
    while True:
        b = os.read(fd, 1 << 16)
        if not b:
            break
        chunks.append(b)
    return b"".join(chunks)


def prefix_hash(fd, size):
    os.lseek(fd, 0, os.SEEK_SET)
    return hashlib.sha256(os.read(fd, min(size, PREFIX))).hexdigest()


def mark(path):
    fd = open_log(path)
    try:
        st = os.fstat(fd)
        return f"{st.st_dev}:{st.st_ino}:{st.st_size}:{prefix_hash(fd, st.st_size)}"
    except OSError as e:
        die(f"cannot read {path}: {e.strerror}")
    finally:
        os.close(fd)


def main(argv):
    if len(argv) < 2:
        die("usage: mark LOG | since LOG ISO | offset LOG MARK")
    mode, path = argv[0], argv[1]
    if mode == "mark":
        print(mark(path))
        return
    if mode == "since":
        if len(argv) < 3:
            die("since needs ISO_TIME")
        try:
            t0 = epoch(argv[2])
        except ValueError:
            die(f"SINCE not an ISO time: {argv[2]!r}")
        plugin = argv[3] if len(argv) > 3 and argv[3] else None
        fd = open_log(path)
        try:
            text = read_all(fd).decode(errors="replace")
        except OSError as e:
            die(f"cannot read {path}: {e.strerror}")
        finally:
            os.close(fd)
        out = []
        for line in text.splitlines():
            m = TOKEN.match(line)
            tok = m.group(1) if m else ""
            try:
                t = epoch(tok)
            except ValueError:
                if KILL in line and (plugin is None or f'plugin="{plugin}"' in line):
                    die(f"kill line with an unparseable timestamp {tok!r}: {line[:120]!r}")
                continue  # stack trace / continuation: no timestamp, not a kill
            if t >= t0:
                out.append(line)
        print("\n".join(out))
        return
    if mode == "offset":
        if len(argv) < 3:
            die("offset needs MARK")
        parts = argv[2].split(":")
        if len(parts) != 4:
            die(f"bad MARK {argv[2]!r}")
        try:
            dev0, ino0, size0 = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            die(f"bad MARK {argv[2]!r}")
        hash0 = parts[3]
        fd = open_log(path)
        try:
            st = os.fstat(fd)  # identity of the file we actually opened
            same = (st.st_dev, st.st_ino) == (dev0, ino0) and st.st_size >= size0 \
                and prefix_hash(fd, size0) == hash0
            data = read_all(fd, size0 if same else 0)
        except OSError as e:
            die(f"cannot read {path}: {e.strerror}")
        finally:
            os.close(fd)
        if not same:
            print(f"smoke-logwindow: log replaced, truncated or rewritten since start; reading it whole", file=sys.stderr)
        sys.stdout.write(data.decode(errors="replace"))
        return
    die(f"unknown mode {mode!r}")


if __name__ == "__main__":
    main(sys.argv[1:])
