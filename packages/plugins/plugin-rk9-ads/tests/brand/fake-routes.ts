import { readFileSync } from "node:fs";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { GraphHealth, MetaGraphClient, type GuardedWriteHook, type MetaClientMode } from "../../src/meta/graph.js";
import manifest from "../../src/manifest.js";
import { memoryOnceStore } from "../../src/features/spend-guard/support.js";
import type { BrandConfig, BrandConfigDraft } from "../../src/config.js";
import { parseBrandConfig } from "../../src/config.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const META_TOKEN = "EAAG-sentinel-meta-token-value-123";
export const BOT_TOKEN = "123456789:sentinel-bot-token-value-abcdefghij";
/** 2026-10-17 12:00 Helsinki: October has 31 days, so the G3 budget at 100 EUR is 322 cents. */
export const NOW = new Date("2026-10-17T09:00:00Z");

export type RouteReply = { status?: number; body: unknown } | Error;
export type RouteHandler = (url: URL, init: RequestInit | undefined) => RouteReply;

export interface Call {
  method: string;
  /** Graph: path after the version, e.g. `act_1/campaigns`. Telegram: `tg:<method>`. */
  key: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * A fetch that answers by route: `"GET act_1"`, `"POST act_1/campaigns"`,
 * `"tg:getMe"`. An unrouted call throws, so a test sees every request.
 */
export class FakeRoutes {
  readonly calls: Call[] = [];
  readonly routes = new Map<string, RouteHandler | RouteReply>();

  on(key: string, reply: RouteHandler | RouteReply): this {
    this.routes.set(key, reply);
    return this;
  }

  writes(): Call[] {
    return this.calls.filter((call) => call.method !== "GET" && !call.key.startsWith("tg:"));
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    let key: string;
    if (parsed.hostname === "api.telegram.org") {
      key = `tg:${parsed.pathname.split("/").pop()}`;
    } else {
      key = `${method} ${parsed.pathname.replace(/^\/v\d+\.\d+\//, "")}`;
    }
    this.calls.push({ method, key, url, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body as string | undefined });
    const route = this.routes.get(key);
    if (!route) throw new Error(`FakeRoutes: no route for ${key}`);
    const reply = typeof route === "function" ? route(parsed, init) : route;
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
}

export function graphError(code: number, message: string, subcode?: number): RouteReply {
  return { status: 400, body: { error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: "trace" } } };
}

export function tg(result: unknown): RouteReply {
  return { body: { ok: true, result } };
}

export function tgError(status: number, description: string): RouteReply {
  return { status, body: { ok: false, error_code: status, description } };
}

export function metaClient(routes: FakeRoutes, options: { mode?: MetaClientMode; guardedWrite?: GuardedWriteHook; token?: () => Promise<string> } = {}) {
  return new MetaGraphClient({
    companyId: COMPANY,
    tokenRef: { type: "secret_ref", secretId: "aaaaaaaa-0000-4000-8000-00000000000a" },
    http: { fetch: routes.fetch },
    secrets: { resolve: options.token ?? (async () => META_TOKEN) },
    health: new GraphHealth(),
    mode: options.mode ?? "readOnly",
    guardedWrite: options.guardedWrite,
    sleep: async () => undefined,
  });
}

export function loadFixtureConfig(name: "ololla" | "sunspot"): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/${name}-brand-config.json`, import.meta.url), "utf8")) as { config: Record<string, unknown> };
  return raw.config;
}

export function enabledConfig(raw: Record<string, unknown>): BrandConfig {
  const result = parseBrandConfig(raw);
  if (result.state !== "enabled") throw new Error(`expected enabled, got ${JSON.stringify(result)}`);
  return result.config;
}

export function draftConfig(raw: Record<string, unknown>): BrandConfigDraft {
  const result = parseBrandConfig(raw);
  if (result.state !== "enabled" && result.state !== "disabled") throw new Error(`expected a valid config, got ${JSON.stringify(result)}`);
  return result.config;
}

export interface Rig {
  harness: TestHarness;
  store: ReturnType<typeof memoryOnceStore>;
  issues: Array<Record<string, unknown>>;
}

/** An SDK harness whose secrets resolve the bot token and whose issue creates are recorded. */
export function rig(): Rig {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY, name: "Ololla" } as never] });
  harness.ctx.secrets.resolve = async () => BOT_TOKEN;
  const issues: Array<Record<string, unknown>> = [];
  const create = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => {
    issues.push(input as unknown as Record<string, unknown>);
    return create(input);
  };
  return { harness, store: memoryOnceStore(), issues };
}

/** Graph and Telegram answers for a brand that passes every check. */
export function happyRoutes(config: BrandConfigDraft, overrides: Record<string, RouteHandler | RouteReply> = {}): FakeRoutes {
  const act = `act_${config.meta.adAccountId}`;
  const routes = new FakeRoutes()
    .on("GET me/permissions", {
      body: { data: [{ permission: "ads_management", status: "granted" }, { permission: "ads_read", status: "granted" }, { permission: "pages_show_list", status: "granted" }] },
    })
    .on(`GET ${act}`, (url) => {
      const fields = url.searchParams.get("fields") ?? "";
      if (fields === "min_daily_budget") return { body: { id: act, min_daily_budget: 90 } };
      return { body: { id: act, currency: "EUR", timezone_name: "Europe/Helsinki", spend_cap: "10000", amount_spent: "1234", account_status: 1 } };
    })
    .on(`GET ${act}/insights`, { body: { data: [{ spend: "12.34", date_start: "2026-10-01", date_stop: "2026-10-17" }] } })
    .on(`GET ${config.meta.pageId}`, { body: { id: config.meta.pageId, name: "Page", instagram_business_account: { id: "17841400000000001" } } })
    .on(`GET ${act}/adspixels`, { body: { data: [{ id: config.meta.datasetId ?? "1", name: "Dataset" }] } })
    .on("tg:getMe", tg({ id: 42, is_bot: true, username: "rk9ads_bot" }))
    .on("tg:getChat", tg({ id: Number(config.telegram?.chatId ?? 0), type: "group", title: "Ads" }))
    .on("tg:getChatMember", tg({ status: "member", user: { id: 42 } }))
    .on("tg:sendMessage", tg({ message_id: 1, chat: { id: 1, type: "group" } }));
  for (const [key, reply] of Object.entries(overrides)) routes.on(key, reply);
  return routes;
}
