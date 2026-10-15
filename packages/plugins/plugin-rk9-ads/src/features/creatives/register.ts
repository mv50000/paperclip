import type { ToolResult } from "@paperclipai/plugin-sdk";
import { stageCreative, type StageResult } from "../../creative-manifest/ingress.js";
import { registerPlaceholders } from "../placeholders.js";
import type { FeatureRuntime } from "../types.js";
import { creativesDeclarations } from "./declarations.js";
import { getInsightsTool, listAdsTool } from "./read-tools.js";

export const STAGE_CREATIVE_TOOL = "rk9ads_stage_creative";
export const STAGE_CREATIVE_ROUTE = "stage-creative";

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

export function register(runtime: FeatureRuntime): void {
  const { ctx, ledger } = runtime;
  const tool = (name: string) => creativesDeclarations.tools!.find((declaration) => declaration.name === name)!;
  const describe = (name: string) => {
    const declaration = tool(name);
    return { displayName: declaration.displayName, description: declaration.description, parametersSchema: declaration.parametersSchema };
  };

  // The company is the agent run's own company; the host checks the run belongs to it.
  ctx.tools.register(STAGE_CREATIVE_TOOL, describe(STAGE_CREATIVE_TOOL), async (params, runContext) =>
    stageResultToTool(await stageCreative({ ctx, ledger }, runContext.companyId, manifestOf(params))),
  );
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
