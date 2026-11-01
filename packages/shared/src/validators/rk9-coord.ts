// --- RK9 Custom (RK9-621): coordination bus actor claim ---
import { z } from "zod";
import {
  parseRk9CoordActorId,
  rk9CoordBoardKeyMayClaim,
  RK9_COORD_ACTOR_ID_MAX_LENGTH,
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
