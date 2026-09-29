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

Check: run `pnpm exec vitest run packages/adapter-utils`, then
`pgrep -f 'node .*paperclip-process-session-remote'` must print nothing.
