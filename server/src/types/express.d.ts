export {};

import type { AgentApiKeyScope } from "@paperclipai/shared";
// --- RK9 Custom (RK9-621) ---
import type { Rk9CoordResolvedActor, Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";
// --- /RK9 Custom ---

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        onBehalfOfMemberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        identityContextId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "cloud_tenant" | "cloud_control" | "none";
      };
      // --- RK9 Custom (RK9-621): coordination bus ---
      /** Coord token principal; set only by RK9-623's auth hook. */
      rk9CoordPrincipal?: Rk9CoordTokenPrincipal;
      /** Resolved coord actor; set by rk9CoordActorMiddleware on coord routes. */
      rk9CoordActor?: Rk9CoordResolvedActor | null;
      // --- /RK9 Custom ---
    }
  }
}
