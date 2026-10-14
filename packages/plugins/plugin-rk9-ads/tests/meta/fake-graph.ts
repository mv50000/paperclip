import { readFileSync } from "node:fs";
import { GraphHealth, MetaGraphClient, type MetaClientOptions } from "../../src/meta/graph.js";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const TOKEN_REF = { type: "secret_ref" as const, secretId: "aaaaaaaa-0000-4000-8000-00000000000a" };
/** A token that does not look like a Meta token, so only the known-value layer can catch it. */
export const SENTINEL_TOKEN = "sentinel-tok_7f3a9c+e/41==";
export const ACT = "act_1336862981968191";

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** Loads tests/fixtures/meta/<name>.json and plants `token` where the fixture says __TOKEN__. */
export function fixture(name: string, token = SENTINEL_TOKEN): FixtureResponse {
  const raw = readFileSync(new URL(`../fixtures/meta/${name}.json`, import.meta.url), "utf8");
  const parsed = JSON.parse(raw.replaceAll("__TOKEN__", token)) as FixtureResponse & { source?: string };
  return { status: parsed.status, headers: parsed.headers, body: parsed.body };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake `http.fetch` that serves fixtures in order and records every call. */
export class FakeGraph {
  readonly calls: RecordedCall[] = [];
  private readonly queue: Array<FixtureResponse | Error>;

  constructor(...responses: Array<FixtureResponse | Error>) {
    this.queue = [...responses];
  }

  push(...responses: Array<FixtureResponse | Error>): void {
    this.queue.push(...responses);
  }

  get nonGetCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body,
    });
    const next = this.queue.shift();
    if (!next) throw new Error(`FakeGraph: no response queued for ${init?.method ?? "GET"} ${url}`);
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  };
}

export interface Captured {
  logs: Array<{ level: string; message: string; meta?: unknown }>;
  activity: unknown[];
  resolves: Array<{ companyId?: string; configPath?: string }>;
  sleeps: number[];
}

export function makeClient(graph: FakeGraph, overrides: Partial<MetaClientOptions> = {}) {
  const captured: Captured = { logs: [], activity: [], resolves: [], sleeps: [] };
  let now = 0;
  const client = new MetaGraphClient({
    companyId: COMPANY,
    tokenRef: TOKEN_REF,
    http: { fetch: graph.fetch },
    secrets: {
      resolve: async (_ref, options) => {
        captured.resolves.push({ companyId: options?.companyId, configPath: options?.configPath });
        return SENTINEL_TOKEN;
      },
    },
    logger: {
      info: (message, meta) => void captured.logs.push({ level: "info", message, meta }),
      warn: (message, meta) => void captured.logs.push({ level: "warn", message, meta }),
    },
    activity: { log: async (entry) => void captured.activity.push(entry) },
    health: new GraphHealth(),
    sleep: async (ms) => {
      captured.sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    ...overrides,
  });
  return { client, captured };
}
