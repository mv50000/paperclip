/**
 * Feature registration model (G11).
 *
 * A feature lives in `src/features/<name>/`:
 * - `declarations.ts` holds the manifest entries (jobs, webhooks, apiRoutes,
 *   tools, UI slots). Pure data: the host imports the manifest bundle, so this
 *   file must not import worker code.
 * - `register.ts` wires the worker handlers for those entries.
 *
 * `src/manifest.ts` and `src/worker.ts` only list features
 * (`features/declarations.ts` and `features/index.ts`). A test asserts that
 * every declared job, webhook, route and tool gets a handler.
 */

import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginApiRouteDeclaration,
  PluginContext,
  PluginJobDeclaration,
  PluginToolDeclaration,
  PluginUiSlotDeclaration,
  PluginWebhookDeclaration,
  PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { Ledger } from "../db.js";

export interface FeatureDeclarations {
  /** Feature directory name. */
  key: string;
  /** Child issue that owns the implementation (epic RK9-505). */
  owner: string;
  jobs?: PluginJobDeclaration[];
  webhooks?: PluginWebhookDeclaration[];
  apiRoutes?: PluginApiRouteDeclaration[];
  tools?: PluginToolDeclaration[];
  uiSlots?: PluginUiSlotDeclaration[];
}

export type WebhookHandler = (input: PluginWebhookInput) => Promise<void>;
export type ApiRouteHandler = (input: PluginApiRequestInput) => Promise<PluginApiResponse>;
export type ConfigChangedHandler = (config: Record<string, unknown>, companyId: string | null) => Promise<void>;
export type ShutdownHandler = () => Promise<void>;

/** What a feature's `register()` receives from the worker. */
export interface FeatureRuntime {
  ctx: PluginContext;
  ledger: Ledger;
  /** Handle `onWebhook` for one declared endpointKey. */
  handleWebhook(endpointKey: string, handler: WebhookHandler): void;
  /** Handle `onApiRequest` for one declared routeKey. */
  handleApiRoute(routeKey: string, handler: ApiRouteHandler): void;
  onConfigChanged(handler: ConfigChangedHandler): void;
  onShutdown(handler: ShutdownHandler): void;
}

export interface FeatureModule {
  key: string;
  register(runtime: FeatureRuntime): Promise<void> | void;
}

/** Response for a declared route whose feature is not built yet. */
export function notImplementedResponse(owner: string): PluginApiResponse {
  return { status: 501, body: { error: `Not implemented yet (${owner})` } };
}
