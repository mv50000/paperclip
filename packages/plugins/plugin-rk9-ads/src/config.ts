/**
 * Per-company brand configuration (G11: the whole BrandConfig lives in this one file).
 *
 * Paperclip stores plugin config per company (`plugin_config`), so one company
 * config is one brand. There is no enable switch: an absent or empty config
 * means the plugin is off for that company, and a valid config means it is on.
 * An invalid config is reported and treated as off.
 *
 * `BRAND_CONFIG_JSON_SCHEMA` drives the host settings form and the host-side
 * Ajv check on save. `parseBrandConfig()` is the authority at runtime: it applies
 * defaults and the cross-field rules that JSON Schema cannot express.
 */

import { DEFAULT_TIME_ZONE, isValidHhMm } from "./kit/local-time.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The host's shared secret reference shape. Bare UUID strings fail closed. */
export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
}

export const SPECIAL_AD_CATEGORIES = [
  "NONE",
  "EMPLOYMENT",
  "HOUSING",
  "CREDIT",
  "FINANCIAL_PRODUCTS_SERVICES",
  "ISSUES_ELECTIONS_POLITICS",
  "ONLINE_GAMBLING_AND_GAMING",
] as const;
export type SpecialAdCategory = (typeof SPECIAL_AD_CATEGORIES)[number];

export const TELEGRAM_MODES = ["poll", "webhook"] as const;
export type TelegramMode = (typeof TELEGRAM_MODES)[number];

export const ZERO_SPEND_MODES = ["message", "silent"] as const;
export type ZeroSpendMode = (typeof ZERO_SPEND_MODES)[number];

/**
 * Configurable rule types. `pause_all_cap` is built in (BUILTIN_PAUSE_ALL_CAP_PCT)
 * and cannot be configured or removed. `propose_scale` exists in the schema but
 * must stay disabled (G9).
 */
