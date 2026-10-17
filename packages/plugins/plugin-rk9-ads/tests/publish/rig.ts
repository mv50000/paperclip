/**
 * Test rig for the publish service (A8, RK9-514): a route-based fake Graph,
 * a fake clock, memory stores and a captured activity log.
 */

import { memoryBindingStore } from "../../src/brand/provision.js";
import type { BrandConfig } from "../../src/config.js";
import { memoryOnceStore } from "../../src/features/spend-guard/support.js";
import { GraphHealth, MetaGraphClient, type GuardedWriteHook } from "../../src/meta/graph.js";
import type { PublishedPublication } from "../../src/publish/handoff.js";
import { createPublishService, type PublishServiceDeps } from "../../src/publish/publish-service.js";
import { memoryCreativeSource, memoryPublicationStore, type CreativeRow } from "../../src/publish/store.js";
import { COMPANY, enabledConfig, FakeRoutes, loadFixtureConfig, META_TOKEN, NOW, type Call } from "../brand/fake-routes.js";

export { COMPANY, META_TOKEN, NOW };

export const ADSET = "120200000000000201";
export const CAMPAIGN = "120200000000000101";
export const IG_USER = "17841400000000001";
export const CREATIVE_IMAGE = "c0000000-0000-4000-8000-000000000001";
export const CREATIVE_VIDEO = "c0000000-0000-4000-8000-000000000002";
export const SHA = "a".repeat(64);
export const SHA_VIDEO = "b".repeat(64);

export function olollaConfig(overrides: { igUserId?: string } = {}): BrandConfig {
  const raw = loadFixtureConfig("ololla") as { meta: Record<string, unknown> } & Record<string, unknown>;
  return enabledConfig({ ...raw, meta: { ...raw.meta, ...(overrides.igUserId ? { igUserId: overrides.igUserId } : {}) } });
}

export function imageCreative(overrides: Partial<CreativeRow> = {}): CreativeRow & { companyId: string } {
  return {
    companyId: COMPANY,
    id: CREATIVE_IMAGE,
    brand: "OLL",
    kind: "image",
    status: "ready",
    sha256: SHA,
    mediaUrl: "https://media.ololla.fi/syksy-4x5.jpg",
    posterUrl: null,
    aspectRatio: "4:5",
    copy: { message: "Syksyn parhaat mökit Ollolassa.", title: "Varaa syysloma", description: "ololla.fi" },
    cta: "LEARN_MORE",
    landingUrlKey: "home",
    utmCampaign: "syksy-2026",
    targetAdsetId: null,
    validUntil: "2026-12-31T00:00:00.000Z",
    metaVideoId: null,
    ...overrides,
  };
}

export function videoCreative(overrides: Partial<CreativeRow> = {}): CreativeRow & { companyId: string } {
  return imageCreative({
    id: CREATIVE_VIDEO,
    kind: "video",
    status: "staged",
    sha256: SHA_VIDEO,
    mediaUrl: "https://media.ololla.fi/syksy-9x16.mp4",
    posterUrl: "https://media.ololla.fi/syksy-9x16-poster.jpg",
    aspectRatio: "9:16",
    ...overrides,
  });
}

/** A live client on the fake routes with a fake clock that `sleep` advances. */
export function liveClient(routes: FakeRoutes, clock: { now: number }, guardedWrite?: GuardedWriteHook): MetaGraphClient {
  return new MetaGraphClient({
    companyId: COMPANY,
    tokenRef: { type: "secret_ref", secretId: "aaaaaaaa-0000-4000-8000-00000000000a" },
    http: { fetch: routes.fetch },
    secrets: { resolve: async () => META_TOKEN },
    health: new GraphHealth(),
    mode: "live",
    ...(guardedWrite ? { guardedWrite } : {}),
    sleep: async (ms) => {
      clock.now += ms;
    },
    now: () => clock.now,
  });
}

/** Graph answers for a happy publish of either kind. Override per test. */
export function publishRoutes(config: BrandConfig): FakeRoutes {
  const act = `act_${config.meta.adAccountId}`;
  return new FakeRoutes()
    .on(`POST ${act}/advideos`, { body: { id: "9001" } })
    .on("GET 9001", { body: { id: "9001", status: { video_status: "ready" } } })
    .on("GET 9001/thumbnails", {
      body: {
        data: [
          { id: "111", uri: "https://scontent.example.fbcdn.net/thumb-a.jpg", is_preferred: false },
          { id: "112", uri: "https://scontent.example.fbcdn.net/thumb-b.jpg", is_preferred: true },
        ],
      },
    })
    .on(`POST ${act}/adcreatives`, { body: { id: "7001" } })
    .on(`GET ${ADSET}/ads`, { body: { data: [] } })
    .on(`POST ${act}/ads`, { body: { id: "5001" } })
    .on("DELETE 7001", { body: { success: true } });
}

export interface ServiceRig {
  config: BrandConfig;
  routes: FakeRoutes;
  clock: { now: number };
  store: ReturnType<typeof memoryPublicationStore>;
  creatives: ReturnType<typeof memoryCreativeSource>;
  once: ReturnType<typeof memoryOnceStore>;
  activity: Array<{ companyId: string; message: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }>;
  handoffs: PublishedPublication[];
  service: ReturnType<typeof createPublishService>;
}

export function serviceRig(options: { config?: BrandConfig; creatives?: Array<CreativeRow & { companyId: string }>; routes?: FakeRoutes; deps?: Partial<PublishServiceDeps> } = {}): ServiceRig {
  const config = options.config ?? olollaConfig();
  const routes = options.routes ?? publishRoutes(config);
  const clock = { now: NOW.getTime() };
  const store = memoryPublicationStore();
  const creatives = memoryCreativeSource(options.creatives ?? [imageCreative(), videoCreative()]);
  const bindings = memoryBindingStore();
  bindings.rows.set(`${COMPANY}|${config.brandCode}`, { campaignId: CAMPAIGN, adSetId: ADSET, adAccountId: config.meta.adAccountId, source: "provisioned" });
  const once = memoryOnceStore();
  const activity: ServiceRig["activity"] = [];
  const handoffs: PublishedPublication[] = [];
  const service = createPublishService({
    ctx: {
      activity: { log: async (entry) => void activity.push(entry) },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    store,
    creatives,
    bindings,
    once,
    now: () => new Date(clock.now),
    loadConfig: async () => ({ ok: true, config }),
    writeClient: () => liveClient(routes, clock),
    readClient: () => liveClient(routes, clock),
    onPublished: async (publication) => void handoffs.push(publication),
    video: { pollIntervalMs: 5_000, timeoutMs: 60_000, thumbnailRetryMs: 5_000 },
    ...options.deps,
  });
  return { config, routes, clock, store, creatives, once, activity, handoffs, service };
}

export const UI = { source: "ui" as const, userId: "user-1" };

/** Decoded form body of a recorded write. */
export function formOf(call: Call): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(call.body ?? "")) {
    try {
      out[key] = value.startsWith("{") || value.startsWith("[") ? JSON.parse(value) : value;
    } catch {
      out[key] = value;
    }
  }
  return out;
}
