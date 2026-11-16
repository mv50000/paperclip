/**
 * Creative ingress (RK9-513): the one `stageCreative()` behind the agent tool
 * `rk9ads_stage_creative`, the action `stage-creative` (RK9-910) and the API
 * route `POST /creatives`.
 *
 * Steps: validate the manifest, check it against the company's brand config,
 * return an existing record on a dedupe hit (or stage an expired or rejected
 * one again), check the media with one HEAD through the host fetch, insert the
 * row (a unique constraint settles races), and for a video start the Meta
 * upload by `file_url`.
 *
 * A creative is a media resource. Its copy, cta, landingUrlKey and utmCampaign
 * are defaults that a publication may override (RK9-525, A8 RK9-514). The same
 * media with other text is therefore refused with 409 and the differing
 * fields, never silently merged into the first row.
 *
 * Media travels as an HTTPS URL (G4). The plugin never reads media bytes: the
 * HEAD gives the type and size, Meta fetches the file itself. A staged
 * creative holds at most a Meta video id; nothing it creates can spend money.
 * Activation stays with the Telegram gate (G1).
 *
 * Dry run (RK9-849): with `meta.stagingMode: "dry_run"` every check above
 * runs, but the video upload goes through a dry-run Meta client, which sends
 * nothing and returns the planned call. The row gets
 * `payload.stagingMode = "dry_run"` and the planned calls. Publication,
 * activation and live organic posts refuse such a row. Staging the same media
 * again in live mode stages it anew and clears the marker. On a dev instance
 * `meta.dryRunMediaCheck: "skip"` drops the media HEAD too (RK9-853); the
 * row then carries `payload.mediaCheck = "skipped"`.
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isStagingDryRun, skipsDryRunMediaCheck, type BrandConfig } from "../config.js";
import { loadCompanyConfig } from "../company-configs.js";
import type { Ledger, LedgerRow } from "../db.js";
import { createMetaClient, type FetchLike, type MetaGraphClient } from "../meta/graph.js";
import { uploadVideoByUrl } from "../meta/methods.js";
import { redactText } from "../meta/redact.js";
import { isDryRun } from "../meta/types.js";
import { parseCreativeManifest, type CreativeManifestV1, type ManifestIssue } from "./schema.js";
import { creativePayloadOf as payloadOf, DRY_RUN_STAGING, isDryRunCreativeRow } from "./staging-mode.js";

/** Meta's own limits: images up to 30 MB, videos fetched by file_url up to 1 GB. */
export const MAX_MEDIA_BYTES = { image: 30 * 1024 * 1024, video: 1024 * 1024 * 1024 } as const;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export type StageErrorCode =
  | "invalid_request"
  | "invalid_manifest"
  | "url_not_https"
  | "url_forbidden"
  | "valid_until_past"
  | "plugin_not_enabled"
  | "config_unavailable"
  | "unknown_brand"
  | "unknown_landing_url_key"
  | "media_unreachable"
  | "media_type_mismatch"
  | "media_too_large"
  | "idempotency_key_conflict"
  | "creative_text_conflict"
  | "creative_limit_reached"
  | "meta_upload_failed";

const STATUS_BY_CODE: Record<StageErrorCode, number> = {
  invalid_request: 400,
  invalid_manifest: 400,
  url_not_https: 400,
  url_forbidden: 400,
  valid_until_past: 400,
  plugin_not_enabled: 409,
  config_unavailable: 503,
  unknown_brand: 422,
  unknown_landing_url_key: 422,
  media_unreachable: 422,
  media_type_mismatch: 422,
  media_too_large: 422,
  idempotency_key_conflict: 409,
  creative_text_conflict: 409,
  creative_limit_reached: 429,
  meta_upload_failed: 502,
};

export interface CreativeView {
  id: string;
  brand: string;
  kind: string;
  status: string;
  sha256: string;
  idempotencyKey: string;
  aspectRatio: string | null;
  mediaUrl: string;
  posterUrl: string | null;
  landingUrlKey: string | null;
  utmCampaign: string | null;
  cta: string | null;
  validUntil: string | null;
  targetAdsetId: string | null;
  metaVideoId: string | null;
  metaImageHash: string | null;
  error: string | null;
  createdAt: string | null;
  /** `dry_run` when the creative was staged without any Meta call (RK9-849). */
  stagingMode: "live" | "dry_run";
  /** The Meta calls a dry-run staging would have sent (redacted). */
  plannedCalls?: unknown[];
  /** `skipped` when a dry-run staging sent no media HEAD (`meta.dryRunMediaCheck: skip`, RK9-853). */
  mediaCheck?: "skipped";
}