export const RULE_TYPES = ["threshold_pause", "pause_valid_until", "pause_fatigued", "propose_scale"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_MODES = ["shadow", "live"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const RULE_METRICS = ["cpc", "ctr", "cpm", "frequency", "spend"] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const BUILTIN_PAUSE_ALL_CAP_PCT = 90;
export const MAX_SCALE_INCREASE_PCT = 20;

export interface RuleConfig {
  ruleId: string;
  type: RuleType;
  enabled: boolean;
  mode: RuleMode;
  metric?: RuleMetric;
  operator?: RuleOperator;
  threshold?: number;
  minImpressions: number;
  minClicks: number;
  cooldownHours: number;
  maxIncreasePct?: number;
}

export interface BrandConfig {
  /** Upper-case brand code used in names and logs, e.g. "OLL". */
  brandCode: string;
  displayName: string;
  /** IANA zone for every local-time decision. Jobs run on UTC cron. */
  timeZone: string;
  /** Monthly spend ceiling in EUR. Must agree with the Meta account spend_cap (G2). */
  monthlyCapEur: number;
  namingPrefix: string;
  meta: {
    /** Digits only; an `act_` prefix is stripped. */
    adAccountId: string;
    pageId: string;
    igUserId?: string;
    datasetId?: string;
    accessTokenRef: SecretRef;
    specialAdCategories: SpecialAdCategory[];
    /** Existing objects to adopt instead of provisioning new ones. */
    campaignId?: string;
    adSetId?: string;
  };
  landing: {
    allowedDomains: string[];
    /** landingUrlKey -> https URL. Creatives refer to a key, never a raw URL. */
    urls: Record<string, string>;
    defaultUrlKey: string;
    /** Query string template; placeholders {brand} {campaign} {adset} {ad}. */
    utmTemplate: string;
  };
  telegram?: {
    botTokenRef: SecretRef;
    chatId: string;
    /** Telegram numeric user ids allowed to approve. Never empty. */
    allowedUserIds: string[];
    mode: TelegramMode;
    webhookSecretRef?: SecretRef;
    /** Public https URL of the plugin webhook (only in webhook mode). */
    webhookUrl?: string;
  };
  schedule: {
    scheduledPause: { enabled: boolean; at: string };
    dataGate?: {
      url: string;
      /** JSON pointer into the response body, e.g. "/forecast/0/sunHours". */
      jsonPointer: string;
      operator: RuleOperator;
      threshold: number;
    };
  };
  digest: {
    enabled: boolean;
    time: string;
    cpcWarnEur: number;
    zeroSpendMode: ZeroSpendMode;
  };
  fatigue: {
    enabled: boolean;
    minImpressions: number;
    maxFrequency: number;
    ctrDropPct: number;
    issuesEnabled: boolean;
  };
  rules: {
    /** Global switch for live rule actions. Off means every rule runs in shadow. */
    liveMode: boolean;
    list: RuleConfig[];
  };
}

export type BrandConfigParseResult =
  | { state: "absent" }
  | { state: "invalid"; errors: string[] }
  | { state: "enabled"; config: BrandConfig };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_UTM_TEMPLATE =
  "utm_source=facebook&utm_medium=paid_social&utm_campaign={campaign}&utm_content={ad}";
export const DEFAULT_SCHEDULED_PAUSE_AT = "21:30";
export const DEFAULT_DIGEST_TIME = "07:30";
export const DEFAULT_CPC_WARN_EUR = 0.5;
export const DEFAULT_FATIGUE = {
  enabled: true,
  minImpressions: 1000,
  maxFrequency: 3.5,
  ctrDropPct: 30,
  issuesEnabled: false,
} as const;
export const DEFAULT_RULE_MIN_IMPRESSIONS = 500;
export const DEFAULT_RULE_MIN_CLICKS = 10;
export const DEFAULT_RULE_COOLDOWN_HOURS = 24;

// ---------------------------------------------------------------------------
// JSON Schema (host settings form + host-side save validation)
// ---------------------------------------------------------------------------

/**
 * A secret field accepts only the host's secret_ref object. With `type: "object"`
 * the host's Ajv check rejects a raw value pasted into the form, so a token can
 * never be stored as plain config. The form still renders the secret picker,
 * because it reads `format` first.
 */
const secretRefField = (description: string) => ({
  type: "object",
  format: "secret-ref",
  description,
  required: ["type", "secretId"],
  properties: {
    type: { type: "string", const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { anyOf: [{ type: "string", const: "latest" }, { type: "integer", minimum: 1 }] },
  },
});

export const BRAND_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "RK9 Ads brand config for this company. Leave empty to keep the plugin off; a valid config turns it on.",
  properties: {
    brandCode: { type: "string", title: "Brand code", pattern: "^[A-Z0-9]{2,10}$" },
    displayName: { type: "string", title: "Display name" },
    timeZone: { type: "string", title: "Time zone", default: DEFAULT_TIME_ZONE },
    monthlyCapEur: { type: "number", title: "Monthly cap (EUR)", exclusiveMinimum: 0, maximum: 100_000 },
    namingPrefix: { type: "string", title: "Naming prefix" },
    meta: {
      type: "object",
      additionalProperties: false,
      title: "Meta",
      properties: {
        adAccountId: { type: "string", title: "Ad account id" },
        pageId: { type: "string", title: "Facebook page id" },
        igUserId: { type: "string", title: "Instagram user id" },
        datasetId: { type: "string", title: "Dataset (pixel) id" },
        accessTokenRef: secretRefField("Meta system user access token (company secret, e.g. meta.ads_access_token)"),
        specialAdCategories: {
          type: "array",
          title: "Special ad categories",
          items: { type: "string", enum: [...SPECIAL_AD_CATEGORIES] },
          default: ["NONE"],
        },
        campaignId: { type: "string", title: "Adopt existing campaign id" },
        adSetId: { type: "string", title: "Adopt existing ad set id" },
      },
    },
    landing: {
      type: "object",
      additionalProperties: false,
      title: "Landing",
      properties: {
        allowedDomains: { type: "array", title: "Allowed landing domains", items: { type: "string" } },
        urls: {
          type: "object",
          title: "Landing URLs by key",
          additionalProperties: { type: "string" },
        },
        defaultUrlKey: { type: "string", title: "Default landing URL key" },
        utmTemplate: { type: "string", title: "UTM template", default: DEFAULT_UTM_TEMPLATE },
      },
    },
    telegram: {
      type: "object",
      additionalProperties: false,
      title: "Telegram",
      properties: {
        botTokenRef: secretRefField("Telegram bot token (company secret). Dev and prod use different bots."),
        chatId: { type: "string", title: "Chat id" },
        allowedUserIds: { type: "array", title: "Allowed approver user ids", items: { type: "string" } },
        mode: { type: "string", title: "Update mode (default poll)", enum: [...TELEGRAM_MODES] },
        webhookSecretRef: secretRefField("Webhook secret token (only in webhook mode)"),
        webhookUrl: {
          type: "string",
          title: "Webhook URL (only in webhook mode)",
          description: "Public https URL of /api/plugins/<pluginId>/webhooks/telegram on this instance.",
        },
      },
    },
    schedule: {
      type: "object",
      additionalProperties: false,
      title: "Schedule",
      properties: {
        scheduledPause: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean", default: false },
            at: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", default: DEFAULT_SCHEDULED_PAUSE_AT },
          },
        },
        dataGate: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string" },
            jsonPointer: { type: "string" },
            operator: { type: "string", enum: [...RULE_OPERATORS] },
            threshold: { type: "number" },
          },
        },
      },
    },
    digest: {
      type: "object",
      additionalProperties: false,
      title: "Daily digest",
      properties: {
        enabled: { type: "boolean", default: true },
        time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", default: DEFAULT_DIGEST_TIME },
        cpcWarnEur: { type: "number", default: DEFAULT_CPC_WARN_EUR },
        zeroSpendMode: { type: "string", enum: [...ZERO_SPEND_MODES], default: "message" },
      },
    },
    fatigue: {
      type: "object",
      additionalProperties: false,
      title: "Creative fatigue",
      properties: {
        enabled: { type: "boolean", default: DEFAULT_FATIGUE.enabled },
        minImpressions: { type: "integer", default: DEFAULT_FATIGUE.minImpressions },
        maxFrequency: { type: "number", default: DEFAULT_FATIGUE.maxFrequency },
        ctrDropPct: { type: "number", default: DEFAULT_FATIGUE.ctrDropPct },
        issuesEnabled: { type: "boolean", default: DEFAULT_FATIGUE.issuesEnabled },
      },
    },
    rules: {
      type: "object",
      additionalProperties: false,
      title: "Rules",
      properties: {
        liveMode: { type: "boolean", default: false },
        list: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              ruleId: { type: "string" },
              type: { type: "string", enum: [...RULE_TYPES] },
              enabled: { type: "boolean", default: true },
              mode: { type: "string", enum: [...RULE_MODES], default: "shadow" },
              metric: { type: "string", enum: [...RULE_METRICS] },
              operator: { type: "string", enum: [...RULE_OPERATORS] },
              threshold: { type: "number" },
              minImpressions: { type: "integer", default: DEFAULT_RULE_MIN_IMPRESSIONS },
              minClicks: { type: "integer", default: DEFAULT_RULE_MIN_CLICKS },
              cooldownHours: { type: "number", minimum: 1, default: DEFAULT_RULE_COOLDOWN_HOURS },
              maxIncreasePct: { type: "number", maximum: MAX_SCALE_INCREASE_PCT },
            },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Returns the parsed https URL, or null when the value is not an https URL. */
function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function hostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowedDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value) || value.type !== "secret_ref") return false;
  if (typeof value.secretId !== "string" || !UUID_RE.test(value.secretId)) return false;
  const version = value.version;
  return (
    version === undefined ||
    version === "latest" ||
    (typeof version === "number" && Number.isInteger(version) && version > 0)
  );
}

