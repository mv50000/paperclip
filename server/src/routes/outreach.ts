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
  importOutreachProspectsSchema,
  rejectOutreachMessageSchema,
  updateOutreachProspectSchema,
  updateOutreachSequenceSchema,
  type OutreachEventType,
  type OutreachMessageStatus,
  type OutreachProspectStatus,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import {
  addOutreachSuppression,
  approveMessage,
  createDraftMessage,
  createProspect,
  createSequence,
  deleteProspect,
  deleteSequence,
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
  recordEvent,
  rejectMessage,
  updateProspect,
  updateSequence,
} from "../services/outreach/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

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

function parseUuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

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
      await audit(req, companyId, "outreach.prospect.created", "outreach_prospect", result.prospect!.id, {
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

  router.get("/companies/:companyId/outreach/prospects/:prospectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await getProspect(db, companyId, req.params.prospectId as string);
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
      const id = req.params.prospectId as string;
      const existing = await getProspect(db, companyId, id);
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Manual status edits are limited to the review step; terminal states are sticky.
      if (req.body.status && existing.status !== "new" && existing.status !== "approved") {
        res.status(409).json({ error: "invalid_transition", status: existing.status });
        return;
      }
      const row = await updateProspect(db, companyId, id, req.body);
      await audit(req, companyId, "outreach.prospect.updated", "outreach_prospect", id, {
        fields: Object.keys(req.body),
      });
      res.json(row);
    },
  );

  router.delete("/companies/:companyId/outreach/prospects/:prospectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.prospectId as string;
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
    const row = await getSequence(db, companyId, req.params.sequenceId as string);
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
      const id = req.params.sequenceId as string;
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
    const id = req.params.sequenceId as string;
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

  router.get("/companies/:companyId/outreach/messages/:messageId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const row = await getMessage(db, companyId, req.params.messageId as string);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  });

  router.post(
    "/companies/:companyId/outreach/messages/:messageId/approve",
    validate(approveOutreachMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const id = req.params.messageId as string;
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
      const id = req.params.messageId as string;
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
    assertCompanyAccess(req, companyId);
    res.json(await listOutreachSuppressions(db, parseLimit(req.query.limit)));
  });

  router.post(
    "/companies/:companyId/outreach/suppressions",
    validate(addOutreachSuppressionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
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

  return router;
}
