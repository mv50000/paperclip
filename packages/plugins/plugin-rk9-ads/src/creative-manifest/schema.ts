/**
 * Creative manifest v1 (RK9-513): the contract a brand repo uses to hand a
 * finished creative to the plugin.
 *
 * This zod schema is the single source. `creativeManifestJsonSchema()` derives
 * the JSON Schema that the package exports as
 * `@paperclipai/plugin-rk9-ads/creative-manifest.v1.schema.json`, and a test
 * checks that the committed file matches it (`pnpm schema:generate` rewrites it).
 *
 * This file imports only zod, so `scripts/generate-creative-manifest-schema.mjs`
 * can load it with Node's type stripping and no build step.
 *
 * Media travels as an HTTPS URL (G4). The plugin never downloads the bytes, so
 * `sha256` is a dedupe key that the plugin does not verify.
 */

import { z } from "zod";

export const CREATIVE_MANIFEST_SCHEMA_VERSION = "1";
export const CREATIVE_MANIFEST_SCHEMA_ID = "https://paperclip.rk9.fi/schemas/rk9-ads/creative-manifest.v1.schema.json";

export const CREATIVE_KINDS = ["image", "video"] as const;
export type CreativeKind = (typeof CREATIVE_KINDS)[number];

export const ASPECT_RATIOS = ["9:16", "4:5", "1:1", "1.91:1", "16:9"] as const;

/** Meta `call_to_action.type` values a brand may use. */
export const META_CTA_TYPES = [
  "LEARN_MORE",
  "SHOP_NOW",
  "BOOK_TRAVEL",
  "SIGN_UP",
  "CONTACT_US",
  "GET_OFFER",
  "GET_QUOTE",
  "SUBSCRIBE",
  "APPLY_NOW",
  "ORDER_NOW",
  "BUY_NOW",
  "BUY_TICKETS",
  "SEE_MORE",
  "WATCH_MORE",
  "DOWNLOAD",
  "GET_DIRECTIONS",
  "DONATE_NOW",
  "NO_BUTTON",
] as const;

export const MAX_URL_LENGTH = 2048;
const HTTPS_PREFIX_PATTERN = "^https://";
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Name suffixes that only resolve inside a private network. */
const PRIVATE_NAME_RE = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/;

export type UrlProblem = { code: "url_not_https" | "url_forbidden"; message: string };

/**
 * Checks a media URL before anything uses it. The plugin hands the URL to Meta
 * and sends one HEAD through the host fetch, whose SSRF guard resolves DNS and
 * refuses private addresses. This check adds what can be decided from the URL
 * text alone: https only, no credentials, the default port, and no IP literal
 * or private-only host name.
 */
export function checkMediaUrl(value: string): UrlProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { code: "url_not_https", message: "must be an absolute https URL" };
  }
  if (url.protocol !== "https:") return { code: "url_not_https", message: "must be an absolute https URL" };
  if (url.username || url.password) return { code: "url_forbidden", message: "must not carry credentials" };
  if (url.port !== "") return { code: "url_forbidden", message: "must use the default https port" };
  // The URL parser has already normalised decimal, octal and hex IPv4 forms to dotted quads.
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || IPV4_RE.test(host)) {
    return { code: "url_forbidden", message: "must use a host name, not an IP address" };
  }
  if (!host.includes(".") || PRIVATE_NAME_RE.test(host.replace(/\.$/, ""))) {
    return { code: "url_forbidden", message: "must use a public host name" };
  }
  return null;
}

/**
 * The https rule lives in the refinement, so a failure carries its own error
 * code; `meta` repeats it as a pattern for the JSON Schema export.
 */
const httpsUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .superRefine((value, ctx) => {
    const problem = checkMediaUrl(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem.message, params: { code: problem.code } });
  })
  .meta({ format: "uri", pattern: HTTPS_PREFIX_PATTERN });

const creativeManifestObject = z
  .object({
    schemaVersion: z.literal(CREATIVE_MANIFEST_SCHEMA_VERSION),
    brand: z.string().regex(/^[A-Z0-9]{2,10}$/).describe("Brand code; must equal the company config brandCode."),
    kind: z.enum(CREATIVE_KINDS),
    mediaUrl: httpsUrl.describe("Public https URL of the finished media. Meta fetches it; the plugin does not."),
    posterUrl: httpsUrl.optional().describe("Video only: public https URL of the poster image."),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("Lower-case hex sha256 of the media bytes. Dedupe key; the plugin does not download the media to verify it."),
    aspectRatio: z.enum(ASPECT_RATIOS),
    copy: z
      .object({
        message: z.string().min(1).max(2000),
        title: z.string().min(1).max(255).optional(),
        description: z.string().min(1).max(255).optional(),
      })
      .strict(),
    cta: z.enum(META_CTA_TYPES),
    landingUrlKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .describe("Key into the company config landing.urls. A manifest never carries a raw landing URL."),
    utmCampaign: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    validUntil: z.iso.datetime({ offset: true }).describe("ISO 8601 instant with an offset; must be in the future."),
    targetAdsetId: z.string().regex(/^\d{1,32}$/).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict()
  .meta({
    title: "RK9 Ads creative manifest v1",
    description:
      "A finished creative that a brand repo hands to the RK9 Ads plugin (rk9ads_stage_creative or POST /api/plugins/<pluginId>/api/creatives).",
  });

/**
 * The runtime schema: the object schema plus the cross-field check that JSON
 * Schema does not express.
 */
export const creativeManifestV1 = creativeManifestObject.superRefine((manifest, ctx) => {
  if (manifest.posterUrl !== undefined && manifest.kind !== "video") {
    ctx.addIssue({ code: "custom", path: ["posterUrl"], message: "is allowed only when kind is video" });
  }
});

export type CreativeManifestV1 = z.infer<typeof creativeManifestObject>;

/** The JSON Schema export (draft-07, the Ajv default). */
export function creativeManifestJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(creativeManifestObject, { target: "draft-07" }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return { $schema, $id: CREATIVE_MANIFEST_SCHEMA_ID, ...rest };
}

export interface ManifestIssue {
  /** Error code: `invalid_manifest`, or a URL code such as `url_not_https`. */
  code: string;
  /** RFC 6901 JSON pointer into the manifest, e.g. "/copy/message"; "" for the root. */
  path: string;
  message: string;
}

export function jsonPointer(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

export type ManifestParseResult = { ok: true; manifest: CreativeManifestV1 } | { ok: false; issues: ManifestIssue[] };

export function parseCreativeManifest(input: unknown): ManifestParseResult {
  const result = creativeManifestV1.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const issues = result.error.issues.map((issue) => {
    const params = (issue as { params?: { code?: unknown } }).params;
    return {
      code: typeof params?.code === "string" ? params.code : "invalid_manifest",
      path: jsonPointer(issue.path),
      message: issue.message,
    };
  });
  return { ok: false, issues };
}
