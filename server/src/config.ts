import { readConfigFile } from "./config-file.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolvePaperclipEnvPath } from "./paths.js";
import { maybeRepairLegacyWorktreeConfigAndEnvFiles } from "./worktree-config.js";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
  type BindMode,
  type AuthBaseUrlMode,
  type DeploymentExposure,
  type DeploymentMode,
  type SecretProvider,
  type StorageProvider,
  inferBindModeFromHost,
  isAllInterfacesHost,
  isLoopbackHost,
  resolveRuntimeBind,
  validateConfiguredBindMode,
} from "@paperclipai/shared";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveHomeAwarePath,
} from "./home-paths.js";

const PAPERCLIP_ENV_FILE_PATH = resolvePaperclipEnvPath();
if (existsSync(PAPERCLIP_ENV_FILE_PATH)) {
  loadDotenv({ path: PAPERCLIP_ENV_FILE_PATH, override: false, quiet: true });
}

const CWD_ENV_PATH = resolve(process.cwd(), ".env");
const isSameFile = existsSync(CWD_ENV_PATH) && existsSync(PAPERCLIP_ENV_FILE_PATH)
  ? realpathSync(CWD_ENV_PATH) === realpathSync(PAPERCLIP_ENV_FILE_PATH)
  : CWD_ENV_PATH === PAPERCLIP_ENV_FILE_PATH;
if (!isSameFile && existsSync(CWD_ENV_PATH)) {
  loadDotenv({ path: CWD_ENV_PATH, override: false, quiet: true });
}

maybeRepairLegacyWorktreeConfigAndEnvFiles();

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type DatabaseMode = "embedded-postgres" | "postgres";

export interface Config {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bind: BindMode;
  customBindHost: string | undefined;
  host: string;
  port: number;
  allowedHostnames: string[];
  authBaseUrlMode: AuthBaseUrlMode;
  authPublicBaseUrl: string | undefined;
  authDisableSignUp: boolean;
  databaseMode: DatabaseMode;
  databaseUrl: string | undefined;
  databaseMigrationUrl: string | undefined;
  embeddedPostgresDataDir: string;
  embeddedPostgresPort: number;
  databaseBackupEnabled: boolean;
  databaseBackupIntervalMinutes: number;
  databaseBackupRetentionDays: number;
  databaseBackupDir: string;
  serveUi: boolean;
  uiDevMiddleware: boolean;
  secretsProvider: SecretProvider;
  secretsStrictMode: boolean;
  secretsMasterKeyFilePath: string;
  storageProvider: StorageProvider;
  storageLocalDiskBaseDir: string;
  storageS3Bucket: string;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  storageS3Prefix: string;
  storageS3ForcePathStyle: boolean;
  feedbackExportBackendUrl: string | undefined;
  feedbackExportBackendToken: string | undefined;
  heartbeatSchedulerEnabled: boolean;
  heartbeatSchedulerIntervalMs: number;
  agentLivenessWatchdogEnabled: boolean;
  agentLivenessWatchdogIntervalMs: number;
  agentLivenessThresholdMultiplier: number;
  companyDeletionEnabled: boolean;
  telemetryEnabled: boolean;
  slackSigningSecret: string | undefined;
  systemPauseAutoEnabled: boolean;
  systemPauseCheckIntervalMs: number;
  systemPauseThresholdPct: number;
  maxGlobalConcurrentRuns: number;
  // RK9-194: outreach send scheduler. Off by default — this promotes
  // `approved` messages to `queued` for the rk9-prod sender daemon to pick
  // up, so it must stay off on any instance that isn't meant to run the
  // pilot (see docs/implementation-notes/outreach-sender.md).
  outreachSenderEnabled: boolean;
  outreachSenderIntervalMs: number;
  /** Shared bearer secret for the rk9-prod daemon's machine API. Unset = that API 401s on every call. */
  outreachSenderApiKey: string | undefined;
  /** Public origin serving `GET/POST /u/:token`, used in the List-Unsubscribe header. */
  outreachUnsubscribeBaseUrl: string;
  /** RK9-195: shared HMAC secret for the rk9-prod inbound relay. Unset = `/api/outreach/inbound` 401s on every call. */
  outreachInboundHmacSecret: string | undefined;
  /**
   * RK9-195: lower-cased domains the inbound relay treats as "ours" — used by
   * BOTH the `unsub@<domain>` classifier (fail-closed: empty = the `unsub@`
   * mailto fallback never fires, rather than matching `unsub@` on any domain
   * a forged header names) AND the mail-loop guard (fail-OPEN to a weaker
   * `To`-only proxy when empty — see `isSelfLoop` in inbound-classify.ts).
   * Must list every domain/subdomain outreach mail can legitimately be sent
   * from, or the loop guard misses a genuine loop on an unlisted own domain.
   */
  outreachInboundOwnDomains: string[];
  /** RK9-197: shared bearer secret for `/metrics` and `/api/outreach/digest`. Unset = both 401 on every call. */
  outreachMetricsApiKey: string | undefined;
  /**
   * RK9-197: auto-pause safety check. Defaults ON — unlike
   * `outreachSenderEnabled` (which defaults OFF to avoid an accidental real
   * send), this only reads and, if a rule trips, writes a pause row; running
   * it even when sending itself is off is harmless and keeps the gauges/pause
   * history meaningful once sending is turned on.
   */
  outreachAutoPauseEnabled: boolean;
  outreachAutoPauseIntervalMs: number;
  /** RK9-197: same default-ON reasoning as auto-pause — a daily DNS lookup is harmless with sending off. */
  outreachDnsblEnabled: boolean;
  /** The outreach sending IP (rk9-prod's outbound address) to check for real DNSBL listings. Unset skips the reputation check but the canary self-test still runs. */
  outreachDnsblCheckIp: string | undefined;
  outreachDnsblLists: string[];
}

