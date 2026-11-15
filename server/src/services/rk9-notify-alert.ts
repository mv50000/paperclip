// rk9_notify "alert" class for TypeScript host monitors (RK9-827, epic RK9-815).
//
// The bash library ~/.claude/bin/rk9-notify.lib.sh (claude-config) owns the
// contract: docs/implementation-notes/rk9-notify.md there. A TypeScript caller
// cannot source it, so this module implements the alert class with the same
// rules. scripts/check-github-webhook-health.ts is the only caller.
//
// Rules:
//   - An alert goes to the rk9claude webhook as a synthetic Alertmanager v4
//     alert, and to Telegram according to the mode (both | webhook).
//   - rk9claude accepted the alert only when it answers HTTP 200 with an empty
//     body. Any other answer, a network error or a timeout sends the alert to
//     Telegram with a "Varareitti:" line. An alert is never dropped silently.
//   - The bearer token travels in the Authorization header only. It is never
//     part of the URL, the body, a child process argv or a log line. Redirects
//     are not followed, so the header cannot reach another host.
//   - No call throws. The monitor's exit code is unchanged.
//
// Not implemented here, on purpose: the info and human classes, the dedup
// stamp (the monitor has its own throttle, like RK9_NOTIFY_COOLDOWN=0 callers)
// and notify-failed.log (the monitor's own log records every failure).

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  redactToken,
  sendTelegramAlert,
  type TelegramAlertConfig,
  type TelegramSendResult,
} from "./ops-telegram-alert.js";

type Env = Record<string, string | undefined>;

