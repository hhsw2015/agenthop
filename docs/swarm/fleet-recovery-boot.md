# fleet-recovery — boot automation (④ optional tier, Q4)

The highest-automation tier of full-fleet-recovery: run `swarm-recover` automatically on login/boot, so a machine that reboots brings
its swarm back with NO human present. **Opt-in, default OFF** (a persistent system change is a user-gated action, same precedent as
`install --mcp`). Recovery works fully without this — the coordinator / dialog-officer / manual entries are the default triggers.

Because an auto-boot run has no human watching, it STILL writes the durable dual report (`console/fleet-recovery.json` + the
coordinator inbox summary, with an S19 when anything is not `confirmed`) so the outcome — including an F54 wake-INERT dispatcher — is
visible when the coordinator/user returns.

## macOS — LaunchAgent (per-user)

Write `~/Library/LaunchAgents/tech.imatrix.agenthop.fleet-recovery.plist` (adjust the repo path + node/tsx path to match your install):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>tech.imatrix.agenthop.fleet-recovery</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <!-- -l so the login profile (PATH, ANTHROPIC_API_KEY / CPA_API_KEY from the shell) is sourced; recovery merges those secrets
         OVER the captured non-secret env (Q1). cd into the repo so the relative dispatcher command resolves. -->
    <string>cd /Users/YOU/Dev/agenthop && npx tsx scripts/swarm-recover.ts</string>
  </array>
  <key>RunAtLoad</key>        <true/>   <!-- fire once at login -->
  <key>StandardOutPath</key>  <string>/Users/YOU/.agenthop/swarm/fleet-recovery-boot.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.agenthop/swarm/fleet-recovery-boot.log</string>
  <key>ProcessType</key>      <string>Background</string>
</dict>
</plist>
```

Enable / disable:

```bash
launchctl load   ~/Library/LaunchAgents/tech.imatrix.agenthop.fleet-recovery.plist   # opt-in
launchctl unload ~/Library/LaunchAgents/tech.imatrix.agenthop.fleet-recovery.plist   # opt-out
```

## Linux — systemd user unit (sketch)

`~/.config/systemd/user/agenthop-fleet-recovery.service` with `Type=oneshot`, `ExecStart=/bin/sh -lc 'cd <repo> && npx tsx scripts/swarm-recover.ts'`, `WantedBy=default.target`; `systemctl --user enable --now agenthop-fleet-recovery.service`.

## Keeping the snapshot fresh (Q6)

Boot-recovery only helps if a recent `fleet-snapshot.json` + `roster-snapshot.json` exist. What is wired TODAY (be precise — do not
over-claim):

- **Dispatcher recipe + fleet-snapshot: WIRED, at dispatcher STARTUP** (not at closeout). When `SWARM_FLEET_RECOVERY` is on
  (flagDefaultOn, default ON), the dispatcher — on every startup — self-records its EXACT launch recipe (`process.argv` array +
  allowlisted/scrubbed env + cwd; lossless, unlike a ps capture) to `dispatcher-recipe.json` and writes a fresh `fleet-snapshot.json`
  carrying it. So the dispatcher half is always current as of its last start (zero-risk: it only writes two files, fail-soft).
- **Roster snapshot: captured by `swarm-recover --snapshot`** (manual, cron, or the boot plist's own pre-reboot hook) — the dispatcher
  records only ITSELF, not the live window roster. Run `--snapshot` before a planned reboot, or on a cron, to keep the roster fresh.
- There is NO closeout-seam auto-capture (an earlier draft of this doc claimed one; it was never wired). The two mechanisms above are
  the whole story.

`swarm-recover` REFUSES when the fleet-snapshot OR the roster is absent/corrupt (it never recovers an empty fleet), and warns when the
snapshot it is recovering from is older than 24h (it then relaunches from a possibly outdated roster rather than refuse — a stale
recovery beats none, honestly flagged).

## Follow-on

An `install --recover-on-boot` convenience flag (writes/removes the plist for you, with the user-gated confirmation that any persistent
system change requires) is a focused follow-on — the plist above is usable by hand today.
