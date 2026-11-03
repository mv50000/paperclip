// RK9-693 (nosto prep), RK9-707: issue visibility. Upstream v2026.1023 filters hidden issues and
// harness containers with `visibleIssueCondition()` (services/issue-visibility.ts). Fork-only
// services that query the `issues` table without it would leak hidden issues after the lift. The
// leak tests cannot run green on the current fork, so the cases are `it.todo` and get activated in
// the RK9-701 step.
//
// The inventory is open: the test scans server/src for files that query `issues` without the
// condition, and every hit must be classified below. A new unfiltered fork file fails the test.
// The upstream baseline is upstream code that the fork does not own; a lift that changes it fails
// here too, and the RK9-701 step then re-classifies the files.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "../..");

/** Last upstream commit before the fork's own server files (RK9-693 merge base). */
const FORK_BASE_COMMIT = "dffc2b3ca1";

const VISIBILITY_FILTER = /visibleIssueCondition|executionIssueCondition|visibleIssueSql|hiddenAt/;
const QUERIES_ISSUES = /\b(?:from|join|leftJoin|innerJoin|rightJoin|fullJoin|update|delete)\(\s*issues\b/;

/** Fork-only files that read or write `issues` with no visibleIssueCondition/hiddenAt filter. */
const FORK_FILES_WITHOUT_VISIBILITY_FILTER = [
  "routes/github-webhooks.ts",
  "services/agent-metrics.ts",
  "services/email/escalation.ts",
  "services/email/inbound-router.ts",
  "services/risk-incidents.ts",
  "services/risk-monitors.ts",
  "services/rk9-coord-inbox.ts",
  "services/rk9-coord-presence.ts",
  "services/rk9-run-taint.ts",
];

/** Upstream files without the filter at the RK9-707 snapshot. Not fork code: listed only to classify scan hits. */
const UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER = [
  "modules/run-dispatch/adapters/postgres.ts",
  "modules/wake-queue/adapters/queued-comment-postgres.ts",
  "routes/cases.ts",
  "routes/execution-workspaces.ts",
  "services/access.ts",
  "services/activity-log.ts",
  "services/agent-conversations.ts",
  "services/agents.ts",
  "services/authorization.ts",
  "services/built-in-agents.ts",
  "services/chat-channels.ts",
  "services/chat-interaction-publications.ts",
  "services/chat-run-publications.ts",
  "services/chat-teams-file-publication.ts",
  "services/companies.ts",
  "services/connection-intent-delivery.ts",
  "services/connection-intents.ts",
  "services/decision-retention.ts",
  "services/decision-training.ts",
  "services/decisions.ts",
  "services/documents.ts",
  "services/email-channels.ts",
  "services/environments.ts",
  "services/execution-blocker.ts",
  "services/execution-continuation.ts",
  "services/execution-control-reconciliation.ts",
  "services/execution-recovery-resolution.ts",
  "services/execution-status-delivery.ts",
  "services/explicit-native-continuation.ts",
  "services/export-fidelity.ts",
  "services/external-objects.ts",
  "services/feedback.ts",
  "services/github-operation-credentials.ts",
  "services/issue-approvals.ts",
  "services/issue-continuation-summary.ts",
  "services/issue-prefix.ts",
  "services/issue-references.ts",
  "services/issue-thread-interactions.ts",
  "services/issue-tree-control.ts",
  "services/legacy-execution-recovery.ts",
  "services/low-trust-runtime-containment.ts",
  "services/native-runtime/automatic-completion-reviews.ts",
  "services/native-runtime/chat-attachment-reuse.ts",
  "services/native-runtime/continuation-contract.ts",
  "services/native-runtime/current-wake-comments.ts",
  "services/native-runtime/external-chat-question-response-input.ts",
  "services/native-runtime/native-chat-review-presentation.ts",
  "services/native-runtime/native-chat-workspace.ts",
  "services/native-runtime/native-completion-feedback.ts",
  "services/native-runtime/native-finalization-reconciler.ts",
  "services/native-runtime/native-interaction-bridge.ts",
  "services/native-runtime/native-restart-recovery.ts",
  "services/native-runtime/native-run-finalizer.ts",
  "services/native-runtime/native-runner-file-handoff.ts",
  "services/native-runtime/native-safe-replacement.ts",
  "services/native-runtime/native-session-executor.ts",
  "services/native-runtime/native-workspace-finalizer.ts",
  "services/native-runtime/obsolete-policy-reviews.ts",
  "services/native-runtime/paperclip-runner-tool-authority.ts",
  "services/native-runtime/runner-prp-coordinator.ts",
  "services/native-runtime/runner-semantic-authority.ts",
  "services/native-runtime/status-decision-committer.ts",
  "services/onboarding-seed.ts",
  "services/project-tool-context.ts",
  "services/projects.ts",
  "services/question-response-delivery.ts",
  "services/recovery-observability.ts",
  "services/run-identity.ts",
  "services/runner-goals.ts",
  "services/secret-proposals.ts",
  "services/secrets.ts",
  "services/task-plan-context.ts",
  "services/task-watchdog-scope.ts",
  "services/tool-access-policy.ts",
  "services/tool-access.ts",
  "services/tool-action-delivery.ts",
  "services/tool-action-review.ts",
  "services/tool-gateway.ts",
  "services/workspace-file-resources.ts",
  "services/workspace-readiness.ts",
  "services/workspace-runtime.ts",
];

function scanUnfilteredIssueQueries(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        const src = readFileSync(full, "utf8");
        if (QUERIES_ISSUES.test(src) && !VISIBILITY_FILTER.test(src)) {
          hits.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(root);
  return hits.sort();
}

/** Server source files the fork added after FORK_BASE_COMMIT, or null when git history is missing (shallow CI clone). */
function forkAddedFiles(): Set<string> | null {
  try {
    execFileSync("git", ["cat-file", "-e", `${FORK_BASE_COMMIT}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=A", FORK_BASE_COMMIT, "HEAD", "--", "server/src"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return new Set(out.split("\n").filter(Boolean).map((file) => file.replace(/^server\/src\//, "")));
  } catch {
    return null;
  }
}

const forkAdded = forkAddedFiles();

describe("issue visibility inventory (RK9-693, RK9-707)", () => {
  it("classifies every file that queries issues without the visibility condition", () => {
    const known = new Set([...FORK_FILES_WITHOUT_VISIBILITY_FILTER, ...UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER]);
    const unclassified = scanUnfilteredIssueQueries().filter((file) => !known.has(file));
    // A new hit: add visibleIssueCondition() to the file, or list it above and add an it.todo leak case.
    expect(unclassified).toEqual([]);
  });

  it("keeps the lists current: each listed file exists and still lacks the condition", () => {
    for (const rel of [...FORK_FILES_WITHOUT_VISIBILITY_FILTER, ...UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER]) {
      const file = path.join(root, rel);
      expect(existsSync(file), rel).toBe(true);
      const src = readFileSync(file, "utf8");
      // When a file gains the filter, drop it from its list (and activate the leak case for fork files).
      expect(QUERIES_ISSUES.test(src) && !VISIBILITY_FILTER.test(src), rel).toBe(true);
    }
  });

  it.skipIf(forkAdded === null)("matches the fork list against the files git shows as fork-added", () => {
    const added = forkAdded!;
    const forkHits = scanUnfilteredIssueQueries().filter((file) => added.has(file));
    expect(forkHits).toEqual([...FORK_FILES_WITHOUT_VISIBILITY_FILTER].sort());
    expect(UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER.filter((file) => added.has(file))).toEqual([]);
  });

  it("keeps the shared condition hiding hidden and harness issues", () => {
    const src = readFileSync(path.join(root, "services/issue-visibility.ts"), "utf8");
    expect(src).toContain("isNull(issues.hiddenAt)");
    expect(src).toContain("isNull(issues.harnessKind)");
  });

  describe("leak when the condition is missing (activate in RK9-701)", () => {
    it.todo("agent-metrics: a hidden issue is not counted in agent workload");
    it.todo("risk-monitors: a hidden unassigned issue raises no stalled-work alert");
    it.todo("risk-incidents: reassign_tasks does not move a hidden in_progress issue to backlog");
    it.todo("rk9-coord-inbox: a hidden issue is not resolved by identifier or id");
    it.todo("rk9-coord-presence: a hidden issue is not joined into a run's presence row");
    it.todo("rk9-run-taint: a hidden issue does not taint a run");
    it.todo("email/escalation: a hidden issue is not joined into the escalation list");
    it.todo("email/inbound-router: an inbound reply does not reopen a hidden issue");
    it.todo("github-webhooks: a webhook does not match a hidden issue");
  });
});
