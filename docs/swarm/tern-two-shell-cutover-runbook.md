# Tern 两壳合一上线 runbook(#1056)

适用:tern-restore、#1033 bridge sweep、#1041 classifier、桥 r14、#1034 agenthop_tern 全部合并到 main **之后**。每步 = 操作 → 验证命令 → 期望输出 → 不符即回滚。按顺序做,一步不过不进下一步。

记号:`$R` = 仓库根(`~/Dev/agenthop`);`$P` = `~/.agenthop/tern-panes`(桥控制目录,恒在 OS home 下,不受 AH_HOME 影响)。

## 0. 起点快照(回滚基线)

```bash
cd $R && git log -1 --format='%h %s' main                 # 记下合并后的 main SHA
cp ~/.local/bin/agenthop ~/.local/bin/agenthop.pre-cutover # 旧二进制
cp ~/.agenthop/swarm/dispatcher-recipe.json ~/.agenthop/swarm/dispatcher-recipe.json.pre-cutover
cp -R "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge" /tmp/bridge.pre-cutover
agenthop --version                                         # 记下旧版本串
```

期望:四个备份都存在(`ls -la` 各一行),版本串记录在案。

## ① 重编二进制并替换

```bash
cd $R && node scripts/build-release.mjs                    # 产出 dist/agenthop-macos-arm64 并自带 --version 冒烟
dist/agenthop-macos-arm64 --version                        # 期望:新版本串,非空
cmp dist/agenthop-macos-arm64 ~/.local/bin/agenthop; echo "cmp rc=$?"   # 期望:rc=1(不同);rc=0 说明没变,停下查
cp dist/agenthop-macos-arm64 ~/.local/bin/agenthop.new && chmod 755 ~/.local/bin/agenthop.new
mv -f ~/.local/bin/agenthop.new ~/.local/bin/agenthop      # placeCommand 规则:先写 .new 再 rename,绝不覆盖正在运行的文件
~/.local/bin/agenthop --version                            # 期望:新版本串
cmp dist/agenthop-macos-arm64 ~/.local/bin/agenthop; echo "cmp rc=$?"   # 期望:rc=0
```

回滚:`cp ~/.local/bin/agenthop.pre-cutover ~/.local/bin/agenthop.new && mv -f ~/.local/bin/agenthop.new ~/.local/bin/agenthop`,`agenthop --version` 回到旧串。

## ② 八席 MCP 重启与验证

MCP server 由各席 harness 拉起;换了二进制后每席要重载 MCP 才用上新版本。顺序:**先非关键席,协调者最后**(协调者在换期间仍可调度):Reserve → OpenDot Dev → Model Gateway → Platform Dev → Infra Dev → Second Voice → Chief Review → Manager。

每席(在该席会话里):重载 MCP(Claude Code:`/mcp` 重连 agenthop;Codex:重启该席线程的 MCP),然后:

```text
工具列表里应出现:agenthop_tern、agenthop_tern_status(#1034)
调 agenthop_tern_status → 返回 JSON(schema 见 main @c3fbdde:packages/bus/src/tern-bridge.ts:501-543 ternStatus,
  mcp.ts:270-271 合并 workers):
  state        "healthy" | "degraded" | "unknown"     <- 判据;不是「JSON 且非 error」
  reasons      [string]                               <- degraded/unknown 的原因
  mirror       {tick, vm, tick_ms, tick_ms_max, age_ms, agents:<数量>}   <- 没有顶层 agents 数组;agents 是条数
  backlog      requests/ 里待处理请求数
  blocks       tern ls --json 的权威块数
  recentKills  tern.log 里本插件最近的超预算禁用行(可选)
  workers      {live:[...], orphan:[...], unknown:[...]}   <- tern-workers.ts workersStatus
期望:state="healthy",reasons=[],mirror.age_ms < 5000,backlog=0,recentKills 为空或缺省,workers.unknown=[]。
  state="degraded" => 读 reasons 逐条处理后重查,不进下一席;
  state="unknown"  => 观测不到(无 tern 二进制 / socket 拒连 / listing 坏),不是「桥死了」——先修观测再判,不进下一席。
```

蜂群侧核对(任一席执行):

```bash
tern ls --json | python3 -c 'import json,sys;print(sum(1 for s in json.load(sys.stdin)["sessions"] if s["name"]=="agenthop" for t in s["tabs"] for b in t["blocks"] if b.get("live")))'
# 期望:≥ 8(agenthop session 里 live 块数;八席都在)
python3 $R/tern/restore/tern-restore.py $R/tern/restore/roster.json --check | tail -1
# 期望:result: 8/8 seats OK
```

