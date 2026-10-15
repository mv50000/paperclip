/**
 * Creative ingress (RK9-513): the one `stageCreative()` behind the agent tool
 * `rk9ads_stage_creative` and the API route `POST /creatives`.
 *
 * Steps: validate the manifest, check it against the company's brand config,
 * return an existing record on a dedupe hit, check the media with one HEAD
 * through the host fetch, insert the row (a unique constraint settles races),
 * and for a video start the Meta upload by `file_url`.
 *
 * Media travels as an HTTPS URL (G4). The plugin never reads media bytes: the
 * HEAD gives the type and size, Meta fetches the file itself. A staged
 * creative holds at most a Meta video id; nothing it creates can spend money.
 * Activation stays with the Telegram gate (G1).
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../config.js";
import { loadCompanyConfig } from "../company-configs.js";
import type { Ledger, LedgerRow } from "../db.js";
import { createMetaClient, type FetchLike, type MetaGraphClient } from "../meta/graph.js";
import { uploadVideoByUrl } from "../meta/methods.js";
import { redactText } from "../meta/redact.js";
import { isDryRun } from "../meta/types.js";
import { parseCreativeManifest, type CreativeManifestV1, type ManifestIssue } from "./schema.js";

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
}

export interface StageError {
  code: StageErrorCode;
  message: string;
  /** JSON pointer into the manifest when one field is at fault. */
  path?: string;
  issues?: ManifestIssue[];
}

export type StageResponseBody =
  | { created: boolean; creative: CreativeView }
  | { error: StageError; creative?: CreativeView };

export interface StageResult {
  status: number;
  body: StageResponseBody;
}

export interface StageDeps {
  ctx: PluginContext;
  ledger: Ledger;
  now?: () => Date;
  /** Test seam; the worker uses `createMetaClient`. */
  metaClient?: (companyId: string, config: BrandConfig) => MetaGraphClient;
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
async function insertIfAbsent(deps: StageDeps, companyId: string, id: string, manifest: CreativeManifestV1): Promise<boolean> {
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
    ["payload", JSON.stringify({ schemaVersion: manifest.schemaVersion })],
  ];
  const result = await deps.ctx.db.execute(
    `INSERT INTO ${deps.ledger.qualified("creatives")} (${values.map(([column]) => column).join(", ")})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
     ON CONFLICT DO NOTHING`,
    values.map(([, value]) => value),
  );
  return result.rowCount === 1;
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
  url: string,
  expected: "image" | "video",
  pointer: string,
): Promise<StageResult | null> {
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail("media_unreachable", `HEAD failed: ${redactText(reason).slice(0, 200)}`, { path: pointer });
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

/**
 * Starts the Meta upload of a staged or failed video. A compare-and-set on the
 * status lets exactly one caller upload.
 */
async function uploadVideo(deps: StageDeps, companyId: string, config: BrandConfig, row: LedgerRow): Promise<StageResult | null> {
  const id = String(row.id);
  const claimed = await deps.ledger.update(companyId, "creatives", { id, status: String(row.status) }, { status: "uploading", error: null });
  if (claimed !== 1) return null;
  const client = deps.metaClient
    ? deps.metaClient(companyId, config)
    : createMetaClient(deps.ctx, {
        companyId,
        tokenRef: config.meta.accessTokenRef,
        tokenConfigPath: "meta.accessTokenRef",
        mode: "live",
      });
  try {
    const result = await uploadVideoByUrl(client, config.meta.adAccountId, {
      fileUrl: String(row.media_url),
      name: `${config.namingPrefix}-${String(row.idempotency_key)}`.slice(0, 100),
    });
    if (isDryRun(result)) {
      await deps.ledger.update(companyId, "creatives", { id, status: "uploading" }, { status: "staged" });
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
  return row.kind === "video" && !str(row.meta_video_id) && (row.status === "staged" || row.status === "failed");
}

/**
 * Stages one creative manifest for `companyId`. The caller has already proved
 * the company: the tool takes it from the agent run, the route from the host's
 * company access check.
 */
export async function stageCreative(deps: StageDeps, companyId: string, input: unknown): Promise<StageResult> {
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

  let existing = await findExisting(deps.ledger, companyId, manifest);
  let created = false;
  if (!existing) {
    const media = await checkRemoteMedia(deps.ctx.http.fetch, manifest.mediaUrl, manifest.kind, "/mediaUrl");
    if (media) return media;
    if (manifest.posterUrl) {
      const poster = await checkRemoteMedia(deps.ctx.http.fetch, manifest.posterUrl, "image", "/posterUrl");
      if (poster) return poster;
    }
    const id = randomUUID();
    if (await insertIfAbsent(deps, companyId, id, manifest)) {
      created = true;
      existing = { row: await loadRow(deps.ledger, companyId, id), matchedOn: "idempotencyKey" };
      await deps.ctx.activity.log({
        companyId,
        message: "rk9-ads creative staged",
        entityType: "rk9ads_creative",
        entityId: id,
        metadata: { brand: manifest.brand, kind: manifest.kind, sha256: manifest.sha256 },
      });
    } else {
      // A concurrent call inserted the same creative first.
      existing = await findExisting(deps.ledger, companyId, manifest);
      if (!existing) throw new Error("creative insert conflicted but no conflicting row was found");
    }
  }

  const { row, matchedOn } = existing;
  if (matchedOn === "idempotencyKey" && (row.sha256 !== manifest.sha256 || row.brand_code !== manifest.brand)) {
    return fail(
      "idempotency_key_conflict",
      "idempotencyKey is already used by a creative with other media",
      { path: "/idempotencyKey" },
      toCreativeView(row),
    );
  }

  if (needsUpload(row)) {
    const failure = await uploadVideo(deps, companyId, config, row);
    if (failure) return failure;
  }

  const creative = toCreativeView(await loadRow(deps.ledger, companyId, String(row.id)));
  return { status: created ? 201 : 200, body: { created, creative } };
}
