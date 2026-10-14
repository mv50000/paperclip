import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseBrandConfig } from "./config.js";
import { rememberConfigPresence } from "./company-configs.js";
import { createLedger } from "./db.js";
import { FEATURES } from "./features/index.js";
import { GRAPH_VERSION, graphHealth } from "./meta/graph.js";
import type {
  ApiRouteHandler,
  ConfigChangedHandler,
  FeatureRuntime,
  ShutdownHandler,
  WebhookHandler,
} from "./features/types.js";

interface WorkerState {
  ctx: PluginContext;
  webhooks: Map<string, WebhookHandler>;
  apiRoutes: Map<string, ApiRouteHandler>;
  configChanged: ConfigChangedHandler[];
  shutdown: ShutdownHandler[];
}

let state: WorkerState | null = null;

function createRuntime(ctx: PluginContext, current: WorkerState): FeatureRuntime {
  return {
    ctx,
    ledger: createLedger(ctx.db),
    handleWebhook(endpointKey, handler) {
      if (current.webhooks.has(endpointKey)) throw new Error(`Webhook ${endpointKey} already has a handler`);
      current.webhooks.set(endpointKey, handler);
    },
    handleApiRoute(routeKey, handler) {
      if (current.apiRoutes.has(routeKey)) throw new Error(`API route ${routeKey} already has a handler`);
      current.apiRoutes.set(routeKey, handler);
    },
    onConfigChanged(handler) {
      current.configChanged.push(handler);
    },
    onShutdown(handler) {
      current.shutdown.push(handler);
    },
  };
}

const plugin = definePlugin({
  // Every company has its own brand config.
  multiCompanyConfig: true,

  async setup(ctx) {
    const next: WorkerState = { ctx, webhooks: new Map(), apiRoutes: new Map(), configChanged: [], shutdown: [] };
    const runtime = createRuntime(ctx, next);
    for (const feature of FEATURES) {
      await feature.register(runtime);
    }
    state = next;
    ctx.logger.info("rk9-ads worker ready", { features: FEATURES.map((feature) => feature.key) });
  },

  async onHealth() {
    if (!state) return { status: "error", message: "Worker setup has not finished" };
    const graph = graphHealth.snapshot();
    if (graph.drift) {
      return {
        status: "degraded",
        message: `Meta Graph API version drift: the client pins ${GRAPH_VERSION} but Meta answered with ${graph.drift.observedVersion}. Review and bump GRAPH_VERSION in src/meta/graph.ts.`,
        details: { features: FEATURES.map((feature) => feature.key), graphDrift: graph.drift },
      };
    }
    return {
      status: "ok",
      message: "Ready. A company is enabled when it has a valid brand config; an empty config keeps it off.",
      details: { features: FEATURES.map((feature) => feature.key), graphVersion: GRAPH_VERSION },
    };
  },

  async onValidateConfig(config) {
    const result = parseBrandConfig(config);
    if (result.state === "absent") {
      return { ok: true, warnings: ["Config is empty: the plugin stays off for this company."] };
    }
    if (result.state === "invalid") return { ok: false, errors: result.errors };
    return { ok: true };
  },

  async onConfigChanged(config, context) {
    const companyId = context?.companyId ?? null;
    if (companyId && state) {
      try {
        await rememberConfigPresence(state.ctx, companyId, config);
      } catch (error) {
        state.ctx.logger.warn("rk9-ads: could not record config marker", {
          companyId,
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      }
    }
    for (const handler of state?.configChanged ?? []) {
      await handler(config, context?.companyId ?? null);
    }
  },

  async onShutdown() {
    for (const handler of state?.shutdown ?? []) {
      await handler();
    }
  },

  async onWebhook(input) {
    const handler = state?.webhooks.get(input.endpointKey);
    if (!handler) throw new Error(`No handler for webhook ${input.endpointKey}`);
    await handler(input);
  },

  async onApiRequest(input) {
    const handler = state?.apiRoutes.get(input.routeKey);
    if (!handler) return { status: 404, body: { error: `Unknown route ${input.routeKey}` } };
    return handler(input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
