import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent,
  subscribeAllLiveEvents: () => () => {},
}));

import { emitApprovalCreated } from "../services/approvals.js";

describe("emitApprovalCreated", () => {
  beforeEach(() => {
    publishLiveEvent.mockReset();
  });

  it("publishes approval.created live event for risk-incident approvals", () => {
    emitApprovalCreated({
      id: "appr-1",
      companyId: "co-1",
      type: "risk_incident_acknowledgment",
      status: "pending",
      requestedByAgentId: null,
      requestedByUserId: null,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      payload: {
        title: "Risk incident: Silent agent",
        incidentId: "inc-1",
        incidentTitle: "Silent agent",
        severity: "high",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "co-1",
      type: "approval.created",
      payload: expect.objectContaining({
        id: "appr-1",
        type: "risk_incident_acknowledgment",
        status: "pending",
        title: "Risk incident: Silent agent",
      }),
    });
  });

  it("publishes approval.created live event for budget-override approvals", () => {
    emitApprovalCreated({
      id: "appr-2",
      companyId: "co-2",
      type: "budget_override_required",
      status: "pending",
      requestedByAgentId: null,
      requestedByUserId: null,
      decidedByUserId: null,
      decidedAt: null,
      decisionNote: null,
      payload: {
        title: "Budget override: Sales agent (cost)",
        scopeName: "Sales agent",
        thresholdType: "hard",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "co-2",
      type: "approval.created",
      payload: expect.objectContaining({
        id: "appr-2",
        type: "budget_override_required",
        title: "Budget override: Sales agent (cost)",
      }),
    });
  });
});