回滚:该席 MCP 重载回旧二进制(先做 ① 的回滚,再重载)。一席不过就停,不继续换下一席。

## ③ dispatcher 翻 SWARM_TERN_BRIDGE

```bash
python3 - <<'PY'
import json,os; p=os.path.expanduser("~/.agenthop/swarm/dispatcher-recipe.json"); d=json.load(open(p))
d["env"]["SWARM_TERN_BRIDGE"]="1"; d["env"].setdefault("TERN_BIN", os.path.expanduser("~/.local/bin/tern"))
tmp=p+".new"; json.dump(d,open(tmp,"w")); os.replace(tmp,p); print("recipe:",d["env"]["SWARM_TERN_BRIDGE"],d["env"]["TERN_BIN"])
PY
# 期望:recipe: 1 /Users/<you>/.local/bin/tern
```

重启 dispatcher —— **不用 `swarm-recover.ts`**:它读的是 `fleet-snapshot.json`(swarm-recover.ts:112-113)内嵌的旧 recipe,旧 snapshot 的 env 会覆盖刚改的值,而且它会把成员席一起拉起(完整 fleet recovery),不是「只起 dispatcher」。没有单起 dispatcher 的入口,所以按刚改的 `dispatcher-recipe.json` 手起:

停旧起新用一个 `bash -s` 块(一段独立脚本:中止 = `exit`,只退出该脚本,不退出你的 shell)。目标只认权威记录,不按文本猜:

- 旧 dispatcher = `~/.agenthop/swarm/dispatcher.lock` 里的 pid(swarm-dispatch.ts 用 acquireSingleFlight 写入自己的 `process.pid`,进程存活期间一直持有;single-flight.ts:69)。
- 身份 = 该 pid 的 cwd 等于 recipe 的 `cwd`,且命令行逐词等于 recipe 的 `argv`(recipe 由 dispatcher 启动时按自身 `process.argv`/cwd 自记,③ 只改了 env)。唯一放宽:最后一词(脚本)按 cwd 解析后比——`ps` 显示启动时的写法(实测是相对的 `scripts/swarm-dispatch.ts`),`process.argv` 记的是绝对路径。
- `pgrep -f scripts/swarm-dispatch.ts` 现实里会命中三个进程:`npm exec tsx …`、`tsx/dist/cli.mjs …`(包装器)和真 node 进程。只有锁里那个 pid 是 dispatcher;其余命中必须是它的祖先(包装器),否则 = 有第二棵 dispatcher 树 = 歧义,**零 kill 中止**。
- 只发 SIGTERM(dispatcher 收到后释放锁并退出)。10 秒内旧 pid 未退出,或包装器未随之退出,**零启动中止**(新 dispatcher 的 F44-⑤ 自检本来也会拒绝在残留包装器旁启动)。不自动 SIGKILL,由人判断。
- 新进程按刚改的 recipe 起,直接核 `Popen` 返回的 pid:它必须拿到锁,环境必须含新值。不再 `pgrep | head -1`。

