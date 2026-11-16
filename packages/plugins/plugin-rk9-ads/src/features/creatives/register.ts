import type { PluginPerformActionContext, ToolResult } from "@paperclipai/plugin-sdk";
import { stageCreative, type StageInitiator, type StageResult } from "../../creative-manifest/ingress.js";
import { registerPlaceholders } from "../placeholders.js";
import type { FeatureRuntime } from "../types.js";
import { creativesDeclarations } from "./declarations.js";
import { getInsightsTool, listAdsTool } from "./read-tools.js";

export const STAGE_CREATIVE_TOOL = "rk9ads_stage_creative";
export const STAGE_CREATIVE_ROUTE = "stage-creative";
/**
 * The action twin of the tool (RK9-910): a host-side run (rk9-motion) holds an
 * agent key but no heartbeat run, so it cannot call the tool.
 */
export const STAGE_CREATIVE_ACTION_KEY = "stage-creative";

/** Tools this feature implements. Any other tool still declared here keeps its placeholder. */
const IMPLEMENTED_TOOLS = new Set([STAGE_CREATIVE_TOOL, "rk9ads_list_ads", "rk9ads_get_insights"]);

function manifestOf(input: unknown): unknown {
  return typeof input === "object" && input !== null ? (input as { manifest?: unknown }).manifest : undefined;
}

/** The tool returns the route's response body as `data`, so both callers see the same shape. */
export function stageResultToTool(result: StageResult): ToolResult {
  const content = JSON.stringify(result.body);
  if ("error" in result.body) {
    const { code, path, message } = result.body.error;
    return { error: `${code}${path ? ` at ${path}` : ""}: ${message}`, content, data: result.body };
  }
  return { content, data: result.body };
}

/**
 * The initiator of an action call, from the host's actor context only. A
 * system actor (no agent, no board user) is refused: the tool serves agents
 * and the route serves agents and board users, so the action serves the same.
 */
export function actionInitiator(context: PluginPerformActionContext): StageInitiator {
  const { actor } = context;
  if (actor.type === "agent" && actor.agentId) {
    return { source: "agent", agentId: actor.agentId, userId: null, runId: actor.runId ?? null };
  }
  if (actor.type === "user" && actor.userId) {
    return { source: "board", agentId: null, userId: actor.userId, runId: actor.runId ?? null };
  }
  throw new Error("forbidden: stage-creative needs an agent key or a board user");
}

export function register(runtime: FeatureRuntime): void {
  const { ctx, ledger } = runtime;
  const tool = (name: string) => creativesDeclarations.tools!.find((declaration) => declaration.name === name)!;
  const describe = (name: string) => {
    const declaration = tool(name);
    return { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema };
  };

  // The company is the agent run's own company; the host checks the run belongs to it.
  ctx.tools.register(STAGE_CREATIVE_TOOL, describe(STAGE_CREATIVE_TOOL), async (params, runContext) =>
    stageResultToTool(
      await stageCreative({ ctx, ledger }, runContext.companyId, manifestOf(params), {
        source: "agent",
        agentId: runContext.agentId ?? null,
        userId: null,
        runId: runContext.runId ?? null,
      }),
    ),
  );

  // The company is `context.companyId`: the host checked the caller's access to
  // it (an agent key reaches only its own company) and wrote it over
  // `params.companyId`. A differing `params.companyId` is refused all the same.
  // The action returns the route's `{ status, body }`, so a staging error
  // keeps its code, path and creative.
  ctx.actions.register(STAGE_CREATIVE_ACTION_KEY, async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new Error("company context is required");
    if (params.companyId !== undefined && params.companyId !== companyId) {
      throw new Error("invalid_request: params.companyId must name the resolved company");
    }
    const initiator = actionInitiator(context);
    const result = await stageCreative({ ctx, ledger }, companyId, manifestOf(params), initiator);
    return { status: result.status, body: result.body };
  });
  ctx.tools.register("rk9ads_list_ads", describe("rk9ads_list_ads"), async (params, runContext) =>
    listAdsTool({ ctx }, runContext.companyId, params),
  );
  ctx.tools.register("rk9ads_get_insights", describe("rk9ads_get_insights"), async (params, runContext) =>
    getInsightsTool({ ctx }, runContext.companyId, params),
  );

  // `input.companyId` is body.companyId after the host's company access check
  // (an agent key only reaches its own company).
  runtime.handleApiRoute(STAGE_CREATIVE_ROUTE, async (input) => {
    const bodyCompanyId = (input.body as { companyId?: unknown } | null)?.companyId;
    if (bodyCompanyId !== input.companyId) {
      return { status: 400, body: { error: { code: "invalid_request", message: "body.companyId must name the resolved company" } } };
    }
    const result = await stageCreative({ ctx, ledger }, input.companyId, manifestOf(input.body));
    return { status: result.status, body: result.body };
  });

  registerPlaceholders(runtime, {
    ...creativesDeclarations,
    apiRoutes: [],
    tools: (creativesDeclarations.tools ?? []).filter((declaration) => !IMPLEMENTED_TOOLS.has(declaration.name)),
  });
}