/** Strips an `act_` prefix. Returns null unless the remainder is digits. */
export function normaliseAdAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^act_/, "");
  return DIGITS_RE.test(trimmed) ? trimmed : null;
}

class Collector {
  readonly errors: string[] = [];

  add(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  record(raw: Raw, key: string, path: string, required: boolean): Raw | undefined {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (required) this.add(`${path}.${key}`, "is required");
      return undefined;
    }
    if (!isRecord(value)) {
      this.add(`${path}.${key}`, "must be an object");
      return undefined;
    }
    return value;
  }

  string(raw: Raw, key: string, path: string, opts: { required?: boolean; pattern?: RegExp } = {}): string | undefined {
    const value = raw[key];
    if (value === undefined || value === null || value === "") {
      if (opts.required) this.add(`${path}.${key}`, "is required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.add(`${path}.${key}`, "must be a string");
      return undefined;
    }
    const trimmed = value.trim();
    if (opts.pattern && !opts.pattern.test(trimmed)) {
      this.add(`${path}.${key}`, `must match ${opts.pattern.source}`);
      return undefined;
    }
    return trimmed;
  }

  number(raw: Raw, key: string, path: string, opts: { fallback?: number; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean } = {}): number | undefined {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (opts.fallback === undefined) this.add(`${path}.${key}`, "is required");
      return opts.fallback;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.add(`${path}.${key}`, "must be a finite number");
      return undefined;
    }
    if (opts.integer && !Number.isInteger(value)) this.add(`${path}.${key}`, "must be an integer");
    if (opts.min !== undefined && (opts.exclusiveMin ? value <= opts.min : value < opts.min)) {
      this.add(`${path}.${key}`, `must be ${opts.exclusiveMin ? ">" : ">="} ${opts.min}`);
    }
    if (opts.max !== undefined && value > opts.max) this.add(`${path}.${key}`, `must be <= ${opts.max}`);
    return value;
  }

