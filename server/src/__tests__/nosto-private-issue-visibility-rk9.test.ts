// RK9-693 (nosto prep): issue visibility. Upstream v2026.1023 filters hidden issues and harness
// containers with `visibleIssueCondition()` (services/issue-visibility.ts). Seven fork-only
// services query the `issues` table without it. The leak test cannot run green on the current
// fork, so the cases are `it.todo` and get activated in the RK9-701 step.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fork-only files that read `issues` with no visibleIssueCondition/hiddenAt filter (RK9-693 list). */
const FORK_FILES_WITHOUT_VISIBILITY_FILTER = [
  "services/agent-metrics.ts",
  "services/risk-monitors.ts",
  "services/rk9-coord-inbox.ts",
  "services/rk9-run-taint.ts",
  "services/email/escalation.ts",
  "services/email/inbound-router.ts",
  "routes/github-webhooks.ts",
];

describe("issue visibility inventory (RK9-693)", () => {
  it("lists the fork files that still query issues without the visibility condition", () => {
    for (const rel of FORK_FILES_WITHOUT_VISIBILITY_FILTER) {
      const file = path.join(root, rel);
      expect(existsSync(file), rel).toBe(true);
      const src = readFileSync(file, "utf8");
      // Inventory pin: when a file gains the filter, drop it from the list above.
      expect(/visibleIssueCondition|executionIssueCondition|visibleIssueSql|hiddenAt/.test(src), rel).toBe(false);
    }
  });

  it("keeps the shared condition hiding hidden and harness issues", () => {
    const src = readFileSync(path.join(root, "services/issue-visibility.ts"), "utf8");
    expect(src).toContain("isNull(issues.hiddenAt)");
    expect(src).toContain("isNull(issues.harnessKind)");
  });

  describe("leak when the condition is missing (activate in RK9-701)", () => {
    it.todo("agent-metrics: a hidden issue is not counted in agent workload");
    it.todo("risk-monitors: a hidden unassigned issue raises no stalled-work alert");
    it.todo("rk9-coord-inbox: a hidden issue is not resolved by identifier or id");
    it.todo("rk9-run-taint: a hidden issue does not taint a run");
    it.todo("email/escalation: a hidden issue is not joined into the escalation list");
    it.todo("email/inbound-router: an inbound reply does not reopen a hidden issue");
    it.todo("github-webhooks: a webhook does not match a hidden issue");
  });
});
