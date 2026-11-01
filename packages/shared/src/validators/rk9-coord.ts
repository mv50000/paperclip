// --- RK9 Custom (RK9-621): coordination bus actor claim ---
import { z } from "zod";
import {
  parseRk9CoordActorId,
  rk9CoordBoardKeyMayClaim,
  RK9_COORD_ACTOR_ID_MAX_LENGTH,
  RK9_COORD_ACTOR_KINDS,
  RK9_COORD_HOST_LABEL_PATTERN,
  RK9_COORD_TOKEN_PRINCIPAL_KINDS,
  RK9_COORD_TOKEN_SERVICES,
} from "../rk9-coord.js";

/** The value of the `X-RK9-Actor` header: one actor_id from the ADR grammar. */
export const rk9CoordActorIdSchema = z
  .string()
  .min(1)
  .max(RK9_COORD_ACTOR_ID_MAX_LENGTH)
  .refine((value) => parseRk9CoordActorId(value) !== null, {
    message: "actor id does not match the coord actor_id grammar",
  });

/** An actor claim a board-key caller may make: no `operator`, no remote kinds. */
export const rk9CoordBoardKeyActorIdSchema = rk9CoordActorIdSchema.refine(
  (value) => {
    const parsed = parseRk9CoordActorId(value);
    return parsed !== null && rk9CoordBoardKeyMayClaim(parsed.kind);
  },
  { message: "a board-key caller may only claim cc, worktree, headless or orch" },
);
// --- /RK9 Custom ---

// --- RK9 Custom (RK9-623): coord token management bodies ---
const tokenLabelSchema = z.string().trim().min(1).max(200).nullable().optional();
const tokenExpiresAtSchema = z.string().datetime({ offset: true }).nullable().optional();

/** POST /companies/:companyId/rk9/coord-tokens */
export const issueRk9CoordTokenSchema = z
  .object({
    principalKind: z.enum(RK9_COORD_TOKEN_PRINCIPAL_KINDS),
    principalName: z.string().min(1).max(63),
    label: tokenLabelSchema,
    expiresAt: tokenExpiresAtSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const ok =
      value.principalKind === "host"
        ? RK9_COORD_HOST_LABEL_PATTERN.test(value.principalName)
        : (RK9_COORD_TOKEN_SERVICES as readonly string[]).includes(value.principalName);
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        path: ["principalName"],
        message:
          value.principalKind === "host"
            ? "a host token name must be a lower-case DNS label"
            : "a service token name must be rk9claude or grok",
      });
    }
  });
export type IssueRk9CoordToken = z.infer<typeof issueRk9CoordTokenSchema>;

/** POST /companies/:companyId/rk9/coord-tokens/:tokenId/rotate */
export const rotateRk9CoordTokenSchema = z
  .object({ label: tokenLabelSchema, expiresAt: tokenExpiresAtSchema })
  .strict();
export type RotateRk9CoordToken = z.infer<typeof rotateRk9CoordTokenSchema>;
// --- /RK9 Custom ---

// --- RK9 Custom (RK9-625): presence API bodies and query ---
//
// The rk9 CLI (RK9-624) sends snake_case bodies; camelCase aliases are
// accepted too. `kind`, `host` and `external_id` are advisory: the server
// derives the actor from the credential and X-RK9-Actor and validates the
// format here (422). A `kind` or `host` that contradicts the resolved actor is
// 403; a different `external_id` is kept as metadata.client_external_id.
// Phase and name are redacted and capped on the server, so the raw limits
// here only bound the work the redaction does.

const SURROGATE_PAIR_RX = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * True when `predicate` holds for every string key and value inside `value`
 * (objects and arrays, recursively). The server also uses it to scan metadata
 * for secrets string by string, because JSON.stringify escapes whitespace.
 */
export function everyRk9CoordString(
  value: unknown,
  predicate: (text: string) => boolean,
  maxDepth = RK9_COORD_METADATA_MAX_DEPTH,
): boolean {
  if (typeof value === "string") return predicate(value);
  if (value === null || typeof value !== "object") return true;
  // Depth-capped so a deeply nested body is a 422, never a stack overflow.
  if (maxDepth <= 0) return false;
  if (Array.isArray(value)) return value.every((item) => everyRk9CoordString(item, predicate, maxDepth - 1));
  return Object.entries(value).every(
    ([key, item]) => predicate(key) && everyRk9CoordString(item, predicate, maxDepth - 1),
  );
}

