import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  OUTREACH_EVENT_TYPES,
  OUTREACH_MESSAGE_STATUSES,
  OUTREACH_PROSPECT_STATUSES,
  addOutreachSuppressionSchema,
  approveOutreachMessageSchema,
  checkOutreachSuppressionSchema,
  createOutreachEventSchema,
  createOutreachMessageSchema,
  createOutreachProspectSchema,
  createOutreachSequenceSchema,
  draftOutreachMessagesSchema,
  enrichOutreachProspectsSchema,
  importOutreachProspectsSchema,
  pauseOutreachSenderSchema,
  rejectOutreachMessageSchema,
  resumeOutreachSenderSchema,
  updateOutreachMessageSchema,
  updateOutreachProspectSchema,
  updateOutreachSequenceSchema,
  type OutreachEventType,
  type OutreachMessageStatus,
  type OutreachProspectStatus,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import {
  addOutreachSuppression,
  approveMessage,
  createDraftMessage,
  createProspect,
  createSequence,
  deleteProspect,
  deleteSequence,
  draftMessages,
  enrichProspects,
  findOutreachSuppressed,
  getMessage,
  getProspect,
  getSequence,
  importProspects,
  listEvents,
  listMessages,
  listOutreachSuppressions,
  listProspects,
  listSequences,
  listActivePauses,
  listPauseHistory,
  pauseSender,
  recordEvent,
  rejectMessage,
  resumeSender,
  updateDraftMessage,
  updateProspect,
  updateSequence,
} from "../services/outreach/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// RK9-193: outreach API. Company-scoped except the suppression list, which is
// GLOBAL (routes still live under /companies/:companyId for access control and
// audit attribution). No sending here — RK9-196+ owns dispatch.

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function parseLimit(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
}

/** Path ids hit `uuid` columns; a malformed id is a 404, not a Postgres 22P02 → 500. */
function pathId(value: unknown): string {
  const id = parseUuid(value);
  if (!id) throw notFound();
  return id;
}

/** Event types whose side effect is a permanent GLOBAL suppression entry. */
const SUPPRESSING_EVENT_TYPES: ReadonlySet<OutreachEventType> = new Set([
  "unsubscribe",
  "complaint",
  "bounce_hard",
]);

