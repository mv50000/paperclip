/**
 * Meta Marketing API methods on top of `MetaGraphClient` (RK9-508).
 *
 * Media goes to Meta by URL (G4): a video with `advideos file_url`, an image
 * as base64 `bytes` that the brand repo already prepared. Nothing here
 * downloads or hashes media.
 */

import { normaliseAdAccountId } from "../config.js";
import { InvalidParamError, MediaProcessingError, MediaTimeoutError, MetaResponseError } from "./errors.js";
import type { MetaGraphClient } from "./graph.js";
import { redactText } from "./redact.js";
import {
  AD_ACCOUNT_STATUS_BY_CODE,
  isDryRun,
  type AccountSummary,
  type Ad,
  type AdSet,
  type Campaign,
  type InsightsLevel,
  type InsightsRow,
  type StatusRow,
  type VideoStatus,
  type VideoThumbnail,
  type WritableStatus,
  type WriteResult,
} from "./types.js";

const ID_RE = /^\d+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const STATUS_FIELDS = "id,name,status,effective_status";
const LIST_LIMIT = "100";

/** `act_<digits>` from either form. Throws InvalidParamError on anything else. */
export function adAccountPath(actId: string): string {
  const id = normaliseAdAccountId(actId);
  if (!id) throw new InvalidParamError("Ad account id must be digits, optionally with the act_ prefix");
  return `act_${id}`;
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new InvalidParamError(`${field} must be a numeric Graph id`);
  return value;
}

/**
 * Parses a Graph money string (minor units, e.g. "12345" = 123.45 EUR) with
 * integer math only. Graph sends strings; an integer number is accepted too.
 */
export function parseMinorUnits(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new MetaResponseError(`Graph field ${field} is not a non-negative integer in minor units`);
}