export interface StageError {
  code: StageErrorCode;
  message: string;
  /** JSON pointer into the manifest when one field is at fault. */
  path?: string;
  issues?: ManifestIssue[];
  /** For `creative_text_conflict`: the manifest fields that differ from the stored creative. */
  fields?: CreativeTextField[];
}

export type StageResponseBody =
  | { created: boolean; creative: CreativeView }
  | { error: StageError; creative?: CreativeView };

export interface StageResult {
  status: number;
  body: StageResponseBody;
}

/**
 * Who asked for the staging, as the host reported it (never from params).
 * The host writes plugin activity as the plugin, so this goes into the
 * activity metadata.
 */
export interface StageInitiator {
  source: "agent" | "board";
  agentId: string | null;
  userId: string | null;
  runId: string | null;
}

export interface StageDeps {
  ctx: PluginContext;
  ledger: Ledger;
  now?: () => Date;
  /**
   * Test seam for the live upload client; the worker uses `createMetaClient`.
   * A dry-run staging never calls it: it always builds its own dry-run client.
   */
  metaClient?: (companyId: string, config: BrandConfig) => MetaGraphClient;
}

/**
 * The payload a staging round writes: the schema version, plus the marker in
 * dry-run mode, plus `mediaCheck: "skipped"` when the dry run sent no HEAD.
 */
function stagingPayload(manifest: CreativeManifestV1, dryRun: boolean, mediaCheckSkipped = false): Record<string, unknown> {
  if (!dryRun) return { schemaVersion: manifest.schemaVersion };
  return { schemaVersion: manifest.schemaVersion, stagingMode: DRY_RUN_STAGING, ...(mediaCheckSkipped ? { mediaCheck: "skipped" } : {}) };
}

/** The row's payload with the dry-run marker set. */
function markedPayload(row: LedgerRow): Record<string, unknown> {
  return { ...payloadOf(row.payload), stagingMode: DRY_RUN_STAGING };
}

