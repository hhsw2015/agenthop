#!/usr/bin/env bash
# Gate for install-swarm-skills.sh on a private SWARM_SKILLS_DIR (never the real ~/.claude/skills).
set -u
S="$(cd "$(dirname "$0")/.." && pwd)/install-swarm-skills.sh"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export SWARM_SKILLS_DIR="$T/skills"
fails=0; n=0
ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "ok   - $1"; else fails=$((fails+1)); echo "FAIL - $1 (got '$3' want '$2')"; fi; }

bash -n "$S"; ck "bash -n" 0 $?
out=$(bash "$S" --dry); ck "--dry: exit 0" 0 $?
ck "--dry: writes nothing" no "$( [ -e "$SWARM_SKILLS_DIR" ] && echo yes || echo no)"
ck "--dry: names swarm-member" 1 "$(echo "$out" | grep -c 'would install swarm-member')"
bash "$S" >/dev/null; ck "install: exit 0" 0 $?
ck "install: SKILL.md identical to repo" 0 "$(cmp -s "$REPO/docs/swarm/skills/swarm-member/SKILL.md" "$SWARM_SKILLS_DIR/swarm-member/SKILL.md"; echo $?)"
ck "install: frontmatter name" "name: swarm-member" "$(sed -n 2p "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")"
ck "install: user-invocable" 1 "$(sed -n '1,/^---$/{/^user-invocable: true$/p;}' "$SWARM_SKILLS_DIR/swarm-member/SKILL.md" | sed -n '1,8p' | grep -c .)"
before=$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")
out=$(bash "$S"); ck "re-run: exit 0" 0 $?
ck "re-run: up to date, no copy" 1 "$(echo "$out" | grep -c 'ok swarm-member: up to date')"
ck "re-run: same inode (untouched)" "$before" "$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")"
echo stale > "$SWARM_SKILLS_DIR/swarm-member/SKILL.md"; echo junk > "$SWARM_SKILLS_DIR/swarm-member/extra.txt"
bash "$S" >/dev/null; ck "drift: replaced" 0 "$(cmp -s "$REPO/docs/swarm/skills/swarm-member/SKILL.md" "$SWARM_SKILLS_DIR/swarm-member/SKILL.md"; echo $?)"
ck "drift: stray file removed (copy = repo dir exactly)" no "$( [ -e "$SWARM_SKILLS_DIR/swarm-member/extra.txt" ] && echo yes || echo no)"
ck "no staging leftovers" 0 "$(ls -A "$SWARM_SKILLS_DIR" | grep -c '^\.')"
mkdir -p "$SWARM_SKILLS_DIR/other"; echo keep > "$SWARM_SKILLS_DIR/other/SKILL.md"
bash "$S" >/dev/null; ck "foreign skill untouched" keep "$(cat "$SWARM_SKILLS_DIR/other/SKILL.md")"
rm -rf "$SWARM_SKILLS_DIR/swarm-member"; mkdir -p "$T/elsewhere"; echo theirs > "$T/elsewhere/SKILL.md"; ln -s "$T/elsewhere" "$SWARM_SKILLS_DIR/swarm-member"
bash "$S" >/dev/null 2>&1; ck "symlink target: exit 1" 1 $?
ck "symlink target: not replaced" theirs "$(cat "$T/elsewhere/SKILL.md")"
ck "symlink target: link itself kept" yes "$( [ -L "$SWARM_SKILLS_DIR/swarm-member" ] && echo yes || echo no)"
# publication fault: a PATH mv wrapper fails the staged publish (.<name>.new.* -> target); optionally the rollback too
rm -f "$SWARM_SKILLS_DIR/swarm-member"; bash "$S" >/dev/null
mkdir -p "$T/fbin"; cat > "$T/fbin/mv" <<'MV'
#!/bin/bash
case "$1" in */.swarm-member.new.*) echo "mv: EACCES (fault)" >&2; exit 1;; esac
if [ -n "${FAIL_ROLLBACK:-}" ]; then case "$1" in */.swarm-member.old.*) echo "mv: EACCES (fault)" >&2; exit 1;; esac; fi
exec /bin/mv "$@"
MV
chmod 755 "$T/fbin/mv"
echo "old copy" > "$SWARM_SKILLS_DIR/swarm-member/SKILL.md"; ino=$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member"); fino=$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")
out=$(PATH="$T/fbin:$PATH" bash "$S" 2>&1); ck "publish fault: exit 1" 1 $?
ck "publish fault: says restored" 1 "$(echo "$out" | grep -c 'previous installation restored')"
ck "publish fault: target present" yes "$( [ -d "$SWARM_SKILLS_DIR/swarm-member" ] && echo yes || echo no)"
ck "publish fault: previous contents kept" "old copy" "$(cat "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")"
ck "publish fault: same dir inode" "$ino" "$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member")"
ck "publish fault: same file inode" "$fino" "$(stat -f %i "$SWARM_SKILLS_DIR/swarm-member/SKILL.md")"
ck "publish fault: no stage/old leftovers" 0 "$(ls -A "$SWARM_SKILLS_DIR" | grep -c '^\.swarm-member\.')"
ck "publish fault: other skill untouched" keep "$(cat "$SWARM_SKILLS_DIR/other/SKILL.md")"
out=$(FAIL_ROLLBACK=1 PATH="$T/fbin:$PATH" bash "$S" 2>&1); ck "publish+rollback fault: exit 1" 1 $?
ck "publish+rollback fault: names both paths" 1 "$(echo "$out" | grep -c 'previous copy kept at .*\.swarm-member\.old\..* new copy at .*\.swarm-member\.new\.')"
oldp=$(ls -d "$SWARM_SKILLS_DIR"/.swarm-member.old.* 2>/dev/null | head -1)
ck "publish+rollback fault: previous copy recoverable" "old copy" "$(cat "$oldp/SKILL.md" 2>/dev/null)"
ck "publish+rollback fault: new copy kept" 0 "$(cmp -s "$REPO/docs/swarm/skills/swarm-member/SKILL.md" "$(ls -d "$SWARM_SKILLS_DIR"/.swarm-member.new.* | head -1)/SKILL.md"; echo $?)"
rm -rf "$SWARM_SKILLS_DIR"/.swarm-member.*
ck "bad arg: exit 2" 2 "$(bash "$S" --bogus >/dev/null 2>&1; echo $?)"
ck "SKILL.md <= 200 lines" yes "$( [ "$(wc -l < "$REPO/docs/swarm/skills/swarm-member/SKILL.md")" -le 200 ] && echo yes || echo no)"
ck "SKILL.md hardcodes no session sid" 0 "$(grep -cE '[0-9a-f]{8}-[0-9a-f]{4}-' "$REPO/docs/swarm/skills/swarm-member/SKILL.md")"
echo; [ $fails -eq 0 ] && echo "PASS ($n checks)" || echo "FAIL ($fails of $n)"; [ $fails -eq 0 ]