```bash
bash -s <<'SH'   # 只起不停(仅限 rc=3 之后):START_ONLY=1 bash -s <<'SH'
set -u
S="$HOME/.agenthop/swarm"; RECIPE="$S/dispatcher-recipe.json"; LOCK="$S/dispatcher.lock"; PAT='scripts/swarm-dispatch[.]ts'
abort() { echo "ABORT: $*"; echo "ABORT: no new dispatcher started"; exit 2; }
if [ "${START_ONLY:-0}" != 1 ]; then
# 1) target = the lock holder, proven by argv + cwd against the recipe
OLD=$(cat "$LOCK" 2>/dev/null) || abort "cannot read $LOCK"
case "$OLD" in ''|*[!0-9]*) abort "lock content is not a pid: '$OLD'";; esac
kill -0 "$OLD" 2>/dev/null || abort "lock pid $OLD is not running (stale lock): no confirmed dispatcher to stop"
WCWD=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["cwd"])' "$RECIPE") || abort "cannot read recipe cwd"
GCWD=$(lsof -a -p "$OLD" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
[ "$GCWD" = "$WCWD" ] || abort "pid $OLD cwd '$GCWD' is not the recipe cwd '$WCWD'"
GOT=$(ps -ww -o command= -p "$OLD") || abort "ps cannot read pid $OLD"
python3 -c '
import json,os,sys
argv=json.load(open(sys.argv[1]))["argv"]; got=sys.argv[3].split(" ")
# ps shows the script as launched (often relative); the recipe holds it absolute. Resolve against the proven cwd.
ok=len(got)==len(argv) and got[:-1]==argv[:-1] and os.path.normpath(os.path.join(sys.argv[2],got[-1]))==argv[-1]
sys.exit(0 if ok else 1)' "$RECIPE" "$GCWD" "$GOT" || abort "pid $OLD command is not the recipe argv: $GOT"
# 2) every other pattern match must be an ancestor (npm/tsx wrapper) of OLD
ANC=" "; p=$OLD
while p=$(ps -o ppid= -p "$p" | tr -d ' ') && [ -n "$p" ] && [ "$p" -gt 1 ]; do ANC="$ANC$p "; done
WRAP=""
for m in $(pgrep -f "$PAT"); do
  [ "$m" = "$OLD" ] && continue
  case "$ANC" in *" $m "*) WRAP="$WRAP $m";; *) abort "pid $m matches $PAT but is neither $OLD nor its wrapper: two dispatcher trees? stop nothing";; esac
done
echo "stopping dispatcher $OLD (wrappers:${WRAP:- none})"
# 3) stop exactly OLD; confirm it and its wrappers are gone before anything starts
kill -TERM "$OLD" || abort "kill -TERM $OLD failed"
i=0; while kill -0 "$OLD" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
kill -0 "$OLD" 2>/dev/null && abort "pid $OLD still alive 10s after SIGTERM"
i=0; while [ -n "$(pgrep -f "$PAT")" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i+1)); done
LEFT=$(pgrep -f "$PAT" | tr '\n' ' ')
[ -z "$LEFT" ] || abort "old dispatcher exited but these still match $PAT: $LEFT"
echo "stopped: $OLD"
else
  # START_ONLY=1: only after a run that printed "stopped:" and then FAILed; refuse while anything still matches.
  LEFT=$(pgrep -f "$PAT" | tr '\n' ' '); [ -z "$LEFT" ] || abort "START_ONLY but these still match $PAT: $LEFT"
fi
# 4) start from the edited recipe; verify THE pid Popen returned
NEW=$(python3 - "$RECIPE" <<'PY'
import json,os,subprocess,sys
d=json.load(open(sys.argv[1]))
env={**os.environ, **d["env"]}
log=open(os.path.expanduser("~/.agenthop/swarm/dispatcher.log"),"a")
p=subprocess.Popen(d["argv"], cwd=d["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
print(p.pid)
PY
) || { echo "FAIL: launch error"; exit 3; }
case "$NEW" in ''|*[!0-9]*) echo "FAIL: launcher printed no pid: '$NEW'"; exit 3;; esac
i=0; while [ "$(cat "$LOCK" 2>/dev/null)" != "$NEW" ] && kill -0 "$NEW" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.5; i=$((i+1)); done
[ "$(cat "$LOCK" 2>/dev/null)" = "$NEW" ] || { echo "FAIL: new pid $NEW does not hold $LOCK (exited or refused; see dispatcher.log)"; exit 3; }
PENV=$(ps -E -ww -o command= -p "$NEW") || { echo "FAIL: ps cannot read the environment of pid $NEW"; exit 3; }
python3 -c '
import json,sys
env=json.load(open(sys.argv[1]))["env"]; words=sys.argv[2].split(" ")
bad=0
for k in ("SWARM_TERN_BRIDGE","TERN_BIN"):
    want=env.get(k); got=[w[len(k)+1:] for w in words if w.startswith(k+"=")]
    if want is None: print("FAIL: recipe has no "+k); bad=1
    elif got!=[want]: print("FAIL: pid env "+k+"="+(",".join(got) or "<missing>")+", recipe says "+want); bad=1
    else: print(k+"="+want)
sys.exit(bad)' "$RECIPE" "$PENV" || { echo "FAIL: new pid $NEW does not carry the recipe env (see lines above)"; exit 3; }
echo "OK: dispatcher pid $NEW holds the lock and carries the recipe env"
SH
echo "restart rc=$?"
# 期望:stopped: <旧 pid>;两行 SWARM_TERN_BRIDGE=1 与 TERN_BIN=/Users/<you>/.local/bin/tern(新进程实际环境逐值等于刚改的 recipe;
#       回滚时 recipe 写 "0",同一个门就要求进程里是 0);OK: dispatcher pid <新 pid> holds the lock and carries the recipe env;restart rc=0。
#       环境读不到 / 缺项 / 值与 recipe 不同 => FAIL 行 + rc=3(新进程已起但不对:先按 FAIL 行处理,再用本块停掉重起)。
# rc=2(ABORT)=没有起新进程:按 ABORT 行原因手工处理(歧义 = 先查清那几个 pid 是谁;旧进程不退 = 人工决定是否 SIGKILL),处理完重跑本块。
# rc=3(FAIL)=旧的已停,新的没起来:读 dispatcher.log 末尾;修好后以 START_ONLY=1 重跑本块(跳过 1)-3);仍有进程命中 $PAT 则 ABORT 不起)。
#       不带 START_ONLY 重跑会在第 1 步 ABORT「not running (stale lock)」,不会误起。
```

