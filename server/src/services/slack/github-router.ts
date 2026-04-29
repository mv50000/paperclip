import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companySecrets } from "@paperclipai/db";
import { secretService } from "../secrets.js";
import { logger } from "../../middleware/logger.js";
import { createSlackClientService, type SlackClientService } from "./client.js";
import { createChannelResolver, type ChannelResolver, type ChannelTarget } from "./channel-resolver.js";
import {
  formatWorkflowRunFailed,
  formatIssueOpened,
  formatIssueClosed,
  formatIssueReopened,
  formatPROpened,
  formatPRReadyForReview,
  formatPRClosedNotMerged,
  formatPRReviewRequested,
  formatRelease,
  formatSecurityAdvisory,
  formatDependabotAlert,
  formatSecretScanningAlert,
  formatDeploymentFailed,
  formatMention,
  type MentionContext,
} from "./formatters-github.js";
import type { FormattedMessage } from "./formatters.js";

const REPO_MAP_SECRET_NAME = "github.repo_full_name";
const MENTION_HANDLES_SECRET_NAME = "github.mention_handles";
const NOTIFY_MAIN_PUSHES_SECRET_NAME = "github.notify_main_pushes";
const REPO_MAP_CACHE_TTL_MS = 5 * 60 * 1000;
const COMPANY_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const MENTION_HANDLES_CACHE_TTL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 30 * 1000;

interface DispatchTarget {
  target: ChannelTarget;
  message: FormattedMessage;
}

type Payload = Record<string, unknown>;

function pickString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function pickRecord(value: unknown): Payload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Payload;
}

export interface GithubRouter {
  handle(args: {
    event: string;
    payload: Payload;
    deliveryId: string;
  }): Promise<{ companyId: string | null; dispatched: number }>;
  invalidateRepoMap(): void;
}

