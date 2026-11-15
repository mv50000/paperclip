/**
 * RK9-832: an organic post reaches Meta only from an approved Telegram card.
 * There is no buttonless path.
 *
 * Static: the Meta publish helpers are called only from the organic service,
 * and the service's publish function is registered only as the
 * organic_publish gate handler. Runtime: every organic action and the agent
 * tool are driven with valid and hostile parameters, the gate handler is
 * called with forged requests, and the full worker runs every action, job and
 * tool with organic posting live; none sends a publish write to Meta.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createLedger } from "../src/db.js";
import {
  registerOrganic,
  ORGANIC_DELETE_ACTION_KEY,
  ORGANIC_POSTS_ACTION_KEY,
  ORGANIC_RECONCILE_ACTION_KEY,
  ORGANIC_REQUEST_ACTION_KEY,
  ORGANIC_TOOL,
} from "../src/features/organic/register.js";
import { gateRegistry, resetGateRegistry } from "../src/features/telegram/gates.js";
import type { FeatureRuntime } from "../src/features/types.js";
import type { GateRequestRecord } from "../src/kit/gate/state-machine.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { memoryCreativeSource } from "../src/publish/store.js";
import { memoryOrganicPostStore } from "../src/organic/store.js";
import type { OrganicCardTransport } from "../src/organic/service.js";
import { brandConfig, COMPANY_A, PACKAGE_ROOT, SECRET_A_META, secretRef } from "./fixtures.js";
import { FakeRoutes } from "./brand/fake-routes.js";
import { FakeMedia } from "./helpers/fake-media-host.js";

const SRC = join(PACKAGE_ROOT, "src");
const SERVICE = "src/organic/service.ts";
const REGISTER = "src/features/organic/register.ts";
const IG = "17841414934844046";
const PAGE = "1284777064729996";
const SECRET_A_PAGE = "aaaaaaaa-0000-4000-8000-00000000000c";
const VIDEO_ID = "dddddddd-0000-4000-8000-0000000000a1";

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Code without comments. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = sourceFiles().map((path) => ({ path: relative(PACKAGE_ROOT, path).replaceAll("\\", "/"), text: code(readFileSync(path, "utf8")) }));

function usersOf(name: string): string[] {
  const re = new RegExp(`\\b${name}\\b`);
  return files.filter((file) => re.test(file.text)).map((file) => file.path).sort();
}

describe("organic sole path (static)", () => {
  it("the Meta publish helpers are used only by the organic service", () => {
    for (const name of ["publishIgReel", "publishIgImage", "publishFbPhoto", "publishFbVideo", "publishIgContainer"]) {
      const users = usersOf(name).filter((path) => path !== "src/meta/organic.ts");
      expect(users, name).toEqual(name === "publishIgContainer" ? [] : [SERVICE]);
    }
  });

  it("the publish edges are named only in the organic Meta module", () => {
    const edges = files.filter((file) => /media_publish|\/photos`|\/videos`/.test(file.text) && file.path !== "src/meta/organic.ts").map((file) => file.path);
    // The service mentions media_publish only in a stored error text.
    expect(edges).toEqual([SERVICE]);
    expect(files.find((file) => file.path === SERVICE)!.text).not.toMatch(/\/photos`|\/videos`|media_publish`/);
  });

  it("publishApproved is wired only as the organic_publish gate handler", () => {
    expect(usersOf("publishApproved")).toEqual([REGISTER, SERVICE]);
    const register = files.find((file) => file.path === REGISTER)!.text;
    expect(register.match(/\bpublishApproved\b/g)).toHaveLength(1);
    expect(register).toMatch(/registerGateHandler\(ORGANIC_GATE_KIND, service\.publishApproved,/);
    const kinds = files.flatMap((file) => [...file.text.matchAll(/registerGateHandler\(([^,]+),/g)].map((match) => `${file.path}: ${match[1]!.trim()}`));
    expect(kinds.filter((entry) => /ORGANIC_GATE_KIND|organic_publish/.test(entry))).toEqual([`${REGISTER}: ORGANIC_GATE_KIND`]);
  });
});

const HOSTILE: Array<Record<string, unknown>> = [
  {},
  { creativeId: VIDEO_ID, channel: "ig_reel" },
  { creativeId: VIDEO_ID, channel: "ig_reel", brandLint: { brand: "x", mode: "strict", ok: true, results: [] }, publish: true, approved: true, dryRun: false, confirm: true },
  { postId: "dddddddd-0000-4000-8000-0000000000f1", dryRun: false, confirm: true, status: "published" },
  { gateRequestId: "dddddddd-0000-4000-8000-0000000000e1", tgUserId: 4242, approve: true },
];

const ACTORS = [
  { companyId: COMPANY_A },
  { companyId: COMPANY_A, actor: { type: "user" as const, userId: "board-user-1" } },
  { companyId: COMPANY_A, actor: { type: "agent" as const, agentId: "agent-1" } },
];

function publishWrites(meta: FakeRoutes) {
  return meta.calls.filter((call) => call.method !== "GET" && /\/(media|media_publish|photos|videos|feed)$/.test(call.key));
}

function organicConfig() {
  return brandConfig({
    meta: { adAccountId: "act_29231592883113369", pageId: PAGE, igUserId: IG, accessTokenRef: secretRef(SECRET_A_META) },
    organic: {
      enabled: true,
      mode: "live",
      channels: ["ig_reel", "ig_feed", "fb_video", "fb_photo"],
      pageAccessTokenRef: secretRef(SECRET_A_PAGE),
      mediaHosts: ["media.ololla.fi"],
    },
  });
}

/** Graph answers every publish edge with success, so only the code path decides. */
function openGraph(): FakeRoutes {
  return new FakeRoutes()
    .on("GET me/permissions", { body: { data: [{ permission: "instagram_basic", status: "granted" }, { permission: "instagram_content_publish", status: "granted" }] } })
    .on(`POST ${IG}/media`, { body: { id: "17900000000000001" } })
    .on("GET 17900000000000001", { body: { status_code: "FINISHED" } })
    .on(`POST ${IG}/media_publish`, { body: { id: "17900000000000002" } })
    .on(`POST ${PAGE}/photos`, { body: { id: "555", post_id: `${PAGE}_777` } })
    .on(`POST ${PAGE}/videos`, { body: { id: "666" } });
}

