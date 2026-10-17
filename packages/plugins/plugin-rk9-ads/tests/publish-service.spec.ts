/**
 * The publish service (A8, RK9-514) against a fake Graph: dry run makes no
 * write, every ad is PAUSED, idempotent resume, orphan cleanup, video failure
 * and timeout, the 2859024 message, swap mode and the spend gate hand-off.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSpendGuardHook } from "../src/features/spend-guard/guard.js";
import { pausedOnlyWrites } from "../src/meta/graph.js";
import { AD_NAME_RE } from "../src/publish/ad-name.js";
import { PrevalidationError } from "../src/publish/prevalidate.js";
import type { Call } from "./brand/fake-routes.js";
import { graphError } from "./brand/fake-routes.js";
import {
  ADSET,
  COMPANY,
  CREATIVE_IMAGE,
  CREATIVE_VIDEO,
  formOf,
  IG_USER,
  imageCreative,
  liveClient,
  META_TOKEN,
  olollaConfig,
  serviceRig,
  UI,
  videoCreative,
} from "./publish/rig.js";

const ACT = "act_29231592883113369";

function adPosts(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === "POST" && call.key === `POST ${ACT}/ads`);
}

function assertEveryAdPostPaused(calls: Call[]): void {
  for (const call of adPosts(calls)) expect(formOf(call).status).toBe("PAUSED");
  for (const call of calls.filter((entry) => entry.method !== "GET")) {
    expect(call.body ?? "").not.toMatch(/ACTIVE/);
    expect(call.body ?? "").not.toMatch(/degrees_of_freedom_spec|OPT_OUT/);
  }
}

describe("publishService.plan (dry run)", () => {
  it("returns every planned payload and makes no Meta call at all", async () => {
    const { service, routes, store } = serviceRig();
    const plan = await service.plan(COMPANY, { creativeId: CREATIVE_VIDEO });
    expect(plan.dryRun).toBe(true);
    expect(plan.adName).toMatch(AD_NAME_RE);
    expect(plan.adName).toMatch(/^OLL-syksy-2026-video-20261017-[0-9a-f]{6}$/);
    expect(plan.finalUrl).toMatch(/^https:\/\/www\.ololla\.fi\/\?utm_source=meta&utm_medium=paid&utm_campaign=syksy-2026&utm_content=OLL-/);
    expect(plan.media).toEqual({
      kind: "video",
      action: "upload",
      videoId: null,
      upload: { method: "POST", path: `${ACT}/advideos`, body: { file_url: "https://media.ololla.fi/syksy-9x16.mp4", name: plan.adName } },
      thumbnail: { source: "poster", url: "https://media.ololla.fi/syksy-9x16-poster.jpg" },
    });
    expect(plan.creative.path).toBe(`${ACT}/adcreatives`);
    expect(plan.creative.body.object_story_spec).toMatchObject({ page_id: "1284777064729996", video_data: { call_to_action: { value: { link: plan.finalUrl } } } });
    expect(plan.ad).toEqual({
      method: "POST",
      path: `${ACT}/ads`,
      body: { name: plan.adName, adset_id: ADSET, creative: { creative_id: "{creative_id}" }, status: "PAUSED" },
    });
    expect(routes.calls).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  it("plans from a creative manifest too, still without any write", async () => {
    const { service, routes } = serviceRig();
    const plan = await service.plan(COMPANY, {
      manifest: {
        schemaVersion: "1",
        brand: "OLL",
        kind: "image",
        mediaUrl: "https://media.ololla.fi/a.jpg",
        sha256: "c".repeat(64),
        aspectRatio: "1:1",
        copy: { message: "Hei" },
        cta: "BOOK_TRAVEL",
        landingUrlKey: "home",
        utmCampaign: "talvi",
        validUntil: "2026-12-01T00:00:00Z",
        idempotencyKey: "oll-talvi-0001",
      },
    });
    expect(plan.media).toEqual({ kind: "image", action: "url", imageUrl: "https://media.ololla.fi/a.jpg" });
    expect(plan.creative.body.object_story_spec).toEqual({
      page_id: "1284777064729996",
      link_data: {
        picture: "https://media.ololla.fi/a.jpg",
        link: plan.finalUrl,
        message: "Hei",
        call_to_action: { type: "BOOK_TRAVEL", value: { link: plan.finalUrl } },
      },
    });
    expect(routes.writes()).toEqual([]);
  });

  it("refuses before any Meta call when prevalidation fails", async () => {
    const { service, routes } = serviceRig({ creatives: [imageCreative({ aspectRatio: "16:9" })] });
    await expect(service.plan(COMPANY, { creativeId: CREATIVE_IMAGE })).rejects.toBeInstanceOf(PrevalidationError);
    await expect(service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI)).rejects.toThrow(/aspectRatio/);
    expect(routes.calls).toEqual([]);
  });
});

describe("publishService.publish", () => {
  it("image: creative with link_data and no IG actor, then a PAUSED ad; logs every write; hands off once", async () => {
    const { service, routes, store, activity, handoffs } = serviceRig({ config: olollaConfig({ igUserId: IG_USER }) });
    const outcome = await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    expect(outcome).toMatchObject({ created: true, started: true, publication: { status: "pending" } });
    await service.settled();

    const record = store.rows[0]!;
    expect(record).toMatchObject({ status: "published", metaCreativeId: "7001", metaAdId: "5001", adsetId: ADSET, error: null, creativeId: CREATIVE_IMAGE });
    expect(record.payload.copy.message).toBe("Syksyn parhaat mökit Ollolassa.");
    const creativeCall = routes.calls.find((call) => call.key === `POST ${ACT}/adcreatives`)!;
    const spec = formOf(creativeCall).object_story_spec as Record<string, unknown>;
    expect(spec.instagram_user_id).toBeUndefined();
    expect(spec.link_data).toMatchObject({ picture: "https://media.ololla.fi/syksy-4x5.jpg", link: record.payload.finalUrl });
    expect(routes.calls.some((call) => call.key.includes("advideos") || call.key.includes("adimages"))).toBe(false);
    expect(formOf(adPosts(routes.calls)[0]!)).toEqual({ name: record.adName, adset_id: ADSET, creative: { creative_id: "7001" }, status: "PAUSED" });
    assertEveryAdPostPaused(routes.calls);

    const writes = activity.filter((entry) => entry.metadata?.metaObjectId);
    expect(writes.map((entry) => [entry.metadata!.step, entry.metadata!.metaObjectId])).toEqual([
      ["adcreatives", "7001"],
      ["ads_create", "5001"],
    ]);
    for (const entry of activity) {
      expect(entry).toMatchObject({ companyId: COMPANY, entityType: "rk9_ads_publication", entityId: record.id });
    }
    expect(JSON.stringify(activity)).not.toContain(META_TOKEN);
    expect(handoffs).toEqual([expect.objectContaining({ publicationId: record.id, adId: "5001", adsetId: ADSET, creativeId: "7001" })]);

    // The same request again returns the publication; no new write, no second hand-off.
    const writesBefore = routes.writes().length;
    const again = await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    expect(again).toMatchObject({ created: false, started: false, publication: { id: record.id, status: "published" } });
    expect(routes.writes().length).toBe(writesBefore);
    expect(handoffs).toHaveLength(1);
  });

  it("video: advideos by file_url (form body, no multipart), polls until ready, video_data with IG actor and poster", async () => {
    const config = olollaConfig({ igUserId: IG_USER });
    const { service, routes, store, clock } = serviceRig({ config });
    const statuses = ["processing", "processing", "ready"];
    routes.on("GET 9001", () => ({ body: { id: "9001", status: { video_status: statuses.shift() ?? "ready" } } }));
    const start = clock.now;
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();

    const upload = routes.calls.find((call) => call.key === `POST ${ACT}/advideos`)!;
    expect(upload.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(formOf(upload)).toEqual({ file_url: "https://media.ololla.fi/syksy-9x16.mp4", name: store.rows[0]!.adName });
    expect(routes.calls.filter((call) => call.key === "GET 9001")).toHaveLength(3);
    expect(clock.now - start).toBe(10_000);
    const spec = formOf(routes.calls.find((call) => call.key === `POST ${ACT}/adcreatives`)!).object_story_spec as Record<string, unknown>;
    expect(spec.instagram_user_id).toBe(IG_USER);
    expect(spec.video_data).toMatchObject({ video_id: "9001", image_url: "https://media.ololla.fi/syksy-9x16-poster.jpg", link_description: "ololla.fi" });
    expect(store.rows[0]).toMatchObject({ status: "published", metaVideoId: "9001", metaCreativeId: "7001", metaAdId: "5001" });
    assertEveryAdPostPaused(routes.calls);
  });

  it("video without a poster uses Meta's preferred thumbnail, retrying while the list is empty", async () => {
    const { service, routes, store } = serviceRig({ creatives: [videoCreative({ posterUrl: null })] });
    let reads = 0;
    routes.on("GET 9001/thumbnails", () => {
      reads += 1;
      return reads === 1 ? { body: { data: [] } } : { body: { data: [{ id: "1", uri: "https://scontent.example.fbcdn.net/a.jpg" }, { id: "2", uri: "https://scontent.example.fbcdn.net/b.jpg", is_preferred: true }] } };
    });
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();
    expect(reads).toBe(2);
    const spec = formOf(routes.calls.find((call) => call.key === `POST ${ACT}/adcreatives`)!).object_story_spec as { video_data: Record<string, unknown> };
    expect(spec.video_data.image_url).toBe("https://scontent.example.fbcdn.net/b.jpg");
    expect(store.rows[0]!.payload.thumbnailUrl).toBe("https://scontent.example.fbcdn.net/b.jpg");
  });

  it("reuses the creative's uploaded video instead of uploading again", async () => {
    const { service, routes, store } = serviceRig({ creatives: [videoCreative({ metaVideoId: "9001", status: "uploading" })] });
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();
    expect(routes.calls.some((call) => call.key.endsWith("/advideos"))).toBe(false);
    expect(store.rows[0]).toMatchObject({ status: "published", metaVideoId: "9001" });
  });

  it("text variants belong to the publication: other copy gives another publication with its own hash", async () => {
    const { service, store } = serviceRig();
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE, text: { copy: { message: "Toinen teksti" } } }, UI);
    await service.settled();
    expect(store.rows).toHaveLength(2);
    expect(new Set(store.rows.map((row) => row.contentHash)).size).toBe(2);
    expect(store.rows[1]!.payload.copy).toEqual({ message: "Toinen teksti" });
  });

  it("refuses an idempotency key reused for other content", async () => {
    const { service } = serviceRig();
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE, idempotencyKey: "oll-key-0001" }, UI);
    await expect(
      service.publish(COMPANY, { creativeId: CREATIVE_IMAGE, idempotencyKey: "oll-key-0001", text: { copy: { message: "x" } } }, UI),
    ).rejects.toThrow(/idempotency_key_conflict|other content/);
  });

  it("refuses a manifest target ad set that is not the bound one, and a brand without a bound ad set", async () => {
    const first = serviceRig({ creatives: [imageCreative({ targetAdsetId: "999" })] });
    await expect(first.service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI)).rejects.toThrow(/not the brand's bound ad set/);
    const second = serviceRig();
    second.store.rows.length = 0;
    const config = second.config;
    const unbound = serviceRig({ config, deps: { bindings: { get: async () => null, save: async () => undefined } } });
    await expect(unbound.service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI)).rejects.toThrow(/no bound ad set/);
    expect(unbound.routes.calls).toEqual([]);
  });
});

describe("failures and resume", () => {
  it("ad create fails with 2859024: the creative is deleted, the row says failed with a one-line fix", async () => {
    const { service, routes, store, activity, handoffs } = serviceRig();
    routes.on(`POST ${ACT}/ads`, graphError(100, "Invalid parameter", 2859024));
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    const record = store.rows[0]!;
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/policy terms \(code 100, subcode 2859024\)\. Fix: .*accept the pending terms/);
    expect(record.error).not.toMatch(/\n|\bat .*\.ts:\d+/);
    expect(record.metaCreativeId).toBeNull();
    expect(routes.calls.some((call) => call.key === "DELETE 7001")).toBe(true);
    expect(activity.map((entry) => entry.metadata?.step)).toEqual(["pending", "adcreatives", "cleanup_delete", "failed"]);
    expect(handoffs).toEqual([]);
  });

  it("a creative Meta will not delete is marked for cleanup and reused by the re-run", async () => {
    const { service, routes, store } = serviceRig();
    routes.on(`POST ${ACT}/ads`, graphError(100, "Invalid parameter", 2859024));
    routes.on("DELETE 7001", graphError(100, "Cannot delete"));
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "failed", metaCreativeId: "7001" });
    expect(store.rows[0]!.payload.cleanup).toMatchObject({ creativeId: "7001" });

    routes.on(`POST ${ACT}/ads`, { body: { id: "5002" } });
    const creativesBefore = routes.calls.filter((call) => call.key === `POST ${ACT}/adcreatives`).length;
    const rerun = await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    expect(rerun.started).toBe(true);
    await service.settled();
    expect(routes.calls.filter((call) => call.key === `POST ${ACT}/adcreatives`).length).toBe(creativesBefore);
    expect(store.rows[0]).toMatchObject({ status: "published", metaCreativeId: "7001", metaAdId: "5002" });
    // The marker is stale once the creative is the ad's creative.
    expect(store.rows[0]!.payload.cleanup ?? null).toBeNull();
  });

  it("keeps the creative when the ad create response is lost or the ad id cannot be saved", async () => {
    const { service, routes, store } = serviceRig();
    routes.on(`POST ${ACT}/ads`, new Error("socket hang up"));
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "failed", metaCreativeId: "7001" });
    expect(routes.calls.some((call) => call.method === "DELETE")).toBe(false);

    // The re-run finds the ad that Meta did create and adopts it: no second creative, no second ad.
    const planned = await service.plan(COMPANY, { creativeId: CREATIVE_IMAGE });
    routes.on(`GET ${ADSET}/ads`, { body: { data: [{ id: "5010", name: planned.adName, status: "PAUSED", effective_status: "PAUSED", creative: { id: "7001" } }] } });
    const adPostsBefore = adPosts(routes.calls).length;
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "published", metaCreativeId: "7001", metaAdId: "5010" });
    expect(adPosts(routes.calls)).toHaveLength(adPostsBefore);
    expect(routes.calls.filter((call) => call.key === `POST ${ACT}/adcreatives`)).toHaveLength(1);

    // A save failure right after a successful ad create keeps the creative too.
    const second = serviceRig();
    const update = second.store.update.bind(second.store);
    second.store.update = async (companyId, id, expected, patch) => {
      if (patch.metaAdId) throw new Error("database is down");
      return update(companyId, id, expected, patch);
    };
    await second.service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await second.service.settled();
    expect(second.routes.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(second.store.rows[0]).toMatchObject({ status: "failed", metaCreativeId: "7001" });
  });

  it("a video processing error fails the publication and creates no creative or ad", async () => {
    const { service, routes, store } = serviceRig();
    routes.on("GET 9001", { body: { id: "9001", status: { video_status: "error", processing_phase: { errors: [{ message: "bad codec" }] } } } });
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "failed", metaVideoId: null, metaCreativeId: null, metaAdId: null });
    expect(store.rows[0]!.error).toMatch(/bad codec.*Fix: re-encode/);
    expect(routes.calls.some((call) => call.key.endsWith("/adcreatives") || call.key.endsWith("/ads"))).toBe(false);
  });

  it("a poll timeout fails with a readable reason, and the re-run polls the same video without uploading again", async () => {
    const { service, routes, store } = serviceRig();
    routes.on("GET 9001", { body: { id: "9001", status: { video_status: "processing" } } });
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "failed", metaVideoId: "9001" });
    expect(store.rows[0]!.error).toMatch(/not ready after 60000 ms.*Fix: run the publish again later/);

    routes.on("GET 9001", { body: { id: "9001", status: { video_status: "ready" } } });
    await service.publish(COMPANY, { creativeId: CREATIVE_VIDEO }, UI);
    await service.settled();
    expect(routes.calls.filter((call) => call.key.endsWith("/advideos"))).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: "published", metaVideoId: "9001" });
  });

  it("resumes a crashed run from the stored ids and adopts an ad that was created but not recorded", async () => {
    const { service, routes, store } = serviceRig();
    const planned = await service.plan(COMPANY, { creativeId: CREATIVE_IMAGE });
    // First attempt dies after the creative: the ads edge is down.
    routes.on(`GET ${ADSET}/ads`, new Error("socket hang up"));
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    expect(store.rows[0]!.status).toBe("failed");

    // The ad exists in Meta under the deterministic name (crash between create and save).
    routes.on("DELETE 7001", graphError(100, "in use"));
    routes.on(`GET ${ADSET}/ads`, { body: { data: [{ id: "5009", name: planned.adName, status: "PAUSED", effective_status: "PAUSED", creative: { id: "7001" } }] } });
    store.rows[0]!.metaCreativeId = "7001";
    store.rows[0]!.payload.cleanup = null;
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    expect(store.rows[0]).toMatchObject({ status: "published", metaCreativeId: "7001", metaAdId: "5009" });
    expect(adPosts(routes.calls)).toHaveLength(0);
  });

  it("does not start a second run of the same publication while one is in flight", async () => {
    const { service, routes } = serviceRig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = routes.fetch;
    routes.fetch = async (url, init) => {
      if (url.includes("/adcreatives")) await gate;
      return fetch(url, init);
    };
    const first = await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    const second = await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, publication: { id: first.publication.id } });
    release();
    await service.settled();
    expect(routes.calls.filter((call) => call.key === `POST ${ACT}/adcreatives`)).toHaveLength(1);
  });
});

describe("swap mode", () => {
  it("posts only { creative, status: PAUSED } to a PAUSED ad that this company published", async () => {
    const { service, routes, store, handoffs } = serviceRig();
    routes.on("GET 5001", { body: { id: "5001", account_id: "29231592883113369", adset_id: ADSET, status: "PAUSED", effective_status: "PAUSED" } });
    routes.on("POST 5001", { body: { success: true } });
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    const original = store.rows[0]!;

    const outcome = await service.swap(COMPANY, { creativeId: CREATIVE_IMAGE, adId: "5001", text: { copy: { message: "Uusi teksti" } } }, UI);
    await service.settled();
    const swap = store.rows.find((row) => row.id === outcome.publication.id)!;
    const swapCall = routes.calls.find((call) => call.key === "POST 5001")!;
    expect(formOf(swapCall)).toEqual({ creative: { creative_id: "7001" }, status: "PAUSED" });
    expect(swap).toMatchObject({ mode: "swap", status: "swapped", metaAdId: "5001", replacesPublicationId: original.id });
    expect(adPosts(routes.calls)).toHaveLength(1);
    expect(handoffs).toHaveLength(1);
  });

  it("refuses an ad that no publication of this company made, before any read or write", async () => {
    const { service, routes } = serviceRig();
    routes.on("GET 5001", { body: { id: "5001", account_id: "29231592883113369", adset_id: ADSET, status: "PAUSED", effective_status: "PAUSED" } });
    await expect(service.swap(COMPANY, { creativeId: CREATIVE_IMAGE, adId: "5001" }, UI)).rejects.toThrow(/ad_not_owned|not published by this company/);
    expect(routes.calls).toEqual([]);
  });

  it("refuses an owned ad from another ad account, or one that is not PAUSED, before any write", async () => {
    const { service, routes } = serviceRig();
    await service.publish(COMPANY, { creativeId: CREATIVE_IMAGE }, UI);
    await service.settled();
    const writes = routes.writes().length;
    routes.on("GET 5001", { body: { id: "5001", account_id: "1336862981968191", adset_id: ADSET, status: "PAUSED", effective_status: "PAUSED" } });
    await expect(service.swap(COMPANY, { creativeId: CREATIVE_IMAGE, adId: "5001", text: { copy: { message: "B" } } }, UI)).rejects.toThrow(/not in this brand's ad account/);
    for (const status of ["ACTIVE", "ARCHIVED"]) {
      routes.on("GET 5001", { body: { id: "5001", account_id: "29231592883113369", adset_id: ADSET, status, effective_status: "DISAPPROVED" } });
      await expect(service.swap(COMPANY, { creativeId: CREATIVE_IMAGE, adId: "5001", text: { copy: { message: "B" } } }, UI)).rejects.toThrow(/pause it before a creative swap/);
    }
    expect(routes.writes()).toHaveLength(writes);
  });
});

describe("no path to ACTIVE", () => {
  it("the publish sources never name ACTIVE", () => {
    const dir = new URL("../src/publish/", import.meta.url);
    for (const file of readdirSync(dir)) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/["'`]ACTIVE["'`]/);
    }
  });

  it("the spend-guarded hook lets a PAUSED ad create and a pausing creative swap through without a spend read, and refuses ACTIVE", async () => {
    const config = olollaConfig();
    const refusingRead = liveClient({ fetch: async () => { throw new Error("no read expected"); } } as never, { now: 0 });
    const hook = createSpendGuardHook({ config, readClient: refusingRead });
    const plan = (path: string, fields: Record<string, unknown>) => ({ companyId: COMPANY, mode: "live" as const, method: "POST" as const, path, fields });
    expect(await hook(plan(`${ACT}/ads`, { name: "a", adset_id: ADSET, creative: { creative_id: "1" }, status: "PAUSED" }))).toEqual({ allow: true });
    expect(await hook(plan("5001", { creative: { creative_id: "7001" }, status: "PAUSED" }))).toEqual({ allow: true });
    // A swap without the pause would reach the gate, which refuses it.
    expect((await hook(plan("5001", { creative: { creative_id: "7001" } }))).allow).toBe(false);
    expect((await hook(plan(`${ACT}/ads`, { name: "a", adset_id: ADSET, creative: { creative_id: "1" }, status: "ACTIVE" }))).allow).toBe(false);
    // A swap that smuggles a status is not a swap.
    expect(pausedOnlyWrites(plan("5001", { creative: { creative_id: "7001" }, status: "ACTIVE" })).allow).toBe(false);
    expect(pausedOnlyWrites(plan("5001", { creative: { creative_id: "7001", extra: 1 }, status: "PAUSED" })).allow).toBe(false);
    expect(pausedOnlyWrites(plan("5001", { creative: { object_story_spec: {} } })).allow).toBe(false);
  });
});
