import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  KNOWLEDGE_CHAR_CAP,
  MAX_FACTS,
  buildKnowledgeContext,
  deriveRecallQuery,
  estimateTokens,
  parseKnowledgeRecallConfig,
  renderKnowledgeSection,
  type RecallFn,
} from "./knowledge-injection.js";
import type { RecallResult, RecallSnippet } from "./knowledge-recall.js";

// buildKnowledgeContext calls logActivity(db, ...) best-effort; a stub db that rejects is fine
// because the service swallows activity-log failures. recall is injected so no DB/qmd is needed.
const stubDb = {} as unknown as Db;

function snippet(over: Partial<RecallSnippet> = {}): RecallSnippet {
  return {
    sourcePath: "qmd://rk9/projects/a.md",
    title: "A fact",
    score: 0.8,
    collection: "rk9",
    snippet: "some useful fact body",
    ...over,
  };
}

function recallReturning(snippets: RecallSnippet[], extra: Partial<RecallResult> = {}): RecallFn {
  return (async () => ({ snippets, collections: ["rk9", "shared"], timedOut: false, ...extra })) as unknown as RecallFn;
}

const baseAgent = { id: "agent-1", companyId: "company-1", role: "ceo", name: "CEO" };

describe("parseKnowledgeRecallConfig", () => {
  it("defaults to disabled for missing/invalid config", () => {
    expect(parseKnowledgeRecallConfig(undefined)).toEqual({ enabled: false });
    expect(parseKnowledgeRecallConfig({})).toEqual({ enabled: false });
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: {} })).toEqual({ enabled: false });
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: { enabled: "yes" } })).toEqual({ enabled: false });
  });
  it("reads enabled + optional query + clamped limit", () => {
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: { enabled: true } })).toEqual({ enabled: true });
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: { enabled: true, query: "  foo  ", limit: 3 } })).toEqual({
      enabled: true,
      query: "foo",
      limit: 3,
    });
  });
  it("clamps limit to MAX_FACTS and ignores non-positive", () => {
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: { enabled: true, limit: 99 } }).limit).toBe(MAX_FACTS);
    expect(parseKnowledgeRecallConfig({ knowledgeRecall: { enabled: true, limit: 0 } }).limit).toBeUndefined();
  });
});

describe("deriveRecallQuery", () => {
  it("uses an explicit override when provided", () => {
    expect(deriveRecallQuery(baseAgent, "explicit q")).toBe("explicit q");
  });
  it("maps known roles (incl. Finnish) to topic queries", () => {
    expect(deriveRecallQuery({ ...baseAgent, role: "CEO" })).toMatch(/strategy/);
    expect(deriveRecallQuery({ ...baseAgent, role: "CFO Kirjanpitäjä" })).toMatch(/bookkeeping/);
    expect(deriveRecallQuery({ ...baseAgent, role: "Hallinto Lakiasiat" })).toMatch(/GDPR/);
    expect(deriveRecallQuery({ ...baseAgent, role: "Talousanalyytikko" })).toMatch(/KPIs/);
  });
  it("falls back to role+name then a generic query", () => {
    expect(deriveRecallQuery({ ...baseAgent, role: "Widget Wrangler", name: "Bob" })).toBe("Widget Wrangler Bob");
    expect(deriveRecallQuery({ id: "x", companyId: "c", role: null, name: null })).toMatch(/company goals/);
  });
});

