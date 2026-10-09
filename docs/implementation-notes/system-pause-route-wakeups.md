# System pause and route-built wakeups (RK9-459)

- Routes build `heartbeatService(db)` without the `systemPause` option. The
  factory falls back to `createReadOnlySystemPause`, which caches the
  `instance_settings` read for 10 s like the owning `systemPauseService`. A pause
  set or cleared therefore reaches route instances within 10 s.
- A non-timer, non-automation wake during a pause throws `conflict("System paused: ...")`.
  `isSystemPausedConflict` (`server/src/errors.ts`) identifies it. The issue
  comment path (`routes/issues.ts`, conversation delivery) and the recovery
  sweep swallow it: the comment is already saved, only the wake is skipped.
- Assignment wakeups go through `queueIssueAssignmentWakeup`, which already
  catches and logs every wake error. Blocked-owner notification uses
  `source: "automation"`, which returns `null` during a pause.
- No replay of dropped wakes after resume. Conversation comments are redelivered
  by the recovery sweep (`deliverConversationComments` finds undelivered
  comments). Assigned issues are picked up again by the stranded-assignee
  reconciler. Other dropped wakes are `writeSkippedRequest("system.paused")`
  rows; a replay is only needed if the reconciler proves too slow in practice.
