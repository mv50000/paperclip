// RK9-693 (nosto prep), RK9-707: issue visibility. Upstream v2026.1023 filters hidden issues and
// harness containers with `visibleIssueCondition()` (services/issue-visibility.ts). Fork-only
// services that query the `issues` table without it would leak hidden issues after the lift. RK9-701
// added the filter to the ten fork files and activated the leak cases (nosto-private-issue-visibility-leaks-rk9.test.ts).
//
// The inventory is open: the test scans server/src for files that query `issues` without the
// condition, and every hit must be classified below. A new unfiltered fork file fails the test.
// The upstream baseline is upstream code that the fork does not own; a lift that changes it fails
// here too, and the RK9-701 step then re-classifies the files and moves FORK_BASE_COMMIT to the new
// upstream base. The check works per file: one filtered query hides the file from the scan.
// The git cross-check needs the FORK_BASE_COMMIT tree. CI fetches that one commit (pr.yml, RK9-709)
// and the check must run there; only a local clone without the commit skips it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "../..");

/** Upstream merge base of the fork (v2026.1023.0 since RK9-701; v2026.1012.0 bba6a45f0d in RK9-700; v2026.1005.0 467125fafb in RK9-699; was dffc2b3ca1, the RK9-693 merge base). */
const FORK_BASE_COMMIT = "1b4c803816";

const VISIBILITY_FILTER = /visibleIssueCondition|executionIssueCondition|visibleIssueSql|hiddenAt|hidden_at/;
const QUERY_CALL = String.raw`\b(?:from|join|leftJoin|innerJoin|rightJoin|fullJoin|update|delete)\(\s*`;

/** Drops // and /* *\/ comments but keeps string and template literals, so a comment neither adds nor hides a query. */
function stripComments(src: string): string {
  return src.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal: string | undefined) => literal ?? (match.startsWith("/*") ? match.replace(/[^\n]/g, " ") : ""),
  );
}

/**
 * True when the (comment-free) source queries the `issues` table. Recognised forms:
 * - query-builder calls `from(issues`, `join(issues`, `update(issues`, ... also through an import alias
 *   (`issues as issueRows`) and a drizzle alias (`const x = alias(issues, "x")` then `.from(x)`)
 * - the relational query API: `db.query.issues.findMany(...)`
 * - an `sql` template that interpolates the table: `${issues}`
 * - plain SQL text: `from issues`, `join "issues"`, `update issues`, `insert into issues`
 * Known limits: prose in a string ("cannot update issues") counts as a query, and the comment
 * stripper does not parse regex literals or nested template literals.
 */
function queriesIssues(src: string): boolean {
  const code = stripComments(src);
  const tables = ["issues", ...Array.from(code.matchAll(/\bissues\s+as\s+(\w+)/g), (match) => match[1])];
  const aliases = tables.flatMap((table) =>
    Array.from(code.matchAll(new RegExp(String.raw`\b(\w+)\s*=\s*alias\(\s*${table}\s*,`, "g")), (match) => match[1]),
  );
  return (
    [...tables, ...aliases].some((name) => new RegExp(`${QUERY_CALL}${name}\\b`).test(code)) ||
    /\bquery\s*\.\s*issues\s*\./.test(code) ||
    /\$\{\s*issues\s*\}/.test(code) ||
    /\b(?:from|join|update|into)\s+"?issues"?(?![\w.])/i.test(code)
  );
}

/** True when the file queries `issues` and no code (comments excluded) applies the visibility condition. */
function lacksVisibilityFilter(src: string): boolean {
  return queriesIssues(src) && !VISIBILITY_FILTER.test(stripComments(src));
}

/** Fork-only files that read or write `issues` with no visibleIssueCondition/hiddenAt filter. */
const FORK_FILES_WITHOUT_VISIBILITY_FILTER: string[] = [
  // Intentional (RK9-701): taint is a safety gate and fails safe, so hidden issues still taint.
  "services/rk9-run-taint.ts",
];