验证(等 30 秒):

```bash
pgrep -f "scripts/swarm-dispatch[.]ts" | wc -l; cat ~/.agenthop/swarm/dispatcher.lock   # 期望:1,且锁里是上一块打印的新 pid(直接起 node,无包装器)
t1=$(python3 -c 'import json;print(json.load(open("'"$P"'/agents.json"))["tick"])'); sleep 12
t2=$(python3 -c 'import json;print(json.load(open("'"$P"'/agents.json"))["tick"])'); echo "tick $t1 -> $t2"
# 期望:t2 > t1(5s mirror 在推,哪怕 Tern 在后台)
grep -E "tern-bridge: (armed|UNKNOWN|unhealthy|arm stopped)" ~/.agenthop/swarm/dispatcher.log | tail -3
# 期望:出现一行 "tern-bridge: armed sentinel for vm …";不应持续刷 UNKNOWN
python3 -c 'import json;d=json.load(open("'"$P"'/sentinel.json"));print(d.get("step"),d.get("count"))'
# 期望:scanned 1(恰一个巡检任务)
tail -5 ~/.agenthop/swarm/tern-bridge-reloads.log 2>/dev/null
# 期望:空或只有正常 reload 行;同一分钟内不应有两行 reload(60s 防抖)
```

回滚:recipe 里 `SWARM_TERN_BRIDGE` 改回 `"0"`(或用 `.pre-cutover` 覆盖),用上面同一个 `bash -s` 块重启 dispatcher;验证 dispatcher.log 不再出现 `tern-bridge:` 行。

## ④ 桥换 r14

```bash
tern plugin install $R/tern/agenthop-agents-bridge --force   # 复制进 tern plugin dir(当前是 install 形态,非 link)
tern plugin list | grep agenthop-agents-bridge               # 期望:… window  ready
tern plugin reload
sleep 8; grep "tern-bridge: armed sentinel" ~/.agenthop/swarm/dispatcher.log | tail -1
# 期望:新的一行,vm 与 reload 前不同(sweep 见 vm 变化后自动走 arm 序列)
python3 -c 'import json;d=json.load(open("'"$P"'/sentinel.json"));print(d.get("step"),d.get("count"))'   # 期望:scanned 1
grep -c "exceeded" "$HOME/Library/Logs/Tern/tern.log" ; sleep 60; grep -c "exceeded" "$HOME/Library/Logs/Tern/tern.log"
# 期望:两个数相同(这一分钟内没有新的 hook 超预算禁用)
```

回滚:`rm -rf "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge" && cp -R /tmp/bridge.pre-cutover "$HOME/Library/Application Support/Tern/plugins/agenthop-agents-bridge" && tern plugin reload`;sweep 会对新 vm 重新 arm。

## ⑤ 首个 kind=tui worker 冒烟