// Same patterns as the bash library: no whitespace or quote in the URL, and a
// token of printable ASCII without spaces.
const URL_RE = /^https?:\/\/[^\s"]+$/;
const TOKEN_RE = /^[!-~]+$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(:[A-Za-z0-9_.@/+:-]+)?$/;
const WEBHOOK_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_BYTES = 3000;
const DESCRIPTION_MAX_BYTES = 12_000;
const ENV_FILE_MAX_BYTES = 8192;
const MODE_FILE_MAX_BYTES = 64;
// sendTelegramAlert cuts the text at 3500 characters. The body is cut earlier
// so that the "Varareitti:" line survives.
const TELEGRAM_BODY_MAX = 3300;

export interface Rk9claudeWebhookConfig {
  url: string;
  token: string;
}

export type Rk9AlertMode = "both" | "webhook";

export interface Rk9AlertChannels {
  telegram: TelegramAlertConfig | null;
  webhook: Rk9claudeWebhookConfig | null;
  mode: Rk9AlertMode;
  /** Kill switch: everything goes straight to Telegram. */
  legacy: boolean;
  /** Alertmanager `host` label. Not a hosts.toml name, see rk9-notify.md. */
  host: string;
  severity: string;
}

function homeFile(env: Env, relative: string): string {
  const home = (env.HOME ?? "").trim();
  return home ? path.join(home, relative) : "";
}

/**
 * Read at most maxBytes from a regular file. O_NONBLOCK keeps a FIFO from
 * blocking the monitor, and the type and owner checks run on the open file
 * descriptor, so the file cannot change between the check and the read.
 */
function readSmallFile(
  file: string,
  maxBytes: number,
  opts: { ownRegularFileOnly: boolean },
): { text: string } | { error: "missing" | "unsafe" | "unreadable" } {
  if (!path.isAbsolute(file)) return { error: "missing" };
  let fd: number | null = null;
  try {
    const flags =
      fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      (opts.ownRegularFileOnly ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(file, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { error: "unsafe" };
    if (
      opts.ownRegularFileOnly &&
      typeof process.geteuid === "function" &&
      stat.uid !== process.geteuid()
    ) {
      return { error: "unsafe" };
    }
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, n).toString("utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { error: "missing" };
    // O_NOFOLLOW on a symlink gives ELOOP.
    if (code === "ELOOP") return { error: "unsafe" };
    return { error: "unreadable" };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

function validWebhookConfig(
  url: string | undefined,
  token: string | undefined,
): Rk9claudeWebhookConfig | null {
  const u = (url ?? "").trim();
  const t = (token ?? "").trim();
  if (!URL_RE.test(u) || !TOKEN_RE.test(t)) return null;
  try {
    const parsed = new URL(u);
    // Credentials belong in the header, never in the URL.
    if (parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { url: u, token: t };
}

/** KEY=VALUE lines only. The file is parsed, never executed. */
function parseEnvFile(text: string): Env {
  const out: Env = {};
  for (const raw of text.split("\n")) {
    const m = /^\s*(?:export\s+)?(RK9CLAUDE_WEBHOOK_URL|RK9CLAUDE_WEBHOOK_TOKEN)=(.*)$/.exec(
      raw.replace(/\r$/, ""),
    );
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1];
    out[m[1]] = value;
  }
  return out;
}

/**
 * Webhook credentials, or null when the webhook is not configured.
 *
 * Source order:
 *   1. RK9CLAUDE_WEBHOOK_URL and RK9CLAUDE_WEBHOOK_TOKEN in the environment
 *      (systemd EnvironmentFile, read as root). If either is set, the file is
 *      not read: a broken value must not fall through to another source.
 *   2. The file ${RK9_NOTIFY_WEBHOOK_ENV:-~/.config/rk9/rk9claude-webhook.env},
 *      the same file the bash library and ci-failure-poller.sh use.
 */
export function readRk9claudeWebhookConfig(env: Env): Rk9claudeWebhookConfig | null {
  const envUrl = env.RK9CLAUDE_WEBHOOK_URL;
  const envToken = env.RK9CLAUDE_WEBHOOK_TOKEN;
  if ((envUrl ?? "") !== "" || (envToken ?? "") !== "") {
    return validWebhookConfig(envUrl, envToken);
  }
  const file =
    (env.RK9_NOTIFY_WEBHOOK_ENV ?? "").trim() ||
    homeFile(env, ".config/rk9/rk9claude-webhook.env");
  if (!file) return null;
  const read = readSmallFile(file, ENV_FILE_MAX_BYTES, { ownRegularFileOnly: false });
  if ("error" in read) return null;
  const parsed = parseEnvFile(read.text);
  return validWebhookConfig(parsed.RK9CLAUDE_WEBHOOK_URL, parsed.RK9CLAUDE_WEBHOOK_TOKEN);
}

/**
 * Alert mode (RK9-862): the environment variable wins, then the first word of
 * the switch file, then "both". Only the word "webhook" changes the mode. The
 * switch file is read only when it is the caller's own regular file and not a
 * symlink. A warning never prints the file content.
 */
export function readRk9AlertMode(
  env: Env,
  warn: (line: string) => void = (line) => console.warn(line),
): Rk9AlertMode {
  if (env.RK9_NOTIFY_ALERT_MODE !== undefined) {
    return env.RK9_NOTIFY_ALERT_MODE === "webhook" ? "webhook" : "both";
  }
  const file =
    (env.RK9_NOTIFY_ALERT_MODE_FILE ?? "").trim() ||
    homeFile(env, ".config/rk9/notify-alert-mode");
  if (!file) return "both";
  const read = readSmallFile(file, MODE_FILE_MAX_BYTES, { ownRegularFileOnly: true });
  if ("error" in read) {
    if (read.error === "unsafe") {
      warn(
        `WARN: rk9_notify: kytkintiedosto ${file} ei ole ajajan oma tavallinen tiedosto, joten tila on both.`,
      );
    }
    return "both";
  }
  const firstLine = read.text.replace(/[\0\r]/g, "").split("\n")[0] ?? "";
  const word = firstLine.trim().split(/[ \t]+/)[0] ?? "";
  if (word === "webhook") return "webhook";
  if (word === "" || word === "both") return "both";
  warn(
    `WARN: rk9_notify: tuntematon arvo kytkintiedostossa ${file} (sallitut: webhook, both), joten tila on both.`,
  );
  return "both";
}

function readLegacySwitch(env: Env): boolean {
  if (env.RK9_NOTIFY_LEGACY === "1") return true;
  const file =
    (env.RK9_NOTIFY_LEGACY_FILE ?? "").trim() || homeFile(env, ".config/rk9/notify-legacy");
  return file !== "" && existsSync(file);
}

/** Everything the alert sender needs, read once from the environment. */
export function readRk9AlertChannels(
  env: Env,
  telegram: TelegramAlertConfig | null,
  warn: (line: string) => void = (line) => console.warn(line),
): Rk9AlertChannels {
  return {
    telegram,
    webhook: readRk9claudeWebhookConfig(env),
    mode: readRk9AlertMode(env, warn),
    legacy: readLegacySwitch(env),
    host: (env.RK9_NOTIFY_HOST ?? "").trim() || `rk9-notify-${hostname().split(".")[0]}`,
    severity: (env.RK9_NOTIFY_SEVERITY ?? "").trim() || "warning",
  };
}

export const RK9CLAUDE_WEBHOOK_MISSING_WARNING =
  "WARN: rk9claude-webhookin tunnuksia ei ole (RK9CLAUDE_WEBHOOK_URL ja RK9CLAUDE_WEBHOOK_TOKEN), joten hälytys lähtee vain Telegramiin.";

/**
 * At most maxBytes bytes of well-formed UTF-8. rk9claude rejects a payload
 * with a broken sequence (422), so a multi-byte character is never cut in half.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  // The round trip replaces lone surrogates with U+FFFD.
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

function hash8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

export interface AlertmanagerPayloadInput {
  /** Name[:qualifier]. The name is the Alertmanager alertname. */
  key: string;
  message: string;
  host: string;
  severity: string;
  now: Date;
}

/**
 * Synthetic Alertmanager v4 payload, the same shape as the bash library sends.
 * The instance label carries a hash of the message: rk9claude's cooldown is
 * per (alertname, host, instance), so a different message is a different key
 * and the same message keeps the same key and fingerprint.
 */
export function buildAlertmanagerPayload(input: AlertmanagerPayloadInput) {
  const colon = input.key.indexOf(":");
  const alertname = colon === -1 ? input.key : input.key.slice(0, colon);
  const qualifier = colon === -1 ? alertname : input.key.slice(colon + 1);
  const messageHash = hash8(input.message);
  const instance = `${qualifier}#${messageHash}`;
  const labels = {
    alertname,
    host: input.host,
    severity: input.severity,
    source: "rk9_notify",
    instance,
  };
  return {
    version: "4",
    groupKey: `rk9_notify:${input.host}:${alertname}:${instance}`,
    status: "firing",
    receiver: "rk9_notify",
    alerts: [
      {
        status: "firing",
        labels,
        annotations: {
          // rk9claude shows only the summary in Telegram, so it is the whole message.
          summary: truncateUtf8(input.message, SUMMARY_MAX_BYTES),
          description: truncateUtf8(input.message, DESCRIPTION_MAX_BYTES),
        },
        startsAt: input.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "",
        fingerprint: `rk9n-${hash8(`${alertname}:${qualifier}:${messageHash}`)}`,
      },
    ],
    groupLabels: { alertname, host: input.host },
    commonLabels: labels,
    commonAnnotations: {},
    externalURL: "rk9_notify",
  };
}

export interface Rk9AlertDeps {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => Date;
}

interface WebhookPostResult {
  acked: boolean;
  /** Fixed-form reason. It reaches Telegram, so it never holds error text. */
  reason: string;
}

/** A short code for the log only, such as ECONNREFUSED or TimeoutError. */
function errorCode(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : (err as { name?: unknown })?.name;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "tuntematon";
}

async function postToRk9claude(
  config: Rk9claudeWebhookConfig,
  payload: unknown,
  deps: Required<Pick<Rk9AlertDeps, "fetchImpl" | "warn">>,
): Promise<WebhookPostResult> {
  let status: number | null = null;
  try {
    const res = await deps.fetchImpl(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // A redirect is not an acknowledgement, and the token must not follow it.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    status = res.status;
    // rk9claude answers an accepted alert with a bare 200. A 200 with a body
    // (a proxy page, the wrong service) is not its acknowledgement.
    let hasBody = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value && chunk.value.byteLength > 0) {
          hasBody = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    if (status === 200 && !hasBody) return { acked: true, reason: "HTTP 200" };
    if (status === 200) return { acked: false, reason: "HTTP 200, odottamaton runko" };
    return { acked: false, reason: `HTTP ${status}` };
  } catch (err) {
    deps.warn(
      redactToken(
        `WARN: rk9claude-webhook: pyyntö epäonnistui (${errorCode(err)}).`,
        config.token,
      ),
    );
    // Headers can arrive before the body breaks or the timeout fires.
    return {
      acked: false,
      reason: status === null ? "HTTP 000" : `HTTP ${status}, vastaus katkesi`,
    };
  }
}

export interface Rk9AlertInput {
  /** Name[:qualifier], for example PaperclipWebhookMonitor:probe. */
  key: string;
  message: string;
}

export interface Rk9AlertResult {
  /**
   * True when the alert reached the operator's side: Telegram confirmed it, or
   * rk9claude acknowledged it in webhook mode or when Telegram is not
   * configured. In both mode a webhook acknowledgement alone is not a delivery,
   * because rk9claude may decide not to show the alert.
   */
  delivered: boolean;
  /** False when neither channel is configured: the alert exists only in the log. */
  configured: boolean;
  webhook: "acked" | "failed" | "unconfigured" | "skipped";
  webhookReason: string;
  telegram: TelegramSendResult | "not_needed";
}

/** Send one alert. Never throws and never logs the token or the webhook URL. */
export async function sendRk9Alert(
  input: Rk9AlertInput,
  channels: Rk9AlertChannels,
  deps: Rk9AlertDeps = {},
): Promise<Rk9AlertResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const telegramDeps = { fetchImpl, log, warn };
  const configured = channels.telegram !== null || channels.webhook !== null;

  // An invalid key is a caller bug. The alert still goes to Telegram.
  const keyValid = KEY_RE.test(input.key);
  if (!keyValid) {
    warn(`WARN: rk9_notify: virheellinen avain, joten hälytys lähtee vain Telegramiin.`);
  }
  if (channels.legacy || !keyValid) {
    const telegram = await sendTelegramAlert(channels.telegram, input.message, telegramDeps);
    return {
      delivered: telegram === "sent",
      configured: channels.telegram !== null,
      webhook: "skipped",
      webhookReason: channels.legacy ? "legacy" : "invalid key",
      telegram,
    };
  }

  let post: WebhookPostResult = { acked: false, reason: "unconfigured" };
  if (channels.webhook) {
    const payload = buildAlertmanagerPayload({
      key: input.key,
      message: input.message,
      host: channels.host,
      severity: channels.severity,
      now: (deps.now ?? (() => new Date()))(),
    });
    post = await postToRk9claude(channels.webhook, payload, { fetchImpl, warn });
  }
  const webhook: Rk9AlertResult["webhook"] = post.acked
    ? "acked"
    : channels.webhook
      ? "failed"
      : "unconfigured";

  if (post.acked) log("rk9claude: hälytys vastaanotettu.");
  if (post.acked && channels.mode === "webhook") {
    return { delivered: true, configured, webhook, webhookReason: post.reason, telegram: "not_needed" };
  }

  let text = input.message;
  if (webhook === "failed") {
    warn(`WARN: rk9claude-webhook ei ottanut hälytystä vastaan (${post.reason}). Varareitti: Telegram.`);
    const body =
      text.length > TELEGRAM_BODY_MAX ? `${text.slice(0, TELEGRAM_BODY_MAX)}\n…` : text;
    text = `${body}\n\nVarareitti: rk9claude-webhook ei vastannut (${post.reason})`;
  }
  const telegram = await sendTelegramAlert(channels.telegram, text, telegramDeps);
  const delivered = telegram === "sent" || (post.acked && telegram === "skipped");
  if (!delivered && configured) {
    warn(
      post.acked
        ? "WARN: rk9_notify: Telegram epäonnistui. Webhookin kuittaus ei riitä tilassa both, joten hälytystä ei toimitettu."
        : telegram === "skipped"
          ? "WARN: rk9_notify: webhook epäonnistui eikä Telegramia ole määritetty, joten hälytystä ei toimitettu."
          : "WARN: rk9_notify: webhook ja Telegram epäonnistuivat, joten hälytystä ei toimitettu.",
    );
  }
  return { delivered, configured, webhook, webhookReason: post.reason, telegram };
}
