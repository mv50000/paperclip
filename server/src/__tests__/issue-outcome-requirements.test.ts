import { describe, expect, it } from "vitest";
import {
  evaluateIssueOutcomeRequirements,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";

describe("normalizeIssueExecutionPolicy with outcomeRequirements", () => {
  it("keeps the policy alive when only outcomeRequirements are set", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [],
      outcomeRequirements: [
        { kind: "work_product_present", workProductType: "runtime_service" },
      ],
    });
    expect(policy).not.toBeNull();
    expect(policy!.stages).toEqual([]);
    expect(policy!.outcomeRequirements).toHaveLength(1);
    expect(policy!.outcomeRequirements[0]).toMatchObject({
      kind: "work_product_present",
      workProductType: "runtime_service",
    });
    expect(policy!.outcomeRequirements[0].id).toBeDefined();
  });

  it("returns null when both stages and outcomeRequirements are empty", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [], outcomeRequirements: [] })).toBeNull();
  });

  it("defaults outcomeRequirements to an empty array when omitted", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: "11111111-1111-4111-8111-111111111111" }],
        },
      ],
    });
    expect(policy!.outcomeRequirements).toEqual([]);
  });

  it("rejects requirements with unknown kind", () => {
    expect(() =>
      normalizeIssueExecutionPolicy({
        stages: [],
        outcomeRequirements: [{ kind: "bogus", foo: "bar" }],
      }),
    ).toThrow("Invalid execution policy");
  });
});

describe("evaluateIssueOutcomeRequirements", () => {
  const policyWith = (requirements: unknown[]) =>
    normalizeIssueExecutionPolicy({ stages: [], outcomeRequirements: requirements })!;

  it("returns no failures when policy is null", () => {
    expect(evaluateIssueOutcomeRequirements(null, [])).toEqual([]);
  });

  it("returns no failures when there are no requirements", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: "11111111-1111-4111-8111-111111111111" }],
        },
      ],
    })!;
    expect(evaluateIssueOutcomeRequirements(policy, [])).toEqual([]);
  });

  it("flags missing work product type", () => {
    const policy = policyWith([
      { kind: "work_product_present", workProductType: "runtime_service" },
    ]);
    const failures = evaluateIssueOutcomeRequirements(policy, [
      { type: "document", healthStatus: "unknown" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("work_product_present");
    expect(failures[0].message).toContain("runtime_service");
  });

  it("passes when a matching work product exists", () => {
    const policy = policyWith([
      { kind: "work_product_present", workProductType: "runtime_service" },
    ]);
    const failures = evaluateIssueOutcomeRequirements(policy, [
      { type: "runtime_service", healthStatus: "unknown" },
    ]);
    expect(failures).toEqual([]);
  });

  it("requires healthy when healthStatus=healthy is specified — fails on unhealthy", () => {
    const policy = policyWith([
      {
        kind: "work_product_present",
        workProductType: "runtime_service",
        healthStatus: "healthy",
        description: "Deployment must have a healthy health-check",
      },
    ]);
    const failures = evaluateIssueOutcomeRequirements(policy, [
      { type: "runtime_service", healthStatus: "unhealthy" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("Deployment must have a healthy health-check");
  });

  it("requires healthy when healthStatus=healthy is specified — passes when any matching is healthy", () => {
    const policy = policyWith([
      {
        kind: "work_product_present",
        workProductType: "runtime_service",
        healthStatus: "healthy",
      },
    ]);
    const failures = evaluateIssueOutcomeRequirements(policy, [
      { type: "runtime_service", healthStatus: "unhealthy" },
      { type: "runtime_service", healthStatus: "healthy" },
    ]);
    expect(failures).toEqual([]);
  });

  it("aggregates multiple failures", () => {
    const policy = policyWith([
      { kind: "work_product_present", workProductType: "runtime_service", healthStatus: "healthy" },
      { kind: "work_product_present", workProductType: "pull_request" },
    ]);
    const failures = evaluateIssueOutcomeRequirements(policy, [
      { type: "runtime_service", healthStatus: "unhealthy" },
    ]);
    expect(failures).toHaveLength(2);
  });
});
