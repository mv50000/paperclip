// --- RK9 Custom (RK9-621): coordination bus actor claim ---
import { z } from "zod";
import { parseRk9CoordActorId, RK9_COORD_ACTOR_ID_MAX_LENGTH } from "../rk9-coord.js";

/** The value of the `X-RK9-Actor` header: one actor_id from the ADR grammar. */
export const rk9CoordActorIdSchema = z
  .string()
  .min(1)
  .max(RK9_COORD_ACTOR_ID_MAX_LENGTH)
  .refine((value) => parseRk9CoordActorId(value) !== null, {
    message: "actor id does not match the coord actor_id grammar",
  });
// --- /RK9 Custom ---