function fail(code: StageErrorCode, message: string, extra: Partial<StageError> = {}, creative?: CreativeView): StageResult {
  return { status: STATUS_BY_CODE[code], body: { error: { code, message, ...extra }, ...(creative ? { creative } : {}) } };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toCreativeView(row: LedgerRow): CreativeView {
  const payload = payloadOf(row.payload);
  const dryRun = payload.stagingMode === DRY_RUN_STAGING;
  return {
    id: String(row.id),
    brand: String(row.brand_code),
    kind: String(row.kind),
    status: String(row.status),
    sha256: String(row.sha256),
    idempotencyKey: String(row.idempotency_key),
    aspectRatio: str(row.aspect_ratio),
    mediaUrl: String(row.media_url),
    posterUrl: str(row.thumbnail_url),
    landingUrlKey: str(row.landing_url_key),
    utmCampaign: str(row.utm_campaign),
    cta: str(row.cta),
    validUntil: iso(row.valid_until),
    targetAdsetId: str(row.target_adset_id),
    metaVideoId: str(row.meta_video_id),
    metaImageHash: str(row.meta_image_hash),
    error: str(row.error),
    createdAt: iso(row.created_at),
    stagingMode: dryRun ? "dry_run" : "live",
    ...(dryRun && Array.isArray(payload.plannedCalls) ? { plannedCalls: payload.plannedCalls } : {}),
    ...(dryRun && payload.mediaCheck === "skipped" ? { mediaCheck: "skipped" as const } : {}),
  };
}

/** The idempotency-key row first, then the (brand, sha256) row. */
async function findExisting(ledger: Ledger, companyId: string, manifest: CreativeManifestV1) {
  const [byKey] = await ledger.select(companyId, "creatives", { where: { idempotency_key: manifest.idempotencyKey }, limit: 1 });
  if (byKey) return { row: byKey, matchedOn: "idempotencyKey" as const };
  const [bySha] = await ledger.select(companyId, "creatives", {
    where: { brand_code: manifest.brand, sha256: manifest.sha256 },
    limit: 1,
  });
  return bySha ? { row: bySha, matchedOn: "sha256" as const } : null;
}

/** Statuses whose creative may be staged again with a fresh manifest. */
const RESTAGEABLE_STATUSES = new Set(["expired", "rejected"]);

/** The text defaults a creative stores; a publication may override each one. */
export const CREATIVE_TEXT_FIELDS = ["copy", "cta", "landingUrlKey", "utmCampaign"] as const;
export type CreativeTextField = (typeof CREATIVE_TEXT_FIELDS)[number];

const COPY_KEYS = ["message", "title", "description"] as const;

function storedCopy(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/** The text fields of `manifest` that differ from the stored row. */
function differingTextFields(row: LedgerRow, manifest: CreativeManifestV1): CreativeTextField[] {
  const copy = storedCopy(row.ad_copy);
  const differs: Record<CreativeTextField, boolean> = {
    copy: !copy || COPY_KEYS.some((key) => (copy[key] ?? null) !== (manifest.copy[key] ?? null)),
    cta: str(row.cta) !== manifest.cta,
    landingUrlKey: str(row.landing_url_key) !== manifest.landingUrlKey,
    utmCampaign: str(row.utm_campaign) !== manifest.utmCampaign,
  };
  return CREATIVE_TEXT_FIELDS.filter((field) => differs[field]);
}

/** New creative rows one company may create in 24 hours (a cap on invented sha256 values). */
export const MAX_NEW_CREATIVES_PER_DAY = 200;

async function newCreativesToday(deps: StageDeps, companyId: string): Promise<number> {
  const rows = await deps.ctx.db.query<{ n: number | string }>(
    `SELECT count(*)::int AS n FROM ${deps.ledger.qualified("creatives")}
     WHERE company_id = $1 AND created_at > now() - interval '24 hours'`,
    [companyId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function loadRow(ledger: Ledger, companyId: string, id: string): Promise<LedgerRow> {
  const [row] = await ledger.select(companyId, "creatives", { where: { id }, limit: 1 });
  if (!row) throw new Error(`creative ${id} disappeared`);
  return row;
}

/**
 * Inserts the row unless any unique key of the table (company+brand+sha256,
 * company+idempotency_key) already exists. Returns false on a conflict. The
 * statement keeps the ledger rule: company_id is always $1.
 */
async function insertIfAbsent(deps: StageDeps, companyId: string, id: string, manifest: CreativeManifestV1, dryRun: boolean, mediaCheckSkipped: boolean): Promise<boolean> {
  const values: Array<[string, unknown]> = [
    ["company_id", companyId],
    ["id", id],
    ["brand_code", manifest.brand],
    ["sha256", manifest.sha256],
    ["idempotency_key", manifest.idempotencyKey],
    ["kind", manifest.kind],
    ["aspect_ratio", manifest.aspectRatio],
    ["media_url", manifest.mediaUrl],
    ["thumbnail_url", manifest.posterUrl ?? null],
    ["ad_copy", JSON.stringify(manifest.copy)],
    ["cta", manifest.cta],
    ["landing_url_key", manifest.landingUrlKey],
    ["utm_campaign", manifest.utmCampaign],
    ["target_adset_id", manifest.targetAdsetId ?? null],
    ["valid_until", new Date(manifest.validUntil).toISOString()],
    // An image goes to Meta by URL when the ad creative is built (G4), so it is ready now.
    ["status", manifest.kind === "image" ? "ready" : "staged"],
    ["payload", JSON.stringify(stagingPayload(manifest, dryRun, mediaCheckSkipped))],
  ];
  const result = await deps.ctx.db.execute(
    `INSERT INTO ${deps.ledger.qualified("creatives")} (${values.map(([column]) => column).join(", ")})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
     ON CONFLICT DO NOTHING`,
    values.map(([, value]) => value),
  );
  return result.rowCount === 1;
}

/**
 * Stages an expired or rejected creative again with the new manifest. The row
 * keeps its id and idempotency key (its publications point at it), and the
 * old Meta ids are cleared so a video uploads again from the new URL. The
 * expected status in the WHERE clause lets exactly one caller restage.
 * A dry-run creative staged in live mode comes here too (RK9-849): the new
 * payload drops its marker, and the video then uploads for real.
 */
async function restage(deps: StageDeps, companyId: string, row: LedgerRow, manifest: CreativeManifestV1, dryRun: boolean, mediaCheckSkipped: boolean): Promise<boolean> {
  const changed = await deps.ledger.update(
    companyId,
    "creatives",
    { id: String(row.id), status: String(row.status) },
    {
      kind: manifest.kind,
      aspect_ratio: manifest.aspectRatio,
      media_url: manifest.mediaUrl,
      thumbnail_url: manifest.posterUrl ?? null,
      ad_copy: manifest.copy,
      cta: manifest.cta,
      landing_url_key: manifest.landingUrlKey,
      utm_campaign: manifest.utmCampaign,
      target_adset_id: manifest.targetAdsetId ?? null,
      valid_until: new Date(manifest.validUntil).toISOString(),
      meta_video_id: null,
      meta_image_hash: null,
      error: null,
      status: manifest.kind === "image" ? "ready" : "staged",
      payload: stagingPayload(manifest, dryRun, mediaCheckSkipped),
    },
  );
  return changed === 1;
}

function contentType(headers: Headers): string {
  return (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * One HEAD per URL through the host fetch (its SSRF guard stays in charge).
 * The body is never read. Redirects are not followed by the host, so the URL
 * must point at the file itself.
 */
async function checkRemoteMedia(
  fetch: FetchLike,
  logger: PluginContext["logger"],
  url: string,
  expected: "image" | "video",
  pointer: string,
): Promise<StageResult | null> {
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD" });
  } catch (error) {
    // The reason stays in the server log: a connection or TLS error text would
    // tell the caller about hosts behind the URL (port open or not, certificate names).
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn("rk9-ads: creative media HEAD failed", { reason: redactText(reason).slice(0, 200) });
    return fail("media_unreachable", "HEAD request failed", { path: pointer });
  }
  if (response.status >= 300 && response.status < 400) {
    return fail("media_unreachable", `HEAD answered ${response.status}; give the final URL, redirects are not followed`, { path: pointer });
  }
  if (response.status !== 200) {
    return fail("media_unreachable", `HEAD answered ${response.status}`, { path: pointer });
  }
  const type = contentType(response.headers);
  const typeOk = expected === "video" ? type.startsWith("video/") : IMAGE_TYPES.has(type);
  if (!typeOk) {
    const want = expected === "video" ? "video/*" : "image/jpeg or image/png";
    return fail("media_type_mismatch", `content-type is "${type || "missing"}", expected ${want}`, { path: pointer });
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MEDIA_BYTES[expected]) {
    return fail("media_too_large", `content-length ${length} exceeds ${MAX_MEDIA_BYTES[expected]} bytes`, { path: pointer });
  }
  return null;
}

/** An `uploading` row with no video id this old lost its worker mid-upload. */
export const STALE_UPLOAD_MINUTES = 10;

/**
 * Claims a stale `uploading` row. `updated_at` moves to now() in the same
 * statement, so a second caller no longer matches and only one re-uploads.
 */
async function claimStaleUpload(deps: StageDeps, companyId: string, id: string, payload: Record<string, unknown> | null): Promise<boolean> {
  // A dry run passes the marked payload; a live claim keeps the stored one.
  const result = await deps.ctx.db.execute(
    `UPDATE ${deps.ledger.qualified("creatives")} SET error = NULL, updated_at = now(), payload = COALESCE($3::jsonb, payload)
     WHERE company_id = $1 AND id = $2 AND status = 'uploading' AND meta_video_id IS NULL
       AND updated_at < now() - interval '${STALE_UPLOAD_MINUTES} minutes'`,
    [companyId, id, payload === null ? null : JSON.stringify(payload)],
  );
  return result.rowCount === 1;
}

/**
 * The upload client. Dry-run staging always gets a dry-run client, never the
 * injected one: a dry-run client sends nothing and does not resolve the token.
 */
function uploadClient(deps: StageDeps, companyId: string, config: BrandConfig, dryRun: boolean): MetaGraphClient {
  if (!dryRun && deps.metaClient) return deps.metaClient(companyId, config);
  return createMetaClient(deps.ctx, {
    companyId,
    tokenRef: config.meta.accessTokenRef,
    tokenConfigPath: "meta.accessTokenRef",
    mode: dryRun ? "dryRun" : "live",
  });
}

/**
 * Starts the Meta upload of a staged, failed or stale video. A compare-and-set
 * on the status (or on the stale `updated_at`) lets exactly one caller upload.
 * In dry-run mode the planned call is stored on the row and the row stays
 * `staged` with the dry-run marker.
 */
async function uploadVideo(deps: StageDeps, companyId: string, config: BrandConfig, row: LedgerRow, dryRun: boolean): Promise<StageResult | null> {
  const id = String(row.id);
  // RK9-853: a dry run sets its marker in the claim itself, so a crash before the
  // planned-call write cannot leave an unmarked `uploading` row behind.
  const marker = dryRun ? markedPayload(row) : null;
  const claimed =
    row.status === "uploading"
      ? await claimStaleUpload(deps, companyId, id, marker)
      : (await deps.ledger.update(companyId, "creatives", { id, status: String(row.status) }, { status: "uploading", error: null, ...(marker ? { payload: marker } : {}) })) === 1;
  if (!claimed) return null;
  const client = uploadClient(deps, companyId, config, dryRun);
  try {
    const result = await uploadVideoByUrl(client, config.meta.adAccountId, {
      fileUrl: String(row.media_url),
      name: `${config.namingPrefix}-${String(row.idempotency_key)}`.slice(0, 100),
    });
    if (isDryRun(result)) {
      // Also reached by a live-mode client that answers with a plan: the row is a dry run either way.
      const payload = { ...payloadOf(row.payload), stagingMode: DRY_RUN_STAGING, plannedCalls: [result.planned] };
      await deps.ledger.update(companyId, "creatives", { id, status: "uploading" }, { status: "staged", payload });
      await deps.ctx.activity.log({
        companyId,
        message: "rk9-ads creative dry-run upload",
        entityType: "rk9ads_creative",
        entityId: id,
        metadata: { planned: `${result.planned.method} ${result.planned.path}` },
      });
      return null;
    }
    // Meta processes the video asynchronously; the publish step waits for status ready.
    await deps.ledger.update(companyId, "creatives", { id, status: "uploading" }, { meta_video_id: result.videoId });
    return null;
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
    await deps.ledger.update(companyId, "creatives", { id, status: "uploading" }, { status: "failed", error: message });
    return fail("meta_upload_failed", message, {}, toCreativeView(await loadRow(deps.ledger, companyId, id)));
  }
}

function needsUpload(row: LedgerRow): boolean {
  return (
    row.kind === "video" && !str(row.meta_video_id) && (row.status === "staged" || row.status === "failed" || row.status === "uploading")
  );
}

/**
 * Stages one creative manifest for `companyId`. The caller has already proved
 * the company: the tool takes it from the agent run, the action and the route
 * from the host's company access check. `initiator` only goes into the
 * activity metadata.
 */
export async function stageCreative(deps: StageDeps, companyId: string, input: unknown, initiator?: StageInitiator): Promise<StageResult> {
  const now = deps.now?.() ?? new Date();

  const parsed = parseCreativeManifest(input);
  if (!parsed.ok) {
    const [first] = parsed.issues;
    return fail((first?.code ?? "invalid_manifest") as StageErrorCode, first?.message ?? "invalid manifest", {
      path: first?.path,
      issues: parsed.issues,
    });
  }
  const manifest = parsed.manifest;
  if (new Date(manifest.validUntil).getTime() <= now.getTime()) {
    return fail("valid_until_past", "validUntil must be in the future", { path: "/validUntil" });
  }

  const configResult = await loadCompanyConfig(deps.ctx, companyId);
  if (configResult.state === "unavailable") return fail("config_unavailable", "the brand config could not be read; retry later");
  if (configResult.state !== "enabled") {
    return fail("plugin_not_enabled", "RK9 Ads has no valid brand config for this company");
  }
  const config = configResult.config;
  if (manifest.brand !== config.brandCode) {
    return fail("unknown_brand", `brand ${manifest.brand} is not this company's brand`, { path: "/brand" });
  }
  if (!Object.hasOwn(config.landing.urls, manifest.landingUrlKey)) {
    return fail("unknown_landing_url_key", `landing.urls has no key ${manifest.landingUrlKey}`, { path: "/landingUrlKey" });
  }

  // RK9-853: a dev instance in dry-run mode may skip the HEAD; live staging always sends it.
  const skipMediaCheck = skipsDryRunMediaCheck(config);
  const checkMedia = async (): Promise<StageResult | null> => {
    if (skipMediaCheck) return null;
    const media = await checkRemoteMedia(deps.ctx.http.fetch, deps.ctx.logger, manifest.mediaUrl, manifest.kind, "/mediaUrl");
    if (media) return media;
    if (manifest.posterUrl) {
      return checkRemoteMedia(deps.ctx.http.fetch, deps.ctx.logger, manifest.posterUrl, "image", "/posterUrl");
    }
    return null;
  };

  let existing = await findExisting(deps.ledger, companyId, manifest);
  let created = false;
  if (existing && existing.matchedOn === "idempotencyKey" && (existing.row.sha256 !== manifest.sha256 || existing.row.brand_code !== manifest.brand)) {
    return fail(
      "idempotency_key_conflict",
      "idempotencyKey is already used by a creative with other media",
      { path: "/idempotencyKey" },
      toCreativeView(existing.row),
    );
  }

  const dryRun = isStagingDryRun(config);
  // A dry-run creative staged in live mode is staged anew, so its marker never reaches a live path.
  if (existing && (RESTAGEABLE_STATUSES.has(String(existing.row.status)) || (!dryRun && isDryRunCreativeRow(existing.row)))) {
    const media = await checkMedia();
    if (media) return media;
    const previousStatus = String(existing.row.status);
    if (await restage(deps, companyId, existing.row, manifest, dryRun, skipMediaCheck)) {
      await deps.ctx.activity.log({
        companyId,
        message: "rk9-ads creative restaged",
        entityType: "rk9ads_creative",
        entityId: String(existing.row.id),
        metadata: {
          brand: manifest.brand,
          kind: manifest.kind,
          sha256: manifest.sha256,
          previousStatus,
          stagingMode: dryRun ? "dry_run" : "live",
          ...(initiator ? { initiator } : {}),
        },
      });
    }
    // Restaged now or by a concurrent call: either way the row holds a manifest from this round.
    existing = { row: await loadRow(deps.ledger, companyId, String(existing.row.id)), matchedOn: existing.matchedOn };
  }

  if (!existing) {
    if ((await newCreativesToday(deps, companyId)) >= MAX_NEW_CREATIVES_PER_DAY) {
      return fail("creative_limit_reached", "this company has staged too many new creatives in the last 24 hours; retry later");
    }
    const media = await checkMedia();
    if (media) return media;
    const id = randomUUID();
    if (await insertIfAbsent(deps, companyId, id, manifest, dryRun, skipMediaCheck)) {
      created = true;
      existing = { row: await loadRow(deps.ledger, companyId, id), matchedOn: "idempotencyKey" };
      await deps.ctx.activity.log({
        companyId,
        message: "rk9-ads creative staged",
        entityType: "rk9ads_creative",
        entityId: id,
        metadata: {
          brand: manifest.brand,
          kind: manifest.kind,
          sha256: manifest.sha256,
          stagingMode: dryRun ? "dry_run" : "live",
          ...(initiator ? { initiator } : {}),
        },
      });
    } else {
      // A concurrent call inserted the same creative first.
      existing = await findExisting(deps.ledger, companyId, manifest);
      if (!existing) throw new Error("creative insert conflicted but no conflicting row was found");
    }
  }

  const { row, matchedOn } = existing;
  if (matchedOn === "idempotencyKey" && (row.sha256 !== manifest.sha256 || row.brand_code !== manifest.brand)) {
    // A concurrent call took the key for other media after the first lookup.
    return fail(
      "idempotency_key_conflict",
      "idempotencyKey is already used by a creative with other media",
      { path: "/idempotencyKey" },
      toCreativeView(row),
    );
  }
  if (!created) {
    const fields = differingTextFields(row, manifest);
    if (fields.length > 0) {
      return fail(
        "creative_text_conflict",
        `this media is already staged with other ${fields.join(", ")}; text variants belong to the publication, not the creative`,
        { path: `/${fields[0]}`, fields },
        toCreativeView(row),
      );
    }
  }

  if (needsUpload(row)) {
    const failure = await uploadVideo(deps, companyId, config, row, dryRun);
    if (failure) return failure;
  }

  const creative = toCreativeView(await loadRow(deps.ledger, companyId, String(row.id)));
  return { status: created ? 201 : 200, body: { created, creative } };
}