// Detecting the tailnet address shells out to `tailscale ip -4`, which blocks for up to
// TAILSCALE_DETECT_TIMEOUT_MS if the tailscaled localapi socket is unreachable (e.g. locked
// down by RK9-179). Memoize for the process lifetime so repeated loadConfig() calls (every
// request via getStorageService()) don't re-run the process once the bind mode is known.
let tailnetBindHostCache: { value: string | undefined } | undefined;

function detectTailnetBindHost(): string | undefined {
  if (tailnetBindHostCache) return tailnetBindHostCache.value;

  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  let value: string | undefined;
  if (explicit) {
    value = explicit;
  } else {
    try {
      const stdout = execFileSync("tailscale", ["ip", "-4"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: TAILSCALE_DETECT_TIMEOUT_MS,
      });
      value = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    } catch {
      value = undefined;
    }
  }

  tailnetBindHostCache = { value };
  return value;
}

export function loadConfig(): Config {
  const fileConfig = readConfigFile();
  const fileDatabaseMode =
    (fileConfig?.database.mode === "postgres" ? "postgres" : "embedded-postgres") as DatabaseMode;

  const fileDbUrl =
    fileDatabaseMode === "postgres"
      ? fileConfig?.database.connectionString
      : undefined;
  const fileDatabaseBackup = fileConfig?.database.backup;
  const fileSecrets = fileConfig?.secrets;
  const fileStorage = fileConfig?.storage;
  const strictModeFromEnv = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
  const secretsStrictMode =
    strictModeFromEnv !== undefined
      ? strictModeFromEnv === "true"
      : (fileSecrets?.strictMode ?? false);

  const providerFromEnvRaw = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const providerFromEnv =
    providerFromEnvRaw && SECRET_PROVIDERS.includes(providerFromEnvRaw as SecretProvider)
      ? (providerFromEnvRaw as SecretProvider)
      : null;
  const providerFromFile = fileSecrets?.provider;
  const secretsProvider: SecretProvider = providerFromEnv ?? providerFromFile ?? "local_encrypted";

  const storageProviderFromEnvRaw = process.env.PAPERCLIP_STORAGE_PROVIDER;
  const storageProviderFromEnv =
    storageProviderFromEnvRaw && STORAGE_PROVIDERS.includes(storageProviderFromEnvRaw as StorageProvider)
      ? (storageProviderFromEnvRaw as StorageProvider)
      : null;
  const storageProvider: StorageProvider = storageProviderFromEnv ?? fileStorage?.provider ?? "local_disk";
  const storageLocalDiskBaseDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
      fileStorage?.localDisk?.baseDir ??
      resolveDefaultStorageDir(),
  );
  const storageS3Bucket = process.env.PAPERCLIP_STORAGE_S3_BUCKET ?? fileStorage?.s3?.bucket ?? "paperclip";
  const storageS3Region = process.env.PAPERCLIP_STORAGE_S3_REGION ?? fileStorage?.s3?.region ?? "us-east-1";
  const storageS3Endpoint = process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ?? fileStorage?.s3?.endpoint ?? undefined;
  const storageS3Prefix = process.env.PAPERCLIP_STORAGE_S3_PREFIX ?? fileStorage?.s3?.prefix ?? "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE !== undefined
      ? process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE === "true"
      : (fileStorage?.s3?.forcePathStyle ?? false);
  const feedbackExportBackendUrl =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_URL?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_URL?.trim() ||
    undefined;
  const feedbackExportBackendToken =
    process.env.PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN?.trim() ||
    process.env.PAPERCLIP_TELEMETRY_BACKEND_TOKEN?.trim() ||
    undefined;

  const deploymentModeFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const deploymentModeFromEnv =
    deploymentModeFromEnvRaw && DEPLOYMENT_MODES.includes(deploymentModeFromEnvRaw as DeploymentMode)
      ? (deploymentModeFromEnvRaw as DeploymentMode)
      : null;
  const deploymentMode: DeploymentMode = deploymentModeFromEnv ?? fileConfig?.server.deploymentMode ?? "local_trusted";
  const deploymentExposureFromEnvRaw = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const deploymentExposureFromEnv =
    deploymentExposureFromEnvRaw &&
    DEPLOYMENT_EXPOSURES.includes(deploymentExposureFromEnvRaw as DeploymentExposure)
      ? (deploymentExposureFromEnvRaw as DeploymentExposure)
      : null;
  const deploymentExposure: DeploymentExposure =
    deploymentMode === "local_trusted"
      ? "private"
      : (deploymentExposureFromEnv ?? fileConfig?.server.exposure ?? "private");
  const bindFromEnvRaw = process.env.PAPERCLIP_BIND;
  const bindFromEnv =
    bindFromEnvRaw && BIND_MODES.includes(bindFromEnvRaw as BindMode)
      ? (bindFromEnvRaw as BindMode)
      : null;
  const configuredHost = process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1";
  const explicitBind = bindFromEnv ?? fileConfig?.server.bind ?? null;
  // Only the "tailnet" bind mode (explicit, or inferred because the configured host isn't
  // loopback/lan) ever consults the detected tailnet address — see resolveRuntimeBind and
  // inferBindModeFromHost. Skip the tailscale process entirely otherwise (lan/loopback/custom).
  const needsTailnetBindHost =
    explicitBind === "tailnet" ||
    (explicitBind === null && !isLoopbackHost(configuredHost) && !isAllInterfacesHost(configuredHost));
  const tailnetBindHost = needsTailnetBindHost ? detectTailnetBindHost() : undefined;
  const bind = explicitBind ?? inferBindModeFromHost(configuredHost, { tailnetBindHost });
  const customBindHost = process.env.PAPERCLIP_BIND_HOST ?? fileConfig?.server.customBindHost;
  const authBaseUrlModeFromEnvRaw = process.env.PAPERCLIP_AUTH_BASE_URL_MODE;
  const authBaseUrlModeFromEnv =
    authBaseUrlModeFromEnvRaw &&
    AUTH_BASE_URL_MODES.includes(authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      ? (authBaseUrlModeFromEnvRaw as AuthBaseUrlMode)
      : null;
  const publicUrlFromEnv = process.env.PAPERCLIP_PUBLIC_URL;
  const authPublicBaseUrlRaw =
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    publicUrlFromEnv ??
    fileConfig?.auth?.publicBaseUrl;
  const authPublicBaseUrl = authPublicBaseUrlRaw?.trim() || undefined;
  const authBaseUrlMode: AuthBaseUrlMode =
    authBaseUrlModeFromEnv ??
    fileConfig?.auth?.baseUrlMode ??
    (authPublicBaseUrl ? "explicit" : "auto");
  const disableSignUpFromEnv = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
  const authDisableSignUp: boolean =
    disableSignUpFromEnv !== undefined
      ? disableSignUpFromEnv === "true"
      : (fileConfig?.auth?.disableSignUp ?? false);
  const allowedHostnamesFromEnvRaw = process.env.PAPERCLIP_ALLOWED_HOSTNAMES;
  const allowedHostnamesFromEnv = allowedHostnamesFromEnvRaw
    ? allowedHostnamesFromEnvRaw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
    : null;
  const publicUrlHostname = authPublicBaseUrl
    ? (() => {
      try {
        return new URL(authPublicBaseUrl).hostname.trim().toLowerCase();
      } catch {
        return null;
      }
    })()
    : null;
  const allowedHostnames = Array.from(
    new Set(
      [
        ...(allowedHostnamesFromEnv ?? fileConfig?.server.allowedHostnames ?? []),
        ...(publicUrlHostname ? [publicUrlHostname] : []),
      ]
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const companyDeletionEnvRaw = process.env.PAPERCLIP_ENABLE_COMPANY_DELETION;
  const companyDeletionEnabled =
    companyDeletionEnvRaw !== undefined
      ? companyDeletionEnvRaw === "true"
      : deploymentMode === "local_trusted";
  const databaseBackupEnabled =
    process.env.PAPERCLIP_DB_BACKUP_ENABLED !== undefined
      ? process.env.PAPERCLIP_DB_BACKUP_ENABLED === "true"
      : (fileDatabaseBackup?.enabled ?? true);
  const databaseBackupIntervalMinutes = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES) ||
      fileDatabaseBackup?.intervalMinutes ||
      60,
  );
  const databaseBackupRetentionDays = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS) ||
      fileDatabaseBackup?.retentionDays ||
      7,
  );
  const databaseBackupDir = resolveHomeAwarePath(
    process.env.PAPERCLIP_DB_BACKUP_DIR ??
      fileDatabaseBackup?.dir ??
      resolveDefaultBackupDir(),
  );
  const bindValidationErrors = validateConfiguredBindMode({
    deploymentMode,
    deploymentExposure,
    bind,
    host: configuredHost,
    customBindHost,
  });
  if (bindValidationErrors.length > 0) {
    throw new Error(bindValidationErrors[0]);
  }
  const resolvedBind = resolveRuntimeBind({
    bind,
    host: configuredHost,
    customBindHost,
    tailnetBindHost,
  });
  if (resolvedBind.errors.length > 0) {
    throw new Error(resolvedBind.errors[0]);
  }

  return {
    deploymentMode,
    deploymentExposure,
    bind: resolvedBind.bind,
    customBindHost: resolvedBind.customBindHost,
    host: resolvedBind.host,
    port: Number(process.env.PORT) || fileConfig?.server.port || 3100,
    allowedHostnames,
    authBaseUrlMode,
    authPublicBaseUrl,
    authDisableSignUp,
    databaseMode: fileDatabaseMode,
    databaseUrl: process.env.DATABASE_URL ?? fileDbUrl,
    databaseMigrationUrl: process.env.DATABASE_MIGRATION_URL,
    embeddedPostgresDataDir: resolveHomeAwarePath(
      fileConfig?.database.embeddedPostgresDataDir ?? resolveDefaultEmbeddedPostgresDir(),
    ),
    embeddedPostgresPort: fileConfig?.database.embeddedPostgresPort ?? 54329,
    databaseBackupEnabled,
    databaseBackupIntervalMinutes,
    databaseBackupRetentionDays,
    databaseBackupDir,
    serveUi:
      process.env.SERVE_UI !== undefined
        ? process.env.SERVE_UI === "true"
        : fileConfig?.server.serveUi ?? true,
    uiDevMiddleware: process.env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true",
    secretsProvider,
    secretsStrictMode,
    secretsMasterKeyFilePath:
      resolveHomeAwarePath(
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
          fileSecrets?.localEncrypted.keyFilePath ??
          resolveDefaultSecretsKeyFilePath(),
      ),
    storageProvider,
    storageLocalDiskBaseDir,
    storageS3Bucket,
    storageS3Region,
    storageS3Endpoint,
    storageS3Prefix,
    storageS3ForcePathStyle,
    feedbackExportBackendUrl,
    feedbackExportBackendToken,
    heartbeatSchedulerEnabled: process.env.HEARTBEAT_SCHEDULER_ENABLED !== "false",
    heartbeatSchedulerIntervalMs: Math.max(10000, Number(process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS) || 30000),
    agentLivenessWatchdogEnabled: process.env.AGENT_LIVENESS_WATCHDOG_ENABLED !== "false",
    agentLivenessWatchdogIntervalMs: Math.max(60_000, Number(process.env.AGENT_LIVENESS_WATCHDOG_INTERVAL_MS) || 5 * 60_000),
    agentLivenessThresholdMultiplier: Math.max(2, Number(process.env.AGENT_LIVENESS_THRESHOLD_MULTIPLIER) || 3),
    companyDeletionEnabled,
    telemetryEnabled: fileConfig?.telemetry?.enabled ?? true,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET?.trim() || undefined,
    systemPauseAutoEnabled: process.env.SYSTEM_PAUSE_AUTO_ENABLED !== "false",
    systemPauseCheckIntervalMs: Math.max(60000, Number(process.env.SYSTEM_PAUSE_CHECK_INTERVAL_MS) || 300_000),
    systemPauseThresholdPct: Math.min(100, Math.max(50, Number(process.env.SYSTEM_PAUSE_THRESHOLD_PCT) || 90)),
    maxGlobalConcurrentRuns: Math.min(100, Math.max(1, Number(process.env.PAPERCLIP_MAX_GLOBAL_CONCURRENT_RUNS) || 5)),
    outreachSenderEnabled: process.env.OUTREACH_SENDER_ENABLED === "true",
    outreachSenderIntervalMs: Math.max(10_000, Number(process.env.OUTREACH_SENDER_INTERVAL_MS) || 60_000),
    outreachSenderApiKey: process.env.OUTREACH_SENDER_API_KEY?.trim() || undefined,
    outreachUnsubscribeBaseUrl:
      process.env.OUTREACH_UNSUBSCRIBE_BASE_URL?.trim() || "https://paperclip.rk9.fi",
    outreachInboundHmacSecret: process.env.OUTREACH_INBOUND_HMAC_SECRET?.trim() || undefined,
    outreachInboundOwnDomains: (process.env.OUTREACH_INBOUND_OWN_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    outreachMetricsApiKey: process.env.OUTREACH_METRICS_API_KEY?.trim() || undefined,
    outreachAutoPauseEnabled: process.env.OUTREACH_AUTO_PAUSE_ENABLED !== "false",
    outreachAutoPauseIntervalMs: Math.max(10_000, Number(process.env.OUTREACH_AUTO_PAUSE_INTERVAL_MS) || 60_000),
    outreachDnsblEnabled: process.env.OUTREACH_DNSBL_ENABLED !== "false",
    outreachDnsblCheckIp: process.env.OUTREACH_DNSBL_CHECK_IP?.trim() || undefined,
    outreachDnsblLists: (process.env.OUTREACH_DNSBL_LISTS ?? "zen.spamhaus.org,bl.spamcop.net,b.barracudacentral.org")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
  };
}