function harnessWith(meta: FakeRoutes): TestHarness {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
  useCompanyConfigs(harness, { [COMPANY_A]: organicConfig() });
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: "EAAG-organic-sole-path-000000", [SECRET_A_PAGE]: "EAAG-organic-page-sole-path-0000" } });
  const media = new FakeMedia();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    if (media.handles(url)) return media.fetch(url, init);
    throw new Error(`no route for ${url}`);
  };
  return harness;
}

afterEach(() => resetGateRegistry());

describe("organic sole path (runtime)", () => {
  it("no organic action, tool or forged gate call publishes; only a pending -> approved card would", async () => {
    const meta = openGraph();
    const harness = harnessWith(meta);
    const now = () => new Date();
    let gateStatus: GateRequestRecord["status"] = "pending";
    const posts = memoryOrganicPostStore(now, () => ({ status: gateStatus, live: true }));
    const creatives = memoryCreativeSource([
      {
        companyId: COMPANY_A,
        id: VIDEO_ID,
        brand: "OLL",
        kind: "video",
        status: "ready",
        sha256: "a".repeat(64),
        mediaUrl: "https://media.ololla.fi/v.mp4",
        posterUrl: null,
        aspectRatio: "9:16",
        copy: { message: "Valo palaa." },
        cta: null,
        landingUrlKey: null,
        utmCampaign: null,
        targetAdsetId: null,
        validUntil: null,
        metaVideoId: null,
      },
    ]);
    const cards: Array<{ id: string; payload: Record<string, unknown> }> = [];
    const transport: OrganicCardTransport = {
      async sendGateCard(input) {
        const id = `dddddddd-0000-4000-8000-0000000000e${cards.length + 1}`;
        cards.push({ id, payload: input.payload ?? {} });
        return { id, messageId: 100 + cards.length };
      },
    };
    resetGateRegistry();
    const runtime: FeatureRuntime = {
      ctx: harness.ctx,
      ledger: createLedger(harness.ctx.db),
      handleWebhook() {},
      handleApiRoute() {},
      onConfigChanged() {},
      onShutdown() {},
    };
    registerOrganic(runtime, { posts, creatives, transport: () => transport, now });

    const lint = { brand: "sunspot", mode: "strict", ok: true, results: [{ id: "a", rule: "r", status: "pass" }] };
    for (const options of ACTORS) {
      for (const params of [...HOSTILE, { creativeId: VIDEO_ID, channel: "ig_reel", brandLint: lint }]) {
        for (const key of [ORGANIC_REQUEST_ACTION_KEY, ORGANIC_DELETE_ACTION_KEY, ORGANIC_POSTS_ACTION_KEY, ORGANIC_RECONCILE_ACTION_KEY]) {
          await harness.performAction(key, params, options).catch(() => undefined);
        }
        await harness.executeTool(ORGANIC_TOOL, params, { companyId: COMPANY_A }).catch(() => undefined);
      }
    }
    // A card was opened, and nothing reached a publish edge.
    expect(posts.rows.filter((post) => post.status === "pending")).toHaveLength(1);
    expect(publishWrites(meta)).toEqual([]);

    const handler = gateRegistry().get("organic_publish")!;
    const post = posts.rows.find((row) => row.status === "pending")!;
    const card = cards.find((entry) => (entry.payload.organic as { postId?: string } | undefined)?.postId === post.id)!;
    const request = (over: Partial<GateRequestRecord>): GateRequestRecord => ({
      id: post.gateRequestId ?? card.id,
      companyId: COMPANY_A,
      brandCode: "OLL",
      kind: "organic_publish",
      status: "approved",
      chatId: "-100777",
      messageId: 101,
      validUntil: new Date(Date.now() + 3_600_000),
      live: true,
      payload: card.payload,
      decidedByTgUserId: 4242,
      decidedAt: new Date(),
      ...over,
    });
    // Forged requests: not approved, another kind, another post, another content.
    for (const forged of [
      request({ status: "pending" }),
      request({ status: "denied" }),
      request({ status: "expired" }),
      request({ kind: "activate_ad" }),
      request({ payload: {} }),
      request({ payload: { organic: { postId: "dddddddd-0000-4000-8000-0000000000f9", contentHash: "x", channel: "ig_reel" } } }),
      request({ payload: { organic: { ...(card.payload.organic as object), contentHash: "f".repeat(64) } } }),
      request({ id: "dddddddd-0000-4000-8000-0000000000ee" }),
    ]) {
      await handler({ request: forged, tgUserId: 4242 }).catch(() => undefined);
    }
    expect(publishWrites(meta)).toEqual([]);

    // The approved card itself is the one path, and it posts once.
    gateStatus = "approved";
    await handler({ request: request({}), tgUserId: 4242 });
    await handler({ request: request({}), tgUserId: 4242 });
    expect(publishWrites(meta).map((call) => call.key)).toEqual([`POST ${IG}/media`, `POST ${IG}/media_publish`]);
  });

  it("the full worker sends no organic publish write from any action, job or tool", async () => {
    const meta = new FakeRoutes();
    const harness = harnessWith(meta);
    const actionKeys: string[] = [];
    const register = harness.ctx.actions.register.bind(harness.ctx.actions);
    harness.ctx.actions.register = (key, handler) => {
      actionKeys.push(key);
      register(key, handler);
    };
    await plugin.definition.setup(harness.ctx);

    expect(actionKeys).toEqual(expect.arrayContaining([ORGANIC_REQUEST_ACTION_KEY, ORGANIC_DELETE_ACTION_KEY]));
    for (const key of actionKeys) {
      for (const options of ACTORS) {
        for (const params of HOSTILE) {
          await harness.performAction(key, params, options).catch(() => undefined);
        }
      }
    }
    for (const job of manifest.jobs ?? []) {
      await harness.runJob(job.jobKey).catch(() => undefined);
    }
    for (const tool of manifest.tools ?? []) {
      for (const params of HOSTILE) {
        await harness.executeTool(tool.name, params, { companyId: COMPANY_A }).catch(() => undefined);
      }
    }
    await plugin.definition.onShutdown?.();

    expect(publishWrites(meta)).toEqual([]);
    expect(meta.calls.filter((call) => call.method === "DELETE")).toEqual([]);
  });
});
