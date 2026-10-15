import { parseBrandConfig, type BrandConfig } from "../../src/config.js";
import type { MetaClientMode, MetaClientOptions } from "../../src/meta/graph.js";
import { brandConfig } from "../fixtures.js";
import { FakeGraph, makeClient } from "../meta/fake-graph.js";
import type { FakeMeta } from "./fake-meta.js";

export function config(overrides: Record<string, unknown> = {}): BrandConfig {
  const parsed = parseBrandConfig(brandConfig(overrides));
  if (parsed.state !== "enabled") throw new Error(`test config invalid: ${JSON.stringify(parsed)}`);
  return parsed.config;
}

export function metaClient(meta: FakeMeta, mode: MetaClientMode = "readOnly", overrides: Partial<MetaClientOptions> = {}) {
  return makeClient(new FakeGraph(), { http: { fetch: meta.fetch }, mode, ...overrides }).client;
}

/** UTC instant from an ISO string. */
export function at(iso: string): Date {
  return new Date(iso);
}
