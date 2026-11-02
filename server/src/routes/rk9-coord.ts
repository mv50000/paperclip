// --- RK9 Custom (RK9-621): coordination bus router skeleton ---
//
// Owner of `/api/companies/:companyId/rk9/coord/*` (epic RK9-620). Sibling
// children add ONLY their own sub-router file and one mount line in the block
// below; they do not touch the actor middleware or the whoami contract.
// Contract: docs/implementation-notes/coord-identity.md.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { RK9_COORD_ROUTE_PREFIX } from "@paperclipai/shared";
import {
  rk9CoordActorMiddleware,
  rk9CoordActorView,
  type Rk9CoordActorOptions,
} from "../middleware/rk9-coord-actor.js";
import { rk9CoordActorRoutes, type Rk9CoordActorRouteOptions } from "./rk9-coord-actors.js";
// RK9 Custom (RK9-626): journal, inbox and board sub-routers
import { rk9CoordEventRoutes } from "./rk9-coord-events.js";
import { rk9CoordInboxRoutes } from "./rk9-coord-inbox.js";
import { rk9CoordBoardRoutes } from "./rk9-coord-board.js";
// RK9 Custom (RK9-627): lease engine sub-router
import { rk9CoordLeaseRoutes } from "./rk9-coord-leases.js";

export type Rk9CoordRouteOptions = Rk9CoordActorOptions & {
  /** Presence clock/env injection (tests). RK9-625. */
  presence?: Rk9CoordActorRouteOptions;
};

export function rk9CoordRoutes(db: Db, opts: Rk9CoordRouteOptions = {}) {
  const coord = Router({ mergeParams: true });
  // Every coord route, including sub-routers mounted below, runs behind the
  // actor middleware: company scope, RK9-616 loopback rule, actor claim.
  coord.use(rk9CoordActorMiddleware(db, opts));

  coord.get("/whoami", (req, res) => {
    const principal = req.rk9CoordPrincipal;
    res.json({
      companyId: (req.params as Record<string, string | undefined>).companyId ?? null,
      actor: rk9CoordActorView(req.rk9CoordActor),
      principal: {
        source: req.rk9CoordActor?.principal ?? (principal ? "coord_token" : req.actor.source ?? null),
        agentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        runId: req.actor.type === "agent" ? req.actor.runId ?? null : null,
        tokenHost: principal ? principal.principalName : null,
      },
    });
  });

  // --- Sibling mount points (RK9-620): one line per child, keep this order ---
  coord.use("/actors", rk9CoordActorRoutes(db, opts.presence)); // presence-api (RK9-625)
  coord.use("/events", rk9CoordEventRoutes(db));   // journal-inbox-api (RK9-626)
  coord.use("/inbox", rk9CoordInboxRoutes(db));    // journal-inbox-api (RK9-626)
  coord.use("/leases", rk9CoordLeaseRoutes(db));   // lease-engine (RK9-627)
  coord.use("/board", rk9CoordBoardRoutes(db));    // journal-inbox-api (RK9-626)
  // --- end sibling mount points ---

  coord.use((_req, res) => {
    res.status(404).json({ error: "Unknown coord route", code: "rk9_coord_not_found" });
  });

  const router = Router();
  router.use(RK9_COORD_ROUTE_PREFIX, coord);
  return router;
}
// --- /RK9 Custom ---
