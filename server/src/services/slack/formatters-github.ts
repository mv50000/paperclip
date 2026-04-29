import {
  contextLine,
  fields,
  header,
  section,
  type FormattedMessage,
} from "./formatters.js";

type Payload = Record<string, unknown>;

function pickString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function pickNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickRecord(value: unknown): Payload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Payload;
}

function repoLabel(repoFullName: string): string {
  return `\`${repoFullName}\``;
}

function actor(payload: Payload): string {
  const sender = pickRecord(payload.sender);
  if (!sender) return "(unknown)";
  return pickString(sender.login, "(unknown)");
}

function truncate(text: string, max = 280): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatWorkflowRunFailed(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const wf = pickRecord(payload.workflow_run) ?? {};
  const wfName = pickString(wf.name ?? wf.display_title, "(workflow)");
  const branch = pickString(wf.head_branch, "(branch)");
  const conclusion = pickString(wf.conclusion, "failure");
  const url = pickString(wf.html_url);
  const runNumber = pickNumber(wf.run_number);
  const sha = pickString(wf.head_sha).slice(0, 7);
  const commitMessage = pickString(pickRecord(wf.head_commit)?.message ?? "");
  const text = `:x: CI failed — ${wfName} on ${branch} — ${repoFullName}`;
  return {
    text,
    blocks: [
      header(`:x: ${wfName} failed`),
      section(
        `*${companyName}* — ${repoLabel(repoFullName)}\nBranch: \`${branch}\`${runNumber ? ` · Run #${runNumber}` : ""}${sha ? ` · \`${sha}\`` : ""}${commitMessage ? `\n_${truncate(commitMessage.split("\n")[0] ?? "", 200)}_` : ""}`,
      ),
      fields([
        ["Conclusion", `\`${conclusion}\``],
        ["By", actor(payload)],
      ]),
      contextLine(url ? `<${url}|Open run on GitHub>` : ""),
    ],
  };
}