export function createGithubRouter(db: Db): GithubRouter {
  const slackClient = createSlackClientService(db);
  const channelResolver = createChannelResolver(db);
  const secrets = secretService(db);

  let repoMapCache: { map: Map<string, string>; fetchedAt: number } | null = null;
  const companyNameCache = new Map<string, { name: string; fetchedAt: number }>();
  const mentionHandlesCache = new Map<string, { handles: string[]; fetchedAt: number }>();
  const notifyMainPushesCache = new Map<string, { enabled: boolean; fetchedAt: number }>();
  const debounceCache = new Map<string, number>();

  function debounceKey(parts: Array<string | number | null | undefined>): string {
    return parts.map((p) => String(p ?? "")).join(":");
  }

  function shouldDebounce(key: string): boolean {
    const now = Date.now();
    const last = debounceCache.get(key);
    if (last && now - last < DEBOUNCE_MS) return true;
    debounceCache.set(key, now);
    return false;
  }

  async function loadRepoMap(): Promise<Map<string, string>> {
    if (repoMapCache && Date.now() - repoMapCache.fetchedAt < REPO_MAP_CACHE_TTL_MS) {
      return repoMapCache.map;
    }
    const rows = await db
      .select({
        id: companySecrets.id,
        companyId: companySecrets.companyId,
      })
      .from(companySecrets)
      .where(eq(companySecrets.name, REPO_MAP_SECRET_NAME));

    const map = new Map<string, string>();
    for (const row of rows) {
      try {
        const value = (await secrets.resolveSecretValue(row.companyId, row.id, "latest")).trim();
        if (value) map.set(value, row.companyId);
      } catch (err) {
        logger.warn({ err, companyId: row.companyId }, "failed to resolve github.repo_full_name");
      }
    }
    repoMapCache = { map, fetchedAt: Date.now() };
    return map;
  }

  async function resolveCompanyByRepo(repoFullName: string): Promise<string | null> {
    const map = await loadRepoMap();
    return map.get(repoFullName) ?? null;
  }

  async function getCompanyName(companyId: string): Promise<string> {
    const cached = companyNameCache.get(companyId);
    if (cached && Date.now() - cached.fetchedAt < COMPANY_NAME_CACHE_TTL_MS) {
      return cached.name;
    }
    const row = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((r) => r[0] ?? null);
    const name = row?.name ?? "Unknown company";
    companyNameCache.set(companyId, { name, fetchedAt: Date.now() });
    return name;
  }

  async function getMentionHandles(companyId: string): Promise<string[]> {
    const cached = mentionHandlesCache.get(companyId);
    if (cached && Date.now() - cached.fetchedAt < MENTION_HANDLES_CACHE_TTL_MS) {
      return cached.handles;
    }
    let handles: string[] = [];
    try {
      const secret = await secrets.getByName(companyId, MENTION_HANDLES_SECRET_NAME);
      if (secret) {
        const value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
        handles = value
          .split(/[,\s]+/)
          .map((h) => h.replace(/^@/, "").trim())
          .filter(Boolean);
      }
    } catch (err) {
      logger.warn({ err, companyId }, "failed to resolve mention handles");
    }
    mentionHandlesCache.set(companyId, { handles, fetchedAt: Date.now() });
    return handles;
  }

  async function getNotifyMainPushes(companyId: string): Promise<boolean> {
    const cached = notifyMainPushesCache.get(companyId);
    if (cached && Date.now() - cached.fetchedAt < MENTION_HANDLES_CACHE_TTL_MS) {
      return cached.enabled;
    }
    let enabled = false;
    try {
      const secret = await secrets.getByName(companyId, NOTIFY_MAIN_PUSHES_SECRET_NAME);
      if (secret) {
        const value = await secrets.resolveSecretValue(companyId, secret.id, "latest");
        enabled = value.trim().toLowerCase() === "true";
      }
    } catch (err) {
      logger.warn({ err, companyId }, "failed to resolve notify_main_pushes");
    }
    notifyMainPushesCache.set(companyId, { enabled, fetchedAt: Date.now() });
    return enabled;
  }

  function findMentionMatch(body: string, handles: string[]): string | null {
    if (!body || handles.length === 0) return null;
    for (const handle of handles) {
      const re = new RegExp(`@${escapeRegex(handle)}\\b`, "i");
      if (re.test(body)) return handle;
    }
    return null;
  }

  async function classify(
    event: string,
    payload: Payload,
    repoFullName: string,
    companyId: string,
    companyName: string,
  ): Promise<DispatchTarget[]> {
    const action = pickString(payload.action);

    switch (event) {
      case "workflow_run": {
        const wf = pickRecord(payload.workflow_run) ?? {};
        if (action !== "completed") return [];
        const conclusion = pickString(wf.conclusion);
        if (conclusion !== "failure") return [];
        const key = debounceKey([
          companyId,
          "workflow_run",
          pickString(wf.workflow_id ?? wf.id),
          pickString(wf.head_branch),
        ]);
        if (shouldDebounce(key)) return [];
        return [{ target: "company", message: formatWorkflowRunFailed(payload, repoFullName, companyName) }];
      }

      case "issues": {
        if (action === "opened") {
          return [{ target: "company", message: formatIssueOpened(payload, repoFullName, companyName) }];
        }
        if (action === "closed") {
          const issueNum = pickRecord(payload.issue)?.number;
          const key = debounceKey([companyId, "issue.closed", repoFullName, String(issueNum)]);
          if (shouldDebounce(key)) return [];
          return [{ target: "company", message: formatIssueClosed(payload, repoFullName, companyName) }];
        }
        if (action === "reopened") {
          return [{ target: "company", message: formatIssueReopened(payload, repoFullName, companyName) }];
        }
        return [];
      }

      case "pull_request": {
        const pr = pickRecord(payload.pull_request) ?? {};
        const merged = pr.merged === true;
        if (action === "closed" && merged) return [];
        if (action === "opened") {
          return [{ target: "company", message: formatPROpened(payload, repoFullName, companyName) }];
        }
        if (action === "ready_for_review") {
          return [{ target: "company", message: formatPRReadyForReview(payload, repoFullName, companyName) }];
        }
        if (action === "closed" && !merged) {
          const key = debounceKey([companyId, "pr.closed.notmerged", repoFullName, String(pr.number)]);
          if (shouldDebounce(key)) return [];
          return [{ target: "company", message: formatPRClosedNotMerged(payload, repoFullName, companyName) }];
        }
        if (action === "review_requested") {
          return [{ target: "company", message: formatPRReviewRequested(payload, repoFullName, companyName) }];
        }
        return [];
      }

      case "release": {
        if (action !== "published") return [];
        const message = formatRelease(payload, repoFullName, companyName);
        return [
          { target: "company", message },
          { target: "board", message },
        ];
      }

      case "security_advisory": {
        if (action !== "published" && action !== "updated") return [];
        const message = formatSecurityAdvisory(payload, repoFullName, companyName);
        return [
          { target: "company", message },
          { target: "board", message },
        ];
      }

      case "dependabot_alert": {
        if (action !== "created" && action !== "reopened") return [];
        const severity = pickString(pickRecord(pickRecord(payload.alert)?.security_advisory)?.severity);
        if (severity !== "high" && severity !== "critical") return [];
        return [{ target: "company", message: formatDependabotAlert(payload, repoFullName, companyName) }];
      }

      case "secret_scanning_alert": {
        if (action !== "created") return [];
        const message = formatSecretScanningAlert(payload, repoFullName, companyName);
        return [
          { target: "company", message },
          { target: "board", message },
        ];
      }

      case "deployment_status": {
        const status = pickRecord(payload.deployment_status) ?? {};
        if (pickString(status.state) !== "failure") return [];
        return [{ target: "company", message: formatDeploymentFailed(payload, repoFullName, companyName) }];
      }

      case "push": {
        const ref = pickString(payload.ref);
        if (ref !== "refs/heads/main" && ref !== "refs/heads/master") return [];
        const enabled = await getNotifyMainPushes(companyId);
        if (!enabled) return [];
        const commits = Array.isArray(payload.commits) ? payload.commits : [];
        if (commits.length === 0) return [];
        const headCommit = pickRecord(payload.head_commit) ?? {};
        const msg = pickString(headCommit.message).split("\n")[0] ?? "(no message)";
        return [
          {
            target: "company",
            message: {
              text: `:arrow_up: Push to ${ref} — ${repoFullName}: ${msg}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `:arrow_up: *${companyName}* — push to \`${ref}\` in \`${repoFullName}\` (${commits.length} commit${commits.length === 1 ? "" : "s"})\n_${msg}_`,
                  },
                },
              ],
            },
          },
        ];
      }

      case "issue_comment":
      case "pull_request_review_comment": {
        if (action !== "created") return [];
        const comment = pickRecord(payload.comment) ?? {};
        const body = pickString(comment.body);
        const handles = await getMentionHandles(companyId);
        const matched = findMentionMatch(body, handles);
        if (!matched) return [];
        const parent =
          event === "issue_comment"
            ? pickRecord(payload.issue) ?? {}
            : pickRecord(payload.pull_request) ?? {};
        const ctx: MentionContext = {
          body,
          commentUrl: pickString(comment.html_url),
          parentUrl: pickString(parent.html_url),
          parentTitle: pickString(parent.title, "(thread)"),
          parentNumber:
            typeof parent.number === "number" && Number.isFinite(parent.number) ? (parent.number as number) : null,
          authorLogin: pickString(pickRecord(comment.user)?.login, "(user)"),
          matchedHandle: matched,
        };
        return [{ target: "company", message: formatMention(ctx, repoFullName, companyName) }];
      }

      case "pull_request_review": {
        if (action !== "submitted") return [];
        const review = pickRecord(payload.review) ?? {};
        const state = pickString(review.state);
        if (state !== "changes_requested" && state !== "approved") return [];
        const body = pickString(review.body);
        const handles = await getMentionHandles(companyId);
        const matched = findMentionMatch(body, handles);
        if (!matched && state !== "changes_requested") return [];
        const pr = pickRecord(payload.pull_request) ?? {};
        const ctx: MentionContext = {
          body: body || (state === "approved" ? "approved" : "changes requested"),
          commentUrl: pickString(review.html_url),
          parentUrl: pickString(pr.html_url),
          parentTitle: pickString(pr.title, "(PR)"),
          parentNumber: typeof pr.number === "number" && Number.isFinite(pr.number) ? (pr.number as number) : null,
          authorLogin: pickString(pickRecord(review.user)?.login, "(reviewer)"),
          matchedHandle: matched ?? (state === "changes_requested" ? "review" : "review"),
        };
        return [{ target: "company", message: formatMention(ctx, repoFullName, companyName) }];
      }

      case "check_run":
      case "check_suite":
        return [];

      default:
        return [];
    }
  }

  async function dispatch(
    companyId: string,
    targets: DispatchTarget[],
  ): Promise<number> {
    let posted = 0;
    for (const { target, message } of targets) {
      const channel = await channelResolver.resolve(companyId, target);
      if (!channel) continue;
      const result = await slackClient.postMessage(companyId, {
        channel,
        text: message.text,
        blocks: message.blocks,
      });
      if (!result.ok) {
        if (result.reason !== "integration_disabled") {
          logger.info({ companyId, target, channel, reason: result.reason }, "slack github post skipped");
        }
        continue;
      }
      posted += 1;
    }
    return posted;
  }

  async function handle(args: {
    event: string;
    payload: Payload;
    deliveryId: string;
  }): Promise<{ companyId: string | null; dispatched: number }> {
    const repo = pickRecord(args.payload.repository);
    const repoFullName = repo ? pickString(repo.full_name) : "";
    if (!repoFullName) {
      return { companyId: null, dispatched: 0 };
    }

    const companyId = await resolveCompanyByRepo(repoFullName);
    if (!companyId) {
      logger.info(
        { delivery: args.deliveryId, event: args.event, repoFullName },
        "github webhook for unmapped repo — drop",
      );
      return { companyId: null, dispatched: 0 };
    }

    const companyName = await getCompanyName(companyId);
    let targets: DispatchTarget[] = [];
    try {
      targets = await classify(args.event, args.payload, repoFullName, companyId, companyName);
    } catch (err) {
      logger.warn(
        { err, delivery: args.deliveryId, event: args.event, repoFullName, companyId },
        "github router classify failed",
      );
      return { companyId, dispatched: 0 };
    }

    if (targets.length === 0) {
      return { companyId, dispatched: 0 };
    }

    const dispatched = await dispatch(companyId, targets);
    return { companyId, dispatched };
  }

  function invalidateRepoMap() {
    repoMapCache = null;
  }

  return { handle, invalidateRepoMap };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