/** `spend_cap` "0", empty or absent means no cap. */
export function parseSpendCap(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const cents = parseMinorUnits(value, "spend_cap");
  return cents === 0 ? null : cents;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MetaResponseError(`Graph field ${field} is missing`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface RawAccount {
  currency?: unknown;
  timezone_name?: unknown;
  spend_cap?: unknown;
  amount_spent?: unknown;
  account_status?: unknown;
}

export async function getAccountSummary(client: MetaGraphClient, actId: string): Promise<AccountSummary> {
  const path = adAccountPath(actId);
  const raw = await client.get<RawAccount>(path, {
    fields: "currency,timezone_name,spend_cap,amount_spent,account_status",
  });
  const statusCode = typeof raw.account_status === "number" ? raw.account_status : null;
  return {
    accountId: path.slice("act_".length),
    currency: requireString(raw.currency, "currency"),
    timezone: requireString(raw.timezone_name, "timezone_name"),
    spendCapCents: parseSpendCap(raw.spend_cap),
    amountSpentCents: raw.amount_spent === undefined ? 0 : parseMinorUnits(raw.amount_spent, "amount_spent"),
    status: (statusCode !== null ? AD_ACCOUNT_STATUS_BY_CODE[statusCode] : undefined) ?? "UNKNOWN",
    statusCode,
  };
}

interface RawStatusRow {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  effective_status?: unknown;
  campaign_id?: unknown;
  adset_id?: unknown;
  creative?: { id?: unknown } | null;
}

function toStatusRow(raw: RawStatusRow): StatusRow {
  return {
    id: requireString(raw.id, "id"),
    name: typeof raw.name === "string" ? raw.name : "",
    status: requireString(raw.status, "status"),
    effectiveStatus: requireString(raw.effective_status, "effective_status"),
  };
}

export interface ListOptions {
  maxPages?: number;
  /** Graph `effective_status` filter, e.g. ["ACTIVE", "PAUSED"]. */
  effectiveStatus?: string[];
}

function listParams(fields: string, options: ListOptions) {
  return {
    fields,
    limit: LIST_LIMIT,
    ...(options.effectiveStatus ? { effective_status: options.effectiveStatus } : {}),
  };
}

export async function listCampaigns(client: MetaGraphClient, actId: string, options: ListOptions = {}): Promise<Campaign[]> {
  const page = await client.paginate<RawStatusRow>(`${adAccountPath(actId)}/campaigns`, listParams(STATUS_FIELDS, options), options);
  return page.data.map(toStatusRow);
}

export async function listAdSets(client: MetaGraphClient, actId: string, options: ListOptions = {}): Promise<AdSet[]> {
  const page = await client.paginate<RawStatusRow>(
    `${adAccountPath(actId)}/adsets`,
    listParams(`${STATUS_FIELDS},campaign_id`, options),
    options,
  );
  return page.data.map((raw) => ({ ...toStatusRow(raw), campaignId: optionalString(raw.campaign_id) }));
}

export async function listAds(client: MetaGraphClient, actId: string, options: ListOptions = {}): Promise<Ad[]> {
  const page = await client.paginate<RawStatusRow>(
    `${adAccountPath(actId)}/ads`,
    listParams(`${STATUS_FIELDS},adset_id,campaign_id,creative{id}`, options),
    options,
  );
  return page.data.map((raw) => ({
    ...toStatusRow(raw),
    adsetId: optionalString(raw.adset_id),
    campaignId: optionalString(raw.campaign_id),
    creativeId: optionalString(raw.creative?.id),
  }));
}

/** Status of one campaign, ad set or ad. */
export async function getObjectStatus(client: MetaGraphClient, objectId: string): Promise<StatusRow> {
  return toStatusRow(await client.get<RawStatusRow>(requireId(objectId, "objectId"), { fields: STATUS_FIELDS }));
}

/** Sets a campaign, ad set or ad ACTIVE or PAUSED. Passes the write guard like every write. */
export async function setObjectStatus(
  client: MetaGraphClient,
  objectId: string,
  status: WritableStatus,
): Promise<WriteResult<{ success: boolean }>> {
  if (status !== "ACTIVE" && status !== "PAUSED") throw new InvalidParamError("status must be ACTIVE or PAUSED");
  const result = await client.post<{ success?: unknown }>(requireId(objectId, "objectId"), { status });
  if (isDryRun(result)) return result;
  return { success: result.success === true };
}

export interface InsightsOptions {
  level: InsightsLevel;
  fields: string[];
  /** Graph date_preset, e.g. "yesterday". Give this or timeRange. */
  datePreset?: string;
  /** Inclusive YYYY-MM-DD range in the ad account time zone. */
  timeRange?: { since: string; until: string };
  /** 1 for daily rows. */
  timeIncrement?: number | "monthly" | "all_days";
  breakdowns?: string[];
  maxPages?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Insights for an ad account (`act_<id>`) or a campaign, ad set or ad id. */
export async function getInsights(
  client: MetaGraphClient,
  objectId: string,
  options: InsightsOptions,
): Promise<InsightsRow[]> {
  const node = objectId.startsWith("act_") ? adAccountPath(objectId) : requireId(objectId, "objectId");
  if ((options.datePreset === undefined) === (options.timeRange === undefined)) {
    throw new InvalidParamError("getInsights needs exactly one of datePreset and timeRange");
  }
  if (options.timeRange && !(DATE_RE.test(options.timeRange.since) && DATE_RE.test(options.timeRange.until))) {
    throw new InvalidParamError("timeRange since/until must be YYYY-MM-DD");
  }
  if (options.fields.length === 0) throw new InvalidParamError("getInsights needs at least one field");
  const page = await client.paginate<InsightsRow>(
    `${node}/insights`,
    {
      level: options.level,
      fields: options.fields.join(","),
      date_preset: options.datePreset,
      time_range: options.timeRange,
      time_increment: options.timeIncrement,
      breakdowns: options.breakdowns?.join(","),
      limit: LIST_LIMIT,
    },
    { maxPages: options.maxPages },
  );
  return page.data;
}

function requireHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidParamError(`${field} must be an absolute https URL`);
  }
  if (url.protocol !== "https:") throw new InvalidParamError(`${field} must be an absolute https URL`);
  return url.toString();
}

/** Starts a video upload from a public URL. Meta fetches the file itself (G4). */
export async function uploadVideoByUrl(
  client: MetaGraphClient,
  actId: string,
  input: { fileUrl: string; name?: string },
): Promise<WriteResult<{ videoId: string }>> {
  const result = await client.post<{ id?: unknown }>(`${adAccountPath(actId)}/advideos`, {
    file_url: requireHttpsUrl(input.fileUrl, "fileUrl"),
    name: input.name,
  });
  if (isDryRun(result)) return result;
  return { videoId: requireString(result.id, "id") };
}

interface RawVideoStatus {
  status?: {
    video_status?: unknown;
    processing_phase?: { status?: unknown; errors?: Array<{ message?: unknown }> } | null;
  } | null;
}

export interface WaitForVideoOptions {
  /** Pause between polls. Default 5 s. */
  intervalMs?: number;
  /** Total wait before MediaTimeoutError. Default 10 min. */
  timeoutMs?: number;
}

/**
 * Polls `status.video_status` with short GETs (each one well inside the
 * host's 30 s call limit) until the video is ready. `error` throws
 * MediaProcessingError, running out of time throws MediaTimeoutError.
 */
export async function waitForVideoReady(
  client: MetaGraphClient,
  videoId: string,
  options: WaitForVideoOptions = {},
): Promise<{ videoId: string; status: "ready" }> {
  requireId(videoId, "videoId");
  const intervalMs = Math.max(0, options.intervalMs ?? 5_000);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 600_000);
  const started = client.now();
  let last: VideoStatus | null = null;

  for (;;) {
    const raw = await client.get<RawVideoStatus>(videoId, { fields: "status" });
    last = optionalString(raw.status?.video_status);
    if (last === "ready") return { videoId, status: "ready" };
    if (last === "error") {
      const reason = optionalString(raw.status?.processing_phase?.errors?.[0]?.message) ?? "Meta reported video_status=error";
      throw new MediaProcessingError(videoId, redactText(`Video ${videoId} failed processing: ${reason}`));
    }
    const elapsed = client.now() - started;
    if (elapsed >= timeoutMs) throw new MediaTimeoutError(videoId, timeoutMs, last);
    await client.sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

/**
 * Uploads an image the caller already has as base64 (the `bytes` field) and
 * returns its image_hash. The plugin itself never downloads image bytes (G4).
 */
export async function uploadImageBytes(
  client: MetaGraphClient,
  actId: string,
  input: { bytesBase64: string; name?: string },
): Promise<WriteResult<{ imageHash: string; url: string | null }>> {
  const bytes = input.bytesBase64.replace(/\s+/g, "");
  if (bytes.length === 0 || bytes.length % 4 !== 0 || !BASE64_RE.test(bytes)) {
    throw new InvalidParamError("bytesBase64 must be standard base64");
  }
  const result = await client.post<{ images?: Record<string, { hash?: unknown; url?: unknown }> }>(
    `${adAccountPath(actId)}/adimages`,
    { bytes, name: input.name },
  );
  if (isDryRun(result)) return result;
  const first = Object.values(result.images ?? {})[0];
  return { imageHash: requireString(first?.hash, "images.*.hash"), url: optionalString(first?.url) };
}

export async function getVideoThumbnails(client: MetaGraphClient, videoId: string): Promise<VideoThumbnail[]> {
  const page = await client.paginate<{ id?: unknown; uri?: unknown; is_preferred?: unknown; width?: unknown; height?: unknown }>(
    `${requireId(videoId, "videoId")}/thumbnails`,
    { fields: "id,uri,is_preferred,width,height" },
  );
  return page.data.map((raw) => ({
    id: requireString(raw.id, "id"),
    uri: requireString(raw.uri, "uri"),
    isPreferred: raw.is_preferred === true,
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
  }));
}

/**
 * Creates an ad creative. `spec` is the Graph body (`name`, `object_story_spec`,
 * `degrees_of_freedom_spec` ...); objects are sent as JSON strings.
 */
export async function createAdCreative(
  client: MetaGraphClient,
  actId: string,
  spec: { name: string } & Record<string, unknown>,
): Promise<WriteResult<{ creativeId: string }>> {
  if (!spec.name) throw new InvalidParamError("creative name is required");
  const result = await client.post<{ id?: unknown }>(`${adAccountPath(actId)}/adcreatives`, spec);
  if (isDryRun(result)) return result;
  return { creativeId: requireString(result.id, "id") };
}

/** Creates an ad, PAUSED unless the caller says otherwise. Activation belongs to the gate (G1). */
export async function createAd(
  client: MetaGraphClient,
  actId: string,
  input: { name: string; adsetId: string; creativeId: string; status?: WritableStatus; extra?: Record<string, unknown> },
): Promise<WriteResult<{ adId: string }>> {
  if (!input.name) throw new InvalidParamError("ad name is required");
  const status = input.status ?? "PAUSED";
  if (status !== "ACTIVE" && status !== "PAUSED") throw new InvalidParamError("status must be ACTIVE or PAUSED");
  const result = await client.post<{ id?: unknown }>(`${adAccountPath(actId)}/ads`, {
    ...input.extra,
    name: input.name,
    adset_id: requireId(input.adsetId, "adsetId"),
    creative: { creative_id: requireId(input.creativeId, "creativeId") },
    status,
  });
  if (isDryRun(result)) return result;
  return { adId: requireString(result.id, "id") };
}