在一个低危席位(Reserve)经 agenthop_tern 起 **1 个** tui worker(#1034 的 start,`args.kind: "tui"`),给它一件只读小活并让它写回自己的箱。

```bash
SID=<Reserve 的 sid>
python3 -c 'import json;d=json.load(open("'$HOME'/.agenthop/swarm/seat-shell/'$SID'.json"));print([(w["name"],w["state"],type(w["pane"]).__name__) for w in d.get("workers",[])])'
# 期望:[('<角色>-<任务>', 'live', 'int')]
herdr session list --json | python3 -c 'import json,sys;print([s["name"] for s in json.load(sys.stdin)["sessions"]])'
# 期望:含 default 与 <角色>-<任务>
```

worker 写回箱后,经 agenthop_tern 发 `stop`(`args.worker:"<名>"`)。返回值是 `{state, name, steps, reason?}`(StopResult,packages/bus/src/tern-workers.ts:397 @c3fbdde;stopWorker 399-407,stopWorkerAfterRead 410-450)。

`steps` 只列**可观测的外部步骤**。内部记录转换(该 worker 记录 stopping → stopped)不在 `steps` 里:记录写成功不产生 step,只有写失败才 push 一项 `record <state>` ok:false(417)。所以正常成功不会出现 record 项,也不要求它。

```text
期望 state = "stopped";steps 每项 ok:true,依序为下面两种之一(按该 worker 记录有无 server_pid,430-439):
  有 server_pid(#1034 r4 起新起的 worker):"stop own server" -> "socket gone" -> "tern close" -> "herdr session delete"
  无 server_pid(旧记录):                   "herdr server stop" -> "socket gone" -> "tern close" -> "herdr session delete"
  pane=0(从未放块)时没有 "tern close"(443)。
内部记录(不在 steps 里,直接看 seat-shell):先写 stopping(424,同时是实例核验);steps 全 ok 才写 stopped + stopped_at(448)。
state="partial" => 至少一步 ok:false(看 detail;"ownership" / "socket gone" 失败时 "herdr session delete" 记为 skipped,ok:false)。
   记录**保持 stopping**(不写 stopped,仍占容量,可重发 stop)——按 detail 手工补那一步,不算冒烟通过。
state="unknown" => 没有动作:读不到该席记录 / 无此活 worker(402-405),或实例核验失败、记录写不进(424,reason 以 instance-mismatch 开头)。先查记录再判。
```

```bash
PANE=<start 返回的 pane>
tern ls --json | python3 -c 'import json,sys;print(any(b["id"]=='"$PANE"' for s in json.load(sys.stdin)["sessions"] for t in s["tabs"] for b in t["blocks"]))'
# 期望:False(这一次的 pane 确实已从 Tern 消失——不能只看 stopped 记录和 herdr session,tern close 失败时两者都可能已"干净")
# 再查同两条
# 期望:seat-shell 里该 worker state=stopped,stopped_at 为数字(内部记录转换在此核,不在 steps 里);herdr session list 只剩 default
sleep 130; grep "orphan-sweep" ~/.agenthop/swarm/dispatcher.log | tail -3; tail -3 ~/.agenthop/swarm/tern-bridge-reloads.log
# 期望:无 "orphan-sweep herdr session …" / "marked … orphan" 动作行(正常停掉的不是孤儿);gc 行为全零或不出现
```

故意不做第三步的变体(可选,验证孤儿巡检):只做前两步 → 等两轮(≥ 2 分钟)→ 期望出现一行 `orphan-sweep herdr session <名> … stop=true delete=true`,随后 `herdr session list` 只剩 default。

回滚:worker 未停干净(partial,记录仍 stopping)时按 steps 里 ok:false 那几步手工补齐;确认 pane 消失、herdr session 已删后,seat-shell 记录手工标 `stopped`。

## ⑥ 回滚总表

| 步 | 逆操作 | 判据 |
|---|---|---|
| ① | `.pre-cutover` 二进制经 `.new`+rename 放回 | `agenthop --version` = 旧串 |
| ② | 先 ① 回滚,再各席重载 MCP | 各席 agenthop_tern 工具消失(旧版本没有) |
| ③ | recipe `SWARM_TERN_BRIDGE=0`,重启 dispatcher | dispatcher.log 不再有 `tern-bridge:` 行 |
| ④ | 恢复 `/tmp/bridge.pre-cutover`,`tern plugin reload` | `tern plugin list` ready;sentinel.json `scanned 1`。注:只回滚了已安装的插件副本;dispatcher 调的 arm-schedule.sh / gc.sh 仍来自 checkout(或 AGENTHOP_BRIDGE_DIR),要连脚本一起回滚须把 checkout 切回旧 SHA |
| ⑤ | 手工三步 stop + seat-shell 标 stopped | `herdr session list` 只剩 default |

全量回滚顺序与上线相反:⑤ → ④ → ③ → ② → ①。

## 不做的事

- 不改 `~/.claude.json`(安全姿态由人做;tern-restore 只读检查)。
- 不在 dispatcher 运行中手改桥数据目录(`$HOME/Library/Application Support/Tern/plugin-data/agenthop-agents-bridge/`)。
- 不并行起多个 worker 做冒烟(上限与内存门由 #1046 管,冒烟只验一个的完整生灭)。