export function outreachRoutes(db: Db) {
  const router = Router();

  async function audit(
    req: Parameters<typeof getActorInfo>[0],
    companyId: string,
    action: string,
    entityType: string,
    entityId: string,
    details?: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType,
      entityId,
      details: details ?? null,
    });
  }

  // --- Prospects -----------------------------------------------------------

  router.get("/companies/:companyId/outreach/prospects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await listProspects(db, companyId, {
      status: pickEnum<OutreachProspectStatus>(req.query.status, OUTREACH_PROSPECT_STATUSES),
      limit: parseLimit(req.query.limit),
    });
    res.json(rows);
  });

  router.post(
    "/companies/:companyId/outreach/prospects",
    validate(createOutreachProspectSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await createProspect(db, companyId, req.body);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.prospect.created", "outreach_prospect", result.prospect.id, {
        source: req.body.source,
      });
      res.status(201).json(result.prospect);
    },
  );

  router.post(
    "/companies/:companyId/outreach/prospects/import",
    validate(importOutreachProspectsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await importProspects(db, companyId, req.body.prospects);
      await audit(req, companyId, "outreach.prospects.imported", "outreach_prospect", companyId, {
        received: req.body.prospects.length,
        imported: result.imported,
        rejected: result.rejected.length,
      });
      res.status(result.imported > 0 ? 201 : 200).json(result);
    },
  );

  // RK9-196: batch website enrichment (Firecrawl keyless scrape + generic
  // e-mail discovery). Registered before the `:prospectId` GET so "enrich"
  // is never captured as a prospect id.
  router.post(
    "/companies/:companyId/outreach/prospects/enrich",
    validate(enrichOutreachProspectsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const results = await enrichProspects(db, companyId, req.body.prospectIds);
      await audit(req, companyId, "outreach.prospects.enriched", "outreach_prospect", companyId, {
        requested: req.body.prospectIds.length,
        succeeded: results.filter((r) => r.ok).length,
      });
      res.json({ results });
    },
  );

  router.get("/companies/:companyId/outreach/prospects/:prospectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await getProspect(db, companyId, pathId(req.params.prospectId));
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  router.patch(
    "/companies/:companyId/outreach/prospects/:prospectId",
    validate(updateOutreachProspectSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = pathId(req.params.prospectId);
      // Manual status edits are limited to the review step (new ⇄ approved);
      // the service enforces it in the UPDATE's WHERE so terminal states stay sticky.
      const result = await updateProspect(db, companyId, id, req.body);
      if (!result.ok) {
        res.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.prospect.updated", "outreach_prospect", id, {
        fields: Object.keys(req.body),
      });
      res.json(result.prospect);
    },
  );

  router.delete("/companies/:companyId/outreach/prospects/:prospectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = pathId(req.params.prospectId);
    const removed = await deleteProspect(db, companyId, id);
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await audit(req, companyId, "outreach.prospect.deleted", "outreach_prospect", id);
    res.status(204).end();
  });

  // --- Sequences -----------------------------------------------------------

  router.get("/companies/:companyId/outreach/sequences", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await listSequences(db, companyId));
  });

  router.post(
    "/companies/:companyId/outreach/sequences",
    validate(createOutreachSequenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const row = await createSequence(db, companyId, req.body);
      if (!row) {
        res.status(409).json({ error: "duplicate_name" });
        return;
      }
      await audit(req, companyId, "outreach.sequence.created", "outreach_sequence", row.id, {
        name: row.name,
      });
      res.status(201).json(row);
    },
  );

  router.get("/companies/:companyId/outreach/sequences/:sequenceId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await getSequence(db, companyId, pathId(req.params.sequenceId));
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  router.patch(
    "/companies/:companyId/outreach/sequences/:sequenceId",
    validate(updateOutreachSequenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = pathId(req.params.sequenceId);
      const row = await updateSequence(db, companyId, id, req.body);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      await audit(req, companyId, "outreach.sequence.updated", "outreach_sequence", id, {
        fields: Object.keys(req.body),
      });
      res.json(row);
    },
  );

  router.delete("/companies/:companyId/outreach/sequences/:sequenceId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = pathId(req.params.sequenceId);
    const removed = await deleteSequence(db, companyId, id);
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await audit(req, companyId, "outreach.sequence.deleted", "outreach_sequence", id);
    res.status(204).end();
  });

  // --- Messages ------------------------------------------------------------

  router.get("/companies/:companyId/outreach/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await listMessages(db, companyId, {
      status: pickEnum<OutreachMessageStatus>(req.query.status, OUTREACH_MESSAGE_STATUSES),
      prospectId: parseUuid(req.query.prospectId),
      limit: parseLimit(req.query.limit),
    });
    res.json(rows);
  });

  router.post(
    "/companies/:companyId/outreach/messages",
    validate(createOutreachMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await createDraftMessage(db, companyId, req.body);
      if (!result.ok) {
        res
          .status(result.reason === "prospect_not_contactable" ? 409 : 404)
          .json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.message.drafted", "outreach_message", result.message.id, {
        prospectId: result.message.prospectId,
        step: result.message.step,
      });
      res.status(201).json(result.message);
    },
  );

  // RK9-196: AI batch drafting. Registered before the `:messageId` GET so
  // "draft" is never captured as a message id.
  router.post(
    "/companies/:companyId/outreach/messages/draft",
    validate(draftOutreachMessagesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await draftMessages(
        db,
        companyId,
        req.body.company,
        req.body.prospectIds,
        req.body.maxCostUsd,
        req.body.sequenceId,
      );
      if (!result.ok) {
        res.status(result.reason === "sequence_not_found" ? 404 : 422).json({ error: result.reason });
        return;
      }
      const { ok: _ok, ...outcome } = result;
      await audit(req, companyId, "outreach.messages.ai_drafted", "outreach_message", companyId, {
        requested: req.body.prospectIds.length,
        drafted: outcome.drafted,
        gateRejected: outcome.gateRejected,
        failed: outcome.failed.length,
        totalCostUsd: outcome.totalCostUsd,
        stoppedForBudget: outcome.stoppedForBudget,
      });
      res.json(outcome);
    },
  );

  router.get("/companies/:companyId/outreach/messages/:messageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await getMessage(db, companyId, pathId(req.params.messageId));
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  // RK9-196: review tool's "edit" action — rewrite a still-`draft` message.
  router.patch(
    "/companies/:companyId/outreach/messages/:messageId",
    validate(updateOutreachMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = pathId(req.params.messageId);
      const result = await updateDraftMessage(db, companyId, id, req.body);
      if (!result.ok) {
        res.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.message.edited", "outreach_message", id, {
        fields: Object.keys(req.body),
      });
      res.json(result.message);
    },
  );

  router.post(
    "/companies/:companyId/outreach/messages/:messageId/approve",
    validate(approveOutreachMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const id = pathId(req.params.messageId);
      const result = await approveMessage(db, companyId, id, actor.actorId);
      if (!result.ok) {
        res.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason, status: result.status });
        return;
      }
      await audit(req, companyId, "outreach.message.approved", "outreach_message", id);
      res.json(result.message);
    },
  );

  router.post(
    "/companies/:companyId/outreach/messages/:messageId/reject",
    validate(rejectOutreachMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const id = pathId(req.params.messageId);
      const result = await rejectMessage(db, companyId, id, actor.actorId, req.body.reason);
      if (!result.ok) {
        res.status(result.reason === "not_found" ? 404 : 409).json({ error: result.reason, status: result.status });
        return;
      }
      await audit(req, companyId, "outreach.message.rejected", "outreach_message", id, {
        reason: req.body.reason,
      });
      res.json(result.message);
    },
  );

  // --- Events --------------------------------------------------------------

  router.get("/companies/:companyId/outreach/events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await listEvents(db, companyId, {
      type: pickEnum<OutreachEventType>(req.query.type, OUTREACH_EVENT_TYPES),
      prospectId: parseUuid(req.query.prospectId),
      limit: parseLimit(req.query.limit),
    });
    res.json(rows);
  });

  router.post(
    "/companies/:companyId/outreach/events",
    validate(createOutreachEventSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // Opt-out / hard-bounce events write a permanent GLOBAL suppression row
      // that crosses company boundaries. Agent keys (a prompt-injection
      // surface) may only record informational events; the rest is board/
      // system only until provider webhooks land (RK9-196+).
      if (req.actor.type === "agent" && SUPPRESSING_EVENT_TYPES.has(req.body.type)) {
        throw forbidden("Suppressing outreach events are restricted to board actors");
      }
      const result = await recordEvent(db, companyId, req.body);
      if (!result.ok) {
        res.status(404).json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.event.recorded", "outreach_event", result.event.id, {
        type: result.event.type,
        prospectId: result.event.prospectId,
        prospectStatus: result.prospectStatus,
        suppressed: result.suppressed,
      });
      res.status(201).json(result);
    },
  );

  // --- Suppressions (GLOBAL list; company path only for access + audit) ----

  router.get("/companies/:companyId/outreach/suppressions", async (req, res) => {
    const companyId = req.params.companyId as string;
    // Board only: the full global opt-out list is not need-to-know for agent
    // keys — they have POST …/suppressions/check.
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await listOutreachSuppressions(db, parseLimit(req.query.limit)));
  });

  router.post(
    "/companies/:companyId/outreach/suppressions",
    validate(addOutreachSuppressionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      // Board only: the list is global and permanent, so no agent key may write it directly.
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const result = await addOutreachSuppression(db, {
        email: req.body.email,
        reason: req.body.reason,
        note: req.body.note,
        sourceCompanyId: companyId,
      });
      if (result.created) {
        await audit(req, companyId, "outreach.suppression.added", "outreach_suppression", result.entry.id, {
          reason: req.body.reason,
        });
      }
      res.status(result.created ? 201 : 200).json(result.entry);
    },
  );

  router.post(
    "/companies/:companyId/outreach/suppressions/check",
    validate(checkOutreachSuppressionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const suppressed = await findOutreachSuppressed(db, req.body.emails);
      res.json({
        suppressed: req.body.emails.filter((email: string) => suppressed.has(email)),
      });
    },
  );

  // No DELETE for suppressions: entries are permanent (GDPR objection right).

  // --- Sender pauses (RK9-197; GLOBAL by sender identity — company path only
  // for access control, same convention as suppressions above) -------------

  router.get("/companies/:companyId/outreach/senders/pauses", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await listActivePauses(db));
  });

  router.get("/companies/:companyId/outreach/senders/:senderIdentity/pauses", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await listPauseHistory(db, decodeURIComponent(req.params.senderIdentity as string)));
  });

  // Board-only, not agent-callable: a manual pause outside the three
  // automatic rules (agent keys are a prompt-injection surface — same
  // reasoning as the `SUPPRESSING_EVENT_TYPES` restriction above).
  router.post(
    "/companies/:companyId/outreach/senders/:senderIdentity/pause",
    validate(pauseOutreachSenderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const senderIdentity = decodeURIComponent(req.params.senderIdentity as string);
      const result = await pauseSender(db, { senderIdentity, reason: req.body.reason, detail: req.body.note ? { note: req.body.note } : {} });
      await audit(req, companyId, "outreach.sender.paused", "outreach_sender_pause", result.pause.id, {
        senderIdentity,
        reason: req.body.reason,
        alreadyPaused: !result.created,
      });
      res.status(result.created ? 201 : 200).json(result.pause);
    },
  );

  // The AC requires resume to be an explicit human action, never a timeout —
  // board-only (agent keys cannot resume a paused sender).
  router.post(
    "/companies/:companyId/outreach/senders/:senderIdentity/resume",
    validate(resumeOutreachSenderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const senderIdentity = decodeURIComponent(req.params.senderIdentity as string);
      const actor = getActorInfo(req);
      const result = await resumeSender(db, senderIdentity, actor.actorId);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      await audit(req, companyId, "outreach.sender.resumed", "outreach_sender_pause", result.pause.id, {
        senderIdentity,
      });
      res.json(result.pause);
    },
  );

  return router;
}