/** Upstream files without the filter at the RK9-707 snapshot, re-classified at v2026.1005.0 (RK9-699), v2026.1012.0 (RK9-700) and v2026.1023.0 (RK9-701). Not fork code: listed only to classify scan hits. */
const UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER = [
  "modules/run-dispatch/adapters/postgres.ts",
  "modules/wake-queue/adapters/queued-comment-postgres.ts",
  "realtime/live-events-ws.ts",
  "routes/agents.ts",
  "routes/assets.ts",
  "routes/browser-use.ts",
  "routes/cases.ts",
  "routes/execution-workspaces.ts",
  "routes/issue-tree-control.ts",
  "services/access.ts",
  "services/activity-log.ts",
  "services/agent-commentary.ts",
  "services/agent-conversations.ts",
  "services/agent-deletion.ts",
  "services/authorization.ts",
  "services/browser-use.ts",
  "services/built-in-agents.ts",
  "services/chat-channels.ts",
  "services/chat-completion-delivery.ts",
  "services/chat-github-response-comments.ts",
  "services/chat-github-reviews.ts",
  "services/chat-interaction-publications.ts",
  "services/chat-run-publications.ts",
  "services/chat-teams-file-publication.ts",
  "services/companies.ts",
  "services/company-deletion.ts",
  "services/confirmation-comment-resolution.ts",
  "services/connection-intent-delivery.ts",
  "services/connection-intents.ts",
  "services/conversation-confirmation-context.ts",
  "services/decision-models.ts",
  "services/decision-retention.ts",
  "services/decision-training.ts",
  "services/decisions.ts",
  "services/documents.ts",
  "services/dot-runner-broker.ts",
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
  "services/heartbeat-run-privacy.ts",
  "services/heartbeat.ts",
  "services/heartbeat/recovery.ts",
  "services/heartbeat/retries.ts",
  "services/heartbeat/run-completion.ts",
  "services/heartbeat/run-control.ts",
  "services/heartbeat/run-preparation.ts",
  "services/heartbeat/run-state.ts",
  "services/heartbeat/workspaces.ts",
  "services/human-directed-work.ts",
  "services/idle-sleep-safety.ts",
  "services/issue-approvals.ts",
  "services/issue-continuation-summary.ts",
  "services/issue-creation-origin.ts",
  "services/issue-creation-source.ts",
  "services/issue-prefix.ts",
  "services/issue-references.ts",
  "services/issue-thread-interactions.ts",
  "services/issue-title.ts",
  "services/issue-tree-control.ts",
  "services/legacy-execution-recovery.ts",
  "services/legacy-shutdown-workspace-settlement.ts",
  "services/low-trust-runtime-containment.ts",
  "services/native-runtime/automatic-completion-reviews.ts",
  "services/native-runtime/chat-attachment-reuse.ts",
  "services/native-runtime/child-review-outcomes.ts",
  "services/native-runtime/continuation-contract.ts",
  "services/native-runtime/current-wake-comments.ts",
  "services/native-runtime/external-chat-question-response-input.ts",
  "services/native-runtime/handoff-plan-context.ts",
  "services/native-runtime/native-chat-review-presentation.ts",
  "services/native-runtime/native-chat-workspace.ts",
  "services/native-runtime/native-completion-feedback.ts",
  "services/native-runtime/native-finalization-reconciler.ts",
  "services/native-runtime/native-interaction-bridge.ts",
  "services/native-runtime/native-restart-recovery.ts",
  "services/native-runtime/native-review-dispatch.ts",
  "services/native-runtime/native-review-participant.ts",
  "services/native-runtime/native-run-coordinator-store.ts",
  "services/native-runtime/native-run-finalizer.ts",
  "services/native-runtime/native-runner-file-handoff.ts",
  "services/native-runtime/native-safe-replacement.ts",
  "services/native-runtime/native-session-executor.ts",
  "services/native-runtime/native-session-handoff.ts",
  "services/native-runtime/native-workspace-export-recovery.ts",
  "services/native-runtime/native-workspace-export-retry.ts",
  "services/native-runtime/native-workspace-finalizer.ts",
  "services/native-runtime/obsolete-policy-reviews.ts",
  "services/native-runtime/paperclip-control-plane-port.ts",
  "services/native-runtime/runner-prp-coordinator.ts",
  "services/native-runtime/runner-semantic-authority.ts",
  "services/native-runtime/status-decision-committer.ts",
  "services/onboarding-seed.ts",
  "services/owner-chat-instruction-authority.ts",
  "services/plugin-host-services.ts",
  "services/project-tool-context.ts",
  "services/projects.ts",
  "services/public-mcp/file-transfers.ts",
  "services/question-response-delivery.ts",
  "services/recovery-observability.ts",
  "services/recovery/review-path-recovery-escalation.ts",
  "services/run-cost-accounting.ts",
  "services/run-identity.ts",
  "services/runner-goals.ts",
  "services/satisfied-connection-intents.ts",
  "services/secret-proposals.ts",
  "services/secrets.ts",
  "services/slack-board-messages.ts",
  "services/slack-conversation-state.ts",
  "services/task-plan-context.ts",
  "services/task-watchdog-scope.ts",
  "services/tool-access-policy.ts",
  "services/tool-access.ts",
  "services/tool-action-delivery.ts",
  "services/tool-action-review.ts",
  "services/tool-gateway.ts",
  "services/voice/voice-session-service.ts",
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
        if (lacksVisibilityFilter(src)) {
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
      ["diff", "--name-only", "--no-renames", "--diff-filter=A", FORK_BASE_COMMIT, "HEAD", "--", "server/src"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return new Set(out.split("\n").filter(Boolean).map((file) => file.replace(/^server\/src\//, "")));
  } catch {
    return null;
  }
}

const forkAdded = forkAddedFiles();
/** pr.yml fetches FORK_BASE_COMMIT and sets this flag, so a missing commit there is a CI break, not a skip. */
const requireGitHistory = process.env.RK9_REQUIRE_FORK_BASE === "1";

describe("issue visibility inventory (RK9-693, RK9-707)", () => {
  it("classifies every file that queries issues without the visibility condition", () => {
    const known = new Set([...FORK_FILES_WITHOUT_VISIBILITY_FILTER, ...UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER]);
    const unclassified = scanUnfilteredIssueQueries().filter((file) => !known.has(file));
    // A new hit: add visibleIssueCondition() to the file, or list it above and add a leak case to the leaks test file.
    expect(unclassified).toEqual([]);
  });

  it("keeps the lists current: each listed file exists and still lacks the condition", () => {
    for (const rel of [...FORK_FILES_WITHOUT_VISIBILITY_FILTER, ...UPSTREAM_BASELINE_WITHOUT_VISIBILITY_FILTER]) {
      const file = path.join(root, rel);
      expect(existsSync(file), rel).toBe(true);
      const src = readFileSync(file, "utf8");
      // When a file gains the filter, drop it from its list (and add a leak case for fork files).
      expect(lacksVisibilityFilter(src), rel).toBe(true);
    }
  });

  it("recognises every query form and ignores comments (RK9-709)", () => {
    const imports = `import { issues } from "@paperclipai/db";\n`;
    const detected = {
      builderFrom: `${imports}db.select().from(issues);`,
      builderJoin: `${imports}db.select().from(agents).leftJoin(issues, eq(a, b));`,
      importAlias: `import { issues as issueRows } from "@paperclipai/db";\ndb.update(issueRows).set({});`,
      drizzleAlias: `${imports}const parent = alias(issues, "parent");\ndb.select().from(parent);`,
      drizzleAliasOfImportAlias: `import { issues as issueRows } from "@paperclipai/db";\nconst p = alias(issueRows, "p");\ndb.select().from(p);`,
      relationalQuery: `db.query.issues.findMany({ where: eq(a, b) });`,
      sqlInterpolation: `${imports}db.execute(sql\`SELECT id FROM \${issues} WHERE x = 1\`);`,
      sqlText: `db.execute(sql.raw("select id from issues where company_id = $1"));`,
      sqlTextQuoted: `db.execute(sql\`UPDATE "issues" SET status = 'done'\`);`,
      sqlTextInsert: `db.execute(sql\`insert into issues (id) values (1)\`);`,
    };
    for (const [form, src] of Object.entries(detected)) {
      expect(lacksVisibilityFilter(src), form).toBe(true);
    }
    const notDetected = {
      columnOnly: `${imports}const id = issues.id;`,
      commentedQuery: `${imports}// db.select().from(issues)\n/* select * from issues */`,
      columnInSql: `${imports}sql\`\${issues.id} = 1\``,
    };
    for (const [form, src] of Object.entries(notDetected)) {
      expect(queriesIssues(src), form).toBe(false);
    }
    // A comment that names the filter no longer hides an unfiltered query.
    expect(lacksVisibilityFilter(`${imports}// TODO hiddenAt\ndb.select().from(issues);`)).toBe(true);
    expect(lacksVisibilityFilter(`${imports}db.select().from(issues).where(isNull(issues.hiddenAt));`)).toBe(false);
    expect(lacksVisibilityFilter(`db.execute(sql\`select id from issues where hidden_at is null\`);`)).toBe(false);
  });

  it("fetches FORK_BASE_COMMIT in the CI test job (RK9-709)", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
    const fetched = workflow.match(/git fetch --no-tags --depth=1 origin ([0-9a-f]{40})/)?.[1];
    expect(fetched?.startsWith(FORK_BASE_COMMIT), `pr.yml fetches ${fetched}`).toBe(true);
    expect(workflow).toContain('RK9_REQUIRE_FORK_BASE: "1"');
  });

  it.skipIf(forkAdded === null && !requireGitHistory)("matches the fork list against the files git shows as fork-added", () => {
    // With the pr.yml flag set, a null here means the FORK_BASE_COMMIT fetch step is missing or broken.
    expect(forkAdded, `git history for ${FORK_BASE_COMMIT} is missing`).not.toBeNull();
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

  // The leak cases for the former fork-only files live in nosto-private-issue-visibility-leaks-rk9.test.ts (RK9-701).
});