describe("renderKnowledgeSection", () => {
  it("renders up to maxFacts entries with title + source + body", () => {
    const md = renderKnowledgeSection(
      [snippet({ title: "T1" }), snippet({ title: "T2" }), snippet({ title: "T3" })],
      2,
      KNOWLEDGE_CHAR_CAP,
    );
    expect(md).toContain("## Knowledge Context");
    expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
    expect(md).toContain("**T1**");
    expect(md).toContain("qmd://rk9/projects/a.md");
  });
  it("collapses qmd diff markers + whitespace in the snippet body", () => {
    const md = renderKnowledgeSection([snippet({ snippet: "@@ -1,4 @@ (ctx)\n\n  multi   line   body  " })], 5, KNOWLEDGE_CHAR_CAP);
    expect(md).toContain("multi line body");
    expect(md).not.toContain("@@");
  });
  it("stops at the character cap and never exceeds it", () => {
    const big = snippet({ snippet: "x".repeat(900) });
    const md = renderKnowledgeSection([big, big, big, big, big], 5, 1000);
    const bodyChars = md.split("\n").filter((l) => l.startsWith("- ")).join("").length;
    expect(bodyChars).toBeLessThanOrEqual(1000);
    // at least one fact still renders even if a single fact is large
    expect(md.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThanOrEqual(1);
  });
  it("returns empty string for no snippets", () => {
    expect(renderKnowledgeSection([], 5, KNOWLEDGE_CHAR_CAP)).toBe("");
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens(2000)).toBe(500);
    expect(estimateTokens(1)).toBe(1);
  });
});

describe("buildKnowledgeContext", () => {
  const enabledAgent = { ...baseAgent, runtimeConfig: { knowledgeRecall: { enabled: true } } };

  it("returns null when the global kill-switch is off (recall never called)", async () => {
    const recall = vi.fn(recallReturning([snippet()]));
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: enabledAgent, globalEnabled: false, runId: "run-1" },
      { recall },
    );
    expect(res).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it("returns null when the agent has not opted in (recall never called)", async () => {
    const recall = vi.fn(recallReturning([snippet()]));
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: { ...baseAgent, runtimeConfig: {} }, globalEnabled: true, runId: "run-1" },
      { recall },
    );
    expect(res).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it("injects scoped facts when both gates are on, passing the agent's companyId to recall", async () => {
    const recall = vi.fn(recallReturning([snippet({ title: "Scoped" })]));
    let t = 1000;
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: enabledAgent, globalEnabled: true, runId: "run-1" },
      { recall, now: () => (t += 5) },
    );
    expect(res).not.toBeNull();
    expect(res!.markdown).toContain("**Scoped**");
    expect(res!.factCount).toBe(1);
    expect(res!.injectedTokenEstimate).toBeGreaterThan(0);
    // company scoping is enforced inside recall — assert we hand it the agent's own companyId only
    const callArgs = recall.mock.calls[0][1];
    expect(callArgs.companyId).toBe("company-1");
    expect(callArgs.agentId).toBe("agent-1");
    expect(callArgs.runId).toBe("run-1");
  });

  it("caps injected tokens to the ~500-token budget even with many large facts", async () => {
    const big = snippet({ snippet: "x".repeat(2000) });
    const recall = recallReturning([big, big, big, big, big]);
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: enabledAgent, globalEnabled: true, runId: "run-1" },
      { recall },
    );
    expect(res).not.toBeNull();
    expect(res!.injectedTokenEstimate).toBeLessThanOrEqual(estimateTokens(KNOWLEDGE_CHAR_CAP) + 200);
  });

  it("returns null (never throws) when recall throws", async () => {
    const recall = (async () => {
      throw new Error("qmd boom");
    }) as unknown as RecallFn;
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: enabledAgent, globalEnabled: true, runId: "run-1" },
      { recall },
    );
    expect(res).toBeNull();
  });

  it("returns null when recall yields no in-scope snippets", async () => {
    const recall = recallReturning([]);
    const res = await buildKnowledgeContext(
      stubDb,
      { agent: enabledAgent, globalEnabled: true, runId: "run-1" },
      { recall },
    );
    expect(res).toBeNull();
  });

  it("honors a per-agent query override + limit", async () => {
    const recall = vi.fn(recallReturning([snippet(), snippet(), snippet()]));
    await buildKnowledgeContext(
      stubDb,
      {
        agent: { ...baseAgent, runtimeConfig: { knowledgeRecall: { enabled: true, query: "custom", limit: 2 } } },
        globalEnabled: true,
        runId: "run-1",
      },
      { recall },
    );
    const callArgs = recall.mock.calls[0][1];
    expect(callArgs.query).toBe("custom");
    expect(callArgs.limit).toBe(2);
  });
});
