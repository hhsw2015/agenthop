# ① remote-herdr unified-view — LIVE proof (2026-10-07, authorized Railway VM vm-railway-rhv1)
## capacity probe (③) live: nproc=2, free Mem=2372165632 B (~2.21GB) -> agentCapacity=1 (Railway small=1-2)
## ssh bridge (the crux): herdr system-ssh -> tailcat ECH dataplane via ProxyCommand
  Host vm-railway-rhv1 / User root / ProxyCommand sh -c 'exec tailcat \$(cat <addrFile>) 22'
  (ssh root@...:22 over tailcat works; local ssh key authorized by vm-ssh keyed mode)
## machine add: needs remote herdr 0.9.3 pre-installed (non-interactive won't auto-install)
  remote install: curl -fsSL https://herdr.dev/install.sh | sh  -> herdr 0.9.3 (matched local)
## machine add result:
5e1f7856be9dfc9cdb7288dce953189b	vm-railway-rhv1	vm-railway-rhv1	default	enabled
## --machine control (local -> remote herdr):
agent list: {"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}
pane list: {"id":"cli:pane:list","result":{"panes":[{"agent_status":"unknown","cwd":"/root","focused":true,"foreground_cwd":"/root","pane_id":"w1:p1","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_fro
status: status: running version: 0.9.3 
