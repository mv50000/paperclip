// --- RK9 Custom (RK9-621): coordination bus actor claim ---
import { z } from "zod";
import {
  parseRk9CoordActorId,
  rk9CoordBoardKeyMayClaim,
  RK9_COORD_ACTOR_ID_MAX_LENGTH,
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
