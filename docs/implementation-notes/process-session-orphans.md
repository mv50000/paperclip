# Process-session wrapper orphans (RK9-358)

Remote-run tests in `packages/adapter-utils` left `paperclip-process-session-remote.mjs`
wrappers and their `fake-acp.js` children alive after the test temp root was deleted
(297 orphans, 6.4 GB on 2026-09-28).

Fixes:

- The wrapper (`execution-target.ts`, shared poll tail) ends itself and its child when
  the session directory or the child cwd disappears (watchdog timer, interval
  `PAPERCLIP_PROCESS_SESSION_WATCH_INTERVAL_MS`, default 2 s), on SIGTERM/SIGHUP/SIGINT,
  when the stdin poll loop dies, and always SIGKILLs the child in its `exit` hook.
- `terminate()` has a backstop `process.exit()` after the kill grace period, only while the child still runs (never before pending output drains).
- Tests call `reapProcessesUnder(roots)` (`src/test-support/reap-process-session-orphans.ts`)
  in `afterEach` before deleting temp roots. It kills every process whose cmdline, cwd
  or environ names a root. Linux only.
- Regression tests: `src/process-session-orphan.test.ts`.

## RK9-361 follow-up

- A termination signal (SIGTERM/SIGHUP/SIGINT) always ends the wrapper: it runs
  `terminate()`, then exits 200 ms after the child has exited (128 + signal number).
  Before this, a child that exited while its own subprocess held the stdout/stderr
  pipe never fired `close`, so SIGTERM left the wrapper alive. The backstop exits 1.
- The wrapper still signals only its direct child through the handle (I2). A
  process-group kill was rejected: it needs a detached child, and then a SIGKILL to the
  wrapper's own group no longer reaches the agent.
- The bridge server (`paperclip-bridge-server.mjs`) runs the same watchdog
  (`PAPERCLIP_BRIDGE_WATCH_INTERVAL_MS`, default 2 s). It exits once its start cwd or the
  file-mode queue dir is missing or is a different directory (dev/inode). The identity
  check matters: a timed-out run keeps writing after teardown and recreates the path.
  The parent pid is useless here because the host starts the bridge with `nohup`.
- The reaper only kills processes that carry this test run's marker env
  `PCP_TEST_REAPER_MARKER` (not `PAPERCLIP_*`: `runChildProcess` strips those). It also
  sweeps every root it has seen once more when the test worker exits, which catches a
  bridge server that a timed-out run started after `afterEach`.
- The reaper now also runs in `run-fault-matrix`, the claude/codex/gemini `acp.test.ts`,
  `execution-target-stdin-race` and `execution-target-sandbox`.

Check: run the files above plus `src/acpx-engine` with `--testTimeout=400`, then
`pgrep -fc "process-session-remote|paperclip-bridge-server"` and processes with a deleted
`/tmp/paperclip-*` cwd must not grow.

Check: run `pnpm exec vitest run packages/adapter-utils`, then
`pgrep -f 'node .*paperclip-process-session-remote'` must print nothing.