  boolean(raw: Raw, key: string, path: string, fallback: boolean): boolean {
    const value = raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
      this.add(`${path}.${key}`, "must be a boolean");
      return fallback;
    }
    return value;
  }

  enumValue<T extends string>(raw: Raw, key: string, path: string, allowed: readonly T[], fallback?: T): T | undefined {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (fallback === undefined) this.add(`${path}.${key}`, "is required");
      return fallback;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.add(`${path}.${key}`, `must be one of ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  stringArray(raw: Raw, key: string, path: string, opts: { pattern?: RegExp; fallback?: string[] } = {}): string[] {
    const value = raw[key];
    if (value === undefined || value === null) return opts.fallback ? [...opts.fallback] : [];
    if (!Array.isArray(value)) {
      this.add(`${path}.${key}`, "must be an array");
      return [];
    }
    const out: string[] = [];
    value.forEach((item, index) => {
      const itemValue = typeof item === "number" && Number.isInteger(item) ? String(item) : item;
      if (typeof itemValue !== "string" || (opts.pattern && !opts.pattern.test(itemValue.trim()))) {
        this.add(`${path}.${key}[${index}]`, opts.pattern ? `must match ${opts.pattern.source}` : "must be a string");
        return;
      }
      out.push(itemValue.trim());
    });
    return out;
  }

  secretRef(raw: Raw, key: string, path: string, required: boolean): SecretRef | undefined {
    const value = raw[key];
    if (value === undefined || value === null || value === "") {
      if (required) this.add(`${path}.${key}`, "is required");
      return undefined;
    }
    if (!isSecretRef(value)) {
      this.add(`${path}.${key}`, 'must be a secret reference { type: "secret_ref", secretId, version? }');
      return undefined;
    }
    return { type: "secret_ref", secretId: value.secretId, ...(value.version !== undefined ? { version: value.version } : {}) };
  }

  /** Rejects keys the schema does not know, so a typo cannot silently drop a setting. */
  known(raw: Raw, keys: readonly string[], path: string): void {
    for (const key of Object.keys(raw)) {
      if (!keys.includes(key)) this.add(`${path}.${key}`, "is not a known setting");
    }
  }

  hhmm(raw: Raw, key: string, path: string, fallback: string): string {
    const value = raw[key];
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string" || !isValidHhMm(value)) {
      this.add(`${path}.${key}`, "must be HH:MM (24 h)");
      return fallback;
    }
    return value;
  }
}

/** True when the raw config holds nothing: no row, null, or `{}`. */
export function isEmptyConfig(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  return isRecord(raw) && Object.keys(raw).length === 0;
}

function parseRule(c: Collector, raw: unknown, index: number, seenIds: Set<string>): RuleConfig | undefined {
  const path = `rules.list[${index}]`;
  if (!isRecord(raw)) {
    c.add(path, "must be an object");
    return undefined;
  }
  c.known(raw, ["ruleId", "type", "enabled", "mode", "metric", "operator", "threshold", "minImpressions", "minClicks", "cooldownHours", "maxIncreasePct"], path);
  const ruleId = c.string(raw, "ruleId", path, { required: true, pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/ });
  if (ruleId) {
    if (seenIds.has(ruleId)) c.add(`${path}.ruleId`, `duplicate rule id ${ruleId}`);
    seenIds.add(ruleId);
  }
  const type = c.enumValue(raw, "type", path, RULE_TYPES);
  const enabled = c.boolean(raw, "enabled", path, true);
  const mode = c.enumValue(raw, "mode", path, RULE_MODES, "shadow");
  const metric = raw.metric === undefined ? undefined : c.enumValue(raw, "metric", path, RULE_METRICS);
  const operator = raw.operator === undefined ? undefined : c.enumValue(raw, "operator", path, RULE_OPERATORS);
  const threshold = raw.threshold === undefined ? undefined : c.number(raw, "threshold", path);
  const minImpressions = c.number(raw, "minImpressions", path, { fallback: DEFAULT_RULE_MIN_IMPRESSIONS, min: 0, integer: true });
  const minClicks = c.number(raw, "minClicks", path, { fallback: DEFAULT_RULE_MIN_CLICKS, min: 0, integer: true });
  const cooldownHours = c.number(raw, "cooldownHours", path, { fallback: DEFAULT_RULE_COOLDOWN_HOURS, min: 1 });
  const maxIncreasePct = raw.maxIncreasePct === undefined
    ? undefined
    : c.number(raw, "maxIncreasePct", path, { min: 0, max: MAX_SCALE_INCREASE_PCT, exclusiveMin: true });

  if (type === "threshold_pause" && (metric === undefined || operator === undefined || threshold === undefined)) {
    c.add(path, "threshold_pause needs metric, operator and threshold");
  }
  if (type === "propose_scale" && enabled) {
    c.add(`${path}.enabled`, "propose_scale must stay disabled (budget scaling is deferred, G9)");
  }
  if (!ruleId || !type || !mode || minImpressions === undefined || minClicks === undefined || cooldownHours === undefined) {
    return undefined;
  }
  return {
    ruleId,
    type,
    enabled,
    mode,
    ...(metric !== undefined ? { metric } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    minImpressions,
    minClicks,
    cooldownHours,
    ...(maxIncreasePct !== undefined ? { maxIncreasePct } : {}),
  };
}

/**
 * Parses one company's raw plugin config. Pure and offline: it never resolves
 * secrets or calls Meta. Live checks belong to the preflight (A4).
 */
export function parseBrandConfig(raw: unknown): BrandConfigParseResult {
  if (isEmptyConfig(raw)) return { state: "absent" };
  if (!isRecord(raw)) return { state: "invalid", errors: ["config: must be an object"] };

  const c = new Collector();
  const root = "config";
  c.known(raw, ["brandCode", "displayName", "timeZone", "monthlyCapEur", "namingPrefix", "meta", "landing", "telegram", "schedule", "digest", "fatigue", "rules"], root);

  const brandCode = c.string(raw, "brandCode", root, { required: true, pattern: /^[A-Z0-9]{2,10}$/ });
  const displayName = c.string(raw, "displayName", root) ?? brandCode ?? "";
  const timeZone = c.string(raw, "timeZone", root) ?? DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) c.add(`${root}.timeZone`, `unknown time zone ${timeZone}`);
  const monthlyCapEur = c.number(raw, "monthlyCapEur", root, { min: 0, exclusiveMin: true, max: 100_000 });
  const namingPrefix = c.string(raw, "namingPrefix", root, { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/ }) ?? brandCode ?? "";

  // meta
  const metaRaw = c.record(raw, "meta", root, true) ?? {};
  c.known(metaRaw, ["adAccountId", "pageId", "igUserId", "datasetId", "accessTokenRef", "specialAdCategories", "campaignId", "adSetId"], "meta");
  const adAccountId = normaliseAdAccountId(metaRaw.adAccountId);
  if (metaRaw.adAccountId === undefined) c.add("meta.adAccountId", "is required");
  else if (adAccountId === null) c.add("meta.adAccountId", "must be numeric (an act_ prefix is allowed)");
  const pageId = c.string(metaRaw, "pageId", "meta", { required: true, pattern: DIGITS_RE });
  const igUserId = c.string(metaRaw, "igUserId", "meta", { pattern: DIGITS_RE });
  const datasetId = c.string(metaRaw, "datasetId", "meta", { pattern: DIGITS_RE });
  const accessTokenRef = c.secretRef(metaRaw, "accessTokenRef", "meta", true);
  const specialAdCategories = c.stringArray(metaRaw, "specialAdCategories", "meta", { fallback: ["NONE"] });
  for (const category of specialAdCategories) {
    if (!(SPECIAL_AD_CATEGORIES as readonly string[]).includes(category)) {
      c.add("meta.specialAdCategories", `unknown category ${category}`);
    }
  }
  if (specialAdCategories.length === 0) c.add("meta.specialAdCategories", 'must not be empty (use ["NONE"])');
  if (specialAdCategories.includes("NONE") && specialAdCategories.length > 1) {
    c.add("meta.specialAdCategories", "NONE cannot be combined with other categories");
  }
  const campaignId = c.string(metaRaw, "campaignId", "meta", { pattern: DIGITS_RE });
  const adSetId = c.string(metaRaw, "adSetId", "meta", { pattern: DIGITS_RE });

  // landing
  const landingRaw = c.record(raw, "landing", root, true) ?? {};
  c.known(landingRaw, ["allowedDomains", "urls", "defaultUrlKey", "utmTemplate"], "landing");
  const allowedDomains = c.stringArray(landingRaw, "allowedDomains", "landing").map((d) => d.toLowerCase());
  if (allowedDomains.length === 0) c.add("landing.allowedDomains", "must list at least one domain");
  allowedDomains.forEach((domain, index) => {
    if (!HOST_RE.test(domain)) c.add(`landing.allowedDomains[${index}]`, `invalid domain ${domain}`);
  });
  const urls: Record<string, string> = Object.create(null) as Record<string, string>;
  const urlsRaw = c.record(landingRaw, "urls", "landing", true) ?? {};
  for (const [key, value] of Object.entries(urlsRaw)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) {
      c.add(`landing.urls.${key}`, "key must match ^[a-z0-9][a-z0-9_-]{0,63}$");
      continue;
    }
    const url = parseHttpsUrl(value);
    if (!url) {
      c.add(`landing.urls.${key}`, "must be an https URL");
      continue;
    }
    if (!hostAllowed(url.hostname, allowedDomains)) {
      c.add(`landing.urls.${key}`, `host ${url.hostname} is not in landing.allowedDomains`);
      continue;
    }
    urls[key] = url.toString();
  }
  if (Object.keys(urlsRaw).length === 0) c.add("landing.urls", "must contain at least one URL");
  const defaultUrlKey = c.string(landingRaw, "defaultUrlKey", "landing") ?? Object.keys(urlsRaw)[0] ?? "";
  if (defaultUrlKey && !Object.hasOwn(urls, defaultUrlKey)) c.add("landing.defaultUrlKey", `no landing URL with key ${defaultUrlKey}`);
  const utmTemplate = c.string(landingRaw, "utmTemplate", "landing") ?? DEFAULT_UTM_TEMPLATE;
  if (/[?#\s]/.test(utmTemplate)) c.add("landing.utmTemplate", "must be a bare query string without ?, # or spaces");

  // telegram (optional block; when present it must be complete)
  let telegram: BrandConfig["telegram"];
  const telegramRaw = c.record(raw, "telegram", root, false);
  // The host settings form fills schema defaults into an untouched block, so a
  // block without a bot token and a chat id counts as "no Telegram".
  const telegramTouched =
    telegramRaw !== undefined &&
    Object.entries(telegramRaw).some(([key, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (key === "mode") return false;
      if (key === "allowedUserIds") return Array.isArray(value) && value.length > 0;
      return true;
    });
  if (telegramRaw && telegramTouched) {
    c.known(telegramRaw, ["botTokenRef", "chatId", "allowedUserIds", "mode", "webhookSecretRef", "webhookUrl"], "telegram");
    const botTokenRef = c.secretRef(telegramRaw, "botTokenRef", "telegram", true);
    const chatId = c.string(telegramRaw, "chatId", "telegram", { required: true, pattern: /^-?\d+$/ });
    const allowedUserIds = c.stringArray(telegramRaw, "allowedUserIds", "telegram", { pattern: /^\d+$/ });
    if (allowedUserIds.length === 0) c.add("telegram.allowedUserIds", "must list at least one approver");
    const mode = c.enumValue(telegramRaw, "mode", "telegram", TELEGRAM_MODES, "poll");
    const webhookSecretRef = c.secretRef(telegramRaw, "webhookSecretRef", "telegram", mode === "webhook");
    let webhookUrl: string | undefined;
    if (telegramRaw.webhookUrl !== undefined && telegramRaw.webhookUrl !== "") {
      const url = parseHttpsUrl(telegramRaw.webhookUrl);
      if (!url) c.add("telegram.webhookUrl", "must be an https URL");
      else webhookUrl = url.toString();
    } else if (mode === "webhook") {
      c.add("telegram.webhookUrl", "is required");
    }
    if (botTokenRef && chatId && mode) {
      telegram = {
        botTokenRef,
        chatId,
        allowedUserIds,
        mode,
        ...(webhookSecretRef ? { webhookSecretRef } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      };
    }
  }

  // schedule
  const scheduleRaw = c.record(raw, "schedule", root, false) ?? {};
  c.known(scheduleRaw, ["scheduledPause", "dataGate"], "schedule");
  const pauseRaw = c.record(scheduleRaw, "scheduledPause", "schedule", false) ?? {};
  c.known(pauseRaw, ["enabled", "at"], "schedule.scheduledPause");
  const scheduledPause = {
    enabled: c.boolean(pauseRaw, "enabled", "schedule.scheduledPause", false),
    at: c.hhmm(pauseRaw, "at", "schedule.scheduledPause", DEFAULT_SCHEDULED_PAUSE_AT),
  };
  let dataGate: BrandConfig["schedule"]["dataGate"];
  const gateRaw = c.record(scheduleRaw, "dataGate", "schedule", false);
  if (gateRaw && Object.keys(gateRaw).length > 0) {
    c.known(gateRaw, ["url", "jsonPointer", "operator", "threshold"], "schedule.dataGate");
    const url = parseHttpsUrl(gateRaw.url);
    if (!url) c.add("schedule.dataGate.url", "must be an https URL");
    const jsonPointer = c.string(gateRaw, "jsonPointer", "schedule.dataGate", { required: true, pattern: /^(\/[^/]*)+$/ });
    const operator = c.enumValue(gateRaw, "operator", "schedule.dataGate", RULE_OPERATORS);
    const threshold = c.number(gateRaw, "threshold", "schedule.dataGate");
    if (url && jsonPointer && operator && threshold !== undefined) {
      dataGate = { url: url.toString(), jsonPointer, operator, threshold };
    }
  }

  // digest
  const digestRaw = c.record(raw, "digest", root, false) ?? {};
  c.known(digestRaw, ["enabled", "time", "cpcWarnEur", "zeroSpendMode"], "digest");
  const digest = {
    enabled: c.boolean(digestRaw, "enabled", "digest", true),
    time: c.hhmm(digestRaw, "time", "digest", DEFAULT_DIGEST_TIME),
    cpcWarnEur: c.number(digestRaw, "cpcWarnEur", "digest", { fallback: DEFAULT_CPC_WARN_EUR, min: 0 }) ?? DEFAULT_CPC_WARN_EUR,
    zeroSpendMode: c.enumValue(digestRaw, "zeroSpendMode", "digest", ZERO_SPEND_MODES, "message") ?? "message",
  };

  // fatigue
  const fatigueRaw = c.record(raw, "fatigue", root, false) ?? {};
  c.known(fatigueRaw, ["enabled", "minImpressions", "maxFrequency", "ctrDropPct", "issuesEnabled"], "fatigue");
  const fatigue = {
    enabled: c.boolean(fatigueRaw, "enabled", "fatigue", DEFAULT_FATIGUE.enabled),
    minImpressions: c.number(fatigueRaw, "minImpressions", "fatigue", { fallback: DEFAULT_FATIGUE.minImpressions, min: 0, integer: true }) ?? DEFAULT_FATIGUE.minImpressions,
    maxFrequency: c.number(fatigueRaw, "maxFrequency", "fatigue", { fallback: DEFAULT_FATIGUE.maxFrequency, min: 0, exclusiveMin: true }) ?? DEFAULT_FATIGUE.maxFrequency,
    ctrDropPct: c.number(fatigueRaw, "ctrDropPct", "fatigue", { fallback: DEFAULT_FATIGUE.ctrDropPct, min: 0, max: 100 }) ?? DEFAULT_FATIGUE.ctrDropPct,
    issuesEnabled: c.boolean(fatigueRaw, "issuesEnabled", "fatigue", DEFAULT_FATIGUE.issuesEnabled),
  };

  // rules
  const rulesRaw = c.record(raw, "rules", root, false) ?? {};
  c.known(rulesRaw, ["liveMode", "list"], "rules");
  const liveMode = c.boolean(rulesRaw, "liveMode", "rules", false);
  const ruleList: RuleConfig[] = [];
  if (rulesRaw.list !== undefined) {
    if (!Array.isArray(rulesRaw.list)) {
      c.add("rules.list", "must be an array");
    } else {
      const seenIds = new Set<string>();
      rulesRaw.list.forEach((rule, index) => {
        const parsed = parseRule(c, rule, index, seenIds);
        if (parsed) ruleList.push(parsed);
      });
    }
  }

  if (c.errors.length > 0 || !brandCode || monthlyCapEur === undefined || !adAccountId || !pageId || !accessTokenRef) {
    return { state: "invalid", errors: c.errors.length > 0 ? c.errors : ["config: incomplete"] };
  }

  return {
    state: "enabled",
    config: {
      brandCode,
      displayName,
      timeZone,
      monthlyCapEur,
      namingPrefix,
      meta: {
        adAccountId,
        pageId,
        ...(igUserId ? { igUserId } : {}),
        ...(datasetId ? { datasetId } : {}),
        accessTokenRef,
        specialAdCategories: specialAdCategories as SpecialAdCategory[],
        ...(campaignId ? { campaignId } : {}),
        ...(adSetId ? { adSetId } : {}),
      },
      landing: { allowedDomains, urls, defaultUrlKey, utmTemplate },
      ...(telegram ? { telegram } : {}),
      schedule: { scheduledPause, ...(dataGate ? { dataGate } : {}) },
      digest,
      fatigue,
      rules: { liveMode, list: ruleList },
    },
  };
}

/**
 * Secret references in a parsed config, keyed by the dot path the host uses
 * for `ctx.secrets.resolve(ref, { configPath })`.
 */
export function configSecretRefs(config: BrandConfig): Array<{ configPath: string; ref: SecretRef }> {
  const refs: Array<{ configPath: string; ref: SecretRef }> = [
    { configPath: "meta.accessTokenRef", ref: config.meta.accessTokenRef },
  ];
  if (config.telegram) {
    refs.push({ configPath: "telegram.botTokenRef", ref: config.telegram.botTokenRef });
    if (config.telegram.webhookSecretRef) {
      refs.push({ configPath: "telegram.webhookSecretRef", ref: config.telegram.webhookSecretRef });
    }
  }
  return refs;
}

/**
 * Daily budget in cents (G3): floor(monthlyCapEur * 100 / days in the local month).
 * The spend guard projects with the same formula, so a provisioned budget passes
 * its own guard in a 31-day month too.
 */
export function dailyBudgetCents(monthlyCapEur: number, daysInMonth: number): number {
  if (!(monthlyCapEur > 0)) throw new Error("monthlyCapEur must be > 0");
  if (!Number.isInteger(daysInMonth) || daysInMonth < 28 || daysInMonth > 31) {
    throw new Error(`daysInMonth must be 28-31, got ${daysInMonth}`);
  }
  return Math.floor((Math.round(monthlyCapEur * 100) / daysInMonth));
}