/** Metadata nesting limit (objects and arrays). */
export const RK9_COORD_METADATA_MAX_DEPTH = 16;

/** Raw phase input bound; the stored phase is redacted and capped at 140. */
export const RK9_COORD_PHASE_INPUT_MAX = 1000;
/** Stored phase cap (rk9_coord_actors.phase CHECK). */
export const RK9_COORD_PHASE_MAX = 140;

const coordIssueRefSchema = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/, "issue must look like RK9-625");
const coordRepoSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/, "repo must be <name> or <owner>/<name>");
const coordBranchSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\s\u0000-\u001f\u007f-\u009f]+$/, "branch must not contain whitespace or control characters");
const coordExternalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "external_id must be 1-128 characters [A-Za-z0-9._-]");
const coordClientEventIdSchema = z.string().min(1).max(128);
const coordPhaseSchema = z.string().max(RK9_COORD_PHASE_INPUT_MAX);

const coordAdvisoryIdentity = {
  kind: z.enum(RK9_COORD_ACTOR_KINDS).optional(),
  host: z.string().regex(RK9_COORD_HOST_LABEL_PATTERN, "host must be a lower-case DNS label").optional(),
  external_id: coordExternalIdSchema.optional(),
  externalId: coordExternalIdSchema.optional(),
  client_event_id: coordClientEventIdSchema.optional(),
  clientEventId: coordClientEventIdSchema.optional(),
};

/** PUT /companies/:companyId/rk9/coord/actors/me. null clears a field, an omitted key keeps it. */
export const upsertRk9CoordActorSchema = z
  .object({
    ...coordAdvisoryIdentity,
    name: z.string().max(RK9_COORD_PHASE_INPUT_MAX).nullable().optional(),
    issue: coordIssueRefSchema.nullable().optional(),
    repo: coordRepoSchema.nullable().optional(),
    branch: coordBranchSchema.nullable().optional(),
    phase: coordPhaseSchema.nullable().optional(),
    pid: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    liveness_source: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .nullable()
      .optional(),
    livenessSource: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .nullable()
      .optional(),
    metadata: z
      .record(z.string(), z.unknown())
      // One superRefine with early returns: the size check runs first, so the
      // walk only ever sees a small value (verifier round 3).
      .superRefine((value, ctx) => {
        let json: string;
        try {
          json = JSON.stringify(value);
        } catch {
          ctx.addIssue({ code: "custom", message: "metadata is not serializable" });
          return;
        }
        if (json.length > 4096) {
          ctx.addIssue({ code: "custom", message: "metadata must be at most 4096 bytes of JSON" });
          return;
        }
        // Postgres rejects NUL and unpaired surrogates in jsonb; answer 422, not 500.
        const clean = everyRk9CoordString(
          value,
          (text) => !/[\u0000]|\p{Cs}/u.test(text.replace(SURROGATE_PAIR_RX, "")),
        );
        if (!clean) {
          ctx.addIssue({
            code: "custom",
            message: `metadata must not contain NUL characters or unpaired surrogates, or nest deeper than ${RK9_COORD_METADATA_MAX_DEPTH}`,
          });
        }
      })
      .optional(),
  })
  .strict();
export type UpsertRk9CoordActor = z.infer<typeof upsertRk9CoordActorSchema>;

/** POST /companies/:companyId/rk9/coord/actors/me/phase */
export const updateRk9CoordActorPhaseSchema = z
  .object({ ...coordAdvisoryIdentity, phase: coordPhaseSchema.nullable() })
  .strict();
export type UpdateRk9CoordActorPhase = z.infer<typeof updateRk9CoordActorPhaseSchema>;

/** DELETE /companies/:companyId/rk9/coord/actors/me (body optional). */
export const endRk9CoordActorSchema = z.object({ ...coordAdvisoryIdentity }).strict();
export type EndRk9CoordActor = z.infer<typeof endRk9CoordActorSchema>;

const coordBoolQuery = z.enum(["0", "1", "true", "false"]).transform((value) => value === "1" || value === "true");

/** GET /companies/:companyId/rk9/coord/actors */
export const listRk9CoordActorsQuerySchema = z
  .object({
    active: coordBoolQuery.optional(),
    repo: coordRepoSchema.optional(),
    issue: coordIssueRefSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ListRk9CoordActorsQuery = z.infer<typeof listRk9CoordActorsQuerySchema>;
// --- /RK9 Custom ---
