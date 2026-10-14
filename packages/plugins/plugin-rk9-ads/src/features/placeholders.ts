import type { FeatureDeclarations, FeatureRuntime } from "./types.js";
import { notImplementedResponse } from "./types.js";

/**
 * Registers inert handlers for every job, webhook, route and tool a feature
 * declares, so the host never calls a missing handler before the owning child
 * ships. Jobs return without work, routes answer 501, tools return an error,
 * webhooks fail the delivery.
 * The owning child replaces the call to this function with real handlers.
 */
export function registerPlaceholders(runtime: FeatureRuntime, declarations: FeatureDeclarations): void {
  const { ctx } = runtime;
  for (const job of declarations.jobs ?? []) {
    ctx.jobs.register(job.jobKey, async () => {
      ctx.logger.debug(`rk9-ads job ${job.jobKey} is not implemented yet (${declarations.owner})`);
    });
  }
  for (const webhook of declarations.webhooks ?? []) {
    runtime.handleWebhook(webhook.endpointKey, async () => {
      // Fail the delivery: the endpoint is public and must not look accepted before it verifies anything.
      throw new Error(`rk9-ads webhook ${webhook.endpointKey} is not implemented yet (${declarations.owner})`);
    });
  }
  for (const route of declarations.apiRoutes ?? []) {
    runtime.handleApiRoute(route.routeKey, async () => notImplementedResponse(declarations.owner));
  }
  for (const tool of declarations.tools ?? []) {
    ctx.tools.register(
      tool.name,
      { displayName: tool.displayName, description: tool.description, parametersSchema: tool.parametersSchema },
      async () => ({ error: `${tool.name} is not implemented yet (${declarations.owner})` }),
    );
  }
}