export function formatIssueOpened(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const issue = pickRecord(payload.issue) ?? {};
  const title = pickString(issue.title, "(no title)");
  const number = pickNumber(issue.number);
  const url = pickString(issue.html_url);
  const body = pickString(issue.body ?? "");
  const text = `:bookmark_tabs: New issue — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      header(`:bookmark_tabs: New issue${number ? ` #${number}` : ""}`),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\n*${title}*${body ? `\n_${truncate(body, 280)}_` : ""}`),
      contextLine(`Opened by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatIssueClosed(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const issue = pickRecord(payload.issue) ?? {};
  const title = pickString(issue.title, "(no title)");
  const number = pickNumber(issue.number);
  const url = pickString(issue.html_url);
  const stateReason = pickString(issue.state_reason);
  const text = `:white_check_mark: Issue closed — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      section(`:white_check_mark: *${companyName}* — Issue${number ? ` #${number}` : ""} closed in ${repoLabel(repoFullName)}\n*${title}*${stateReason ? ` _(${stateReason})_` : ""}`),
      contextLine(`Closed by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatIssueReopened(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const issue = pickRecord(payload.issue) ?? {};
  const title = pickString(issue.title, "(no title)");
  const number = pickNumber(issue.number);
  const url = pickString(issue.html_url);
  const text = `:repeat: Issue reopened — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      section(`:repeat: *${companyName}* — Issue${number ? ` #${number}` : ""} reopened in ${repoLabel(repoFullName)}\n*${title}*`),
      contextLine(`Reopened by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatPROpened(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const pr = pickRecord(payload.pull_request) ?? {};
  const title = pickString(pr.title, "(no title)");
  const number = pickNumber(pr.number);
  const url = pickString(pr.html_url);
  const draft = pr.draft === true;
  const body = pickString(pr.body ?? "");
  const baseRef = pickString(pickRecord(pr.base)?.ref);
  const headRef = pickString(pickRecord(pr.head)?.ref);
  const emoji = draft ? ":memo:" : ":sparkles:";
  const text = `${emoji} ${draft ? "Draft PR" : "New PR"} — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      header(`${emoji} ${draft ? "Draft PR" : "New PR"}${number ? ` #${number}` : ""}`),
      section(
        `*${companyName}* — ${repoLabel(repoFullName)}\n*${title}*${baseRef && headRef ? `\n\`${headRef}\` → \`${baseRef}\`` : ""}${body ? `\n_${truncate(body, 240)}_` : ""}`,
      ),
      contextLine(`Opened by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatPRReadyForReview(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const pr = pickRecord(payload.pull_request) ?? {};
  const title = pickString(pr.title, "(no title)");
  const number = pickNumber(pr.number);
  const url = pickString(pr.html_url);
  const text = `:white_check_mark: PR ready for review — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      section(`:white_check_mark: *${companyName}* — PR${number ? ` #${number}` : ""} ready for review in ${repoLabel(repoFullName)}\n*${title}*`),
      contextLine(`By *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatPRClosedNotMerged(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const pr = pickRecord(payload.pull_request) ?? {};
  const title = pickString(pr.title, "(no title)");
  const number = pickNumber(pr.number);
  const url = pickString(pr.html_url);
  const text = `:wastebasket: PR closed (not merged) — ${repoFullName} #${number ?? "?"}: ${title}`;
  return {
    text,
    blocks: [
      section(`:wastebasket: *${companyName}* — PR${number ? ` #${number}` : ""} closed without merging in ${repoLabel(repoFullName)}\n*${title}*`),
      contextLine(`Closed by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatPRReviewRequested(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const pr = pickRecord(payload.pull_request) ?? {};
  const title = pickString(pr.title, "(no title)");
  const number = pickNumber(pr.number);
  const url = pickString(pr.html_url);
  const reviewer = pickRecord(payload.requested_reviewer);
  const reviewerLogin = reviewer ? pickString(reviewer.login, "(reviewer)") : "(reviewer)";
  const text = `:eyes: Review requested from ${reviewerLogin} — ${repoFullName} #${number ?? "?"}`;
  return {
    text,
    blocks: [
      section(`:eyes: *${companyName}* — Review requested from *${reviewerLogin}* on PR${number ? ` #${number}` : ""} in ${repoLabel(repoFullName)}\n*${title}*`),
      contextLine(`Requested by *${actor(payload)}* · ${url ? `<${url}|View on GitHub>` : ""}`),
    ],
  };
}

export function formatRelease(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const release = pickRecord(payload.release) ?? {};
  const tag = pickString(release.tag_name, "(no tag)");
  const name = pickString(release.name ?? release.tag_name, tag);
  const url = pickString(release.html_url);
  const body = pickString(release.body ?? "");
  const prerelease = release.prerelease === true;
  const emoji = prerelease ? ":construction:" : ":rocket:";
  const text = `${emoji} Release ${tag} — ${repoFullName}: ${name}`;
  return {
    text,
    blocks: [
      header(`${emoji} ${prerelease ? "Pre-release" : "Release"} ${tag}`),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\n*${name}*${body ? `\n${truncate(body, 500)}` : ""}`),
      contextLine(`Released by *${actor(payload)}* · ${url ? `<${url}|View release>` : ""}`),
    ],
  };
}

export function formatSecurityAdvisory(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const adv = pickRecord(payload.security_advisory) ?? {};
  const summary = pickString(adv.summary, "(security advisory)");
  const ghsa = pickString(adv.ghsa_id);
  const severity = pickString(adv.severity, "unknown");
  const url = pickString(adv.html_url ?? adv.references);
  const text = `:rotating_light: Security advisory ${ghsa} — ${repoFullName} (${severity})`;
  return {
    text,
    blocks: [
      header(`:rotating_light: Security advisory${ghsa ? ` ${ghsa}` : ""}`),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\n*Severity:* \`${severity}\`\n${summary}`),
      contextLine(url ? `<${url}|View advisory>` : ""),
    ],
  };
}

export function formatDependabotAlert(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const alert = pickRecord(payload.alert) ?? {};
  const adv = pickRecord(alert.security_advisory) ?? {};
  const dep = pickRecord(pickRecord(alert.dependency)?.package) ?? {};
  const summary = pickString(adv.summary, "(advisory)");
  const ghsa = pickString(adv.ghsa_id);
  const severity = pickString(adv.severity, "unknown");
  const pkg = pickString(dep.name, "(package)");
  const ecosystem = pickString(dep.ecosystem);
  const url = pickString(alert.html_url);
  const text = `:warning: Dependabot ${severity} — ${pkg} in ${repoFullName}`;
  return {
    text,
    blocks: [
      header(`:warning: Dependabot alert (${severity})`),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\n*${pkg}*${ecosystem ? ` (${ecosystem})` : ""}${ghsa ? ` · ${ghsa}` : ""}\n${summary}`),
      contextLine(url ? `<${url}|View alert>` : ""),
    ],
  };
}

export function formatSecretScanningAlert(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const alert = pickRecord(payload.alert) ?? {};
  const secretType = pickString(alert.secret_type_display_name ?? alert.secret_type, "(secret)");
  const number = pickNumber(alert.number);
  const url = pickString(alert.html_url);
  const text = `:lock: Secret scanning — ${secretType} found in ${repoFullName}`;
  return {
    text,
    blocks: [
      header(":lock: Secret scanning alert"),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\nDetected: *${secretType}*${number ? ` (alert #${number})` : ""}\n_Rotate the secret immediately if it is real._`),
      contextLine(url ? `<${url}|View alert>` : ""),
    ],
  };
}

export function formatDeploymentFailed(
  payload: Payload,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const status = pickRecord(payload.deployment_status) ?? {};
  const deployment = pickRecord(payload.deployment) ?? {};
  const env = pickString(deployment.environment, "(env)");
  const description = pickString(status.description ?? "");
  const url = pickString(status.target_url ?? status.log_url ?? deployment.url);
  const text = `:fire: Deployment failed — ${env} — ${repoFullName}`;
  return {
    text,
    blocks: [
      header(`:fire: Deployment failed`),
      section(`*${companyName}* — ${repoLabel(repoFullName)}\nEnvironment: \`${env}\`${description ? `\n_${truncate(description, 240)}_` : ""}`),
      contextLine(url ? `<${url}|View deployment>` : ""),
    ],
  };
}

export interface MentionContext {
  body: string;
  commentUrl: string;
  parentUrl: string;
  parentTitle: string;
  parentNumber: number | null;
  authorLogin: string;
  matchedHandle: string;
}

export function formatMention(
  ctx: MentionContext,
  repoFullName: string,
  companyName: string,
): FormattedMessage {
  const num = ctx.parentNumber ? ` #${ctx.parentNumber}` : "";
  const text = `:mega: @${ctx.matchedHandle} mentioned by ${ctx.authorLogin} — ${repoFullName}${num}`;
  return {
    text,
    blocks: [
      section(`:mega: *@${ctx.matchedHandle}* mentioned by *${ctx.authorLogin}* in ${repoLabel(repoFullName)}${num}\n*${ctx.parentTitle}*\n> ${truncate(ctx.body.replace(/\n/g, " "), 360)}`),
      contextLine(
        `*${companyName}* · ${ctx.commentUrl ? `<${ctx.commentUrl}|Jump to comment>` : ""}${ctx.parentUrl ? ` · <${ctx.parentUrl}|Open thread>` : ""}`,
      ),
    ],
  };
}
