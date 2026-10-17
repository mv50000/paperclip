/**
 * Golden shape test (A8, RK9-514): the plugin's planned creative and ad
 * bodies against publish-ad.mjs for the same Sunspot inputs. Only the
 * differences the fixture lists are normalised away.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryBindingStore } from "../../src/brand/provision.js";
import { enabledConfig, loadFixtureConfig } from "../brand/fake-routes.js";
import { CREATIVE_IMAGE, CREATIVE_VIDEO, imageCreative, serviceRig, videoCreative } from "./rig.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/sunspot-publish-ad-golden.json", import.meta.url), "utf8")) as {
  inputs: Record<string, string>;
  videoCreative: Record<string, unknown>;
  imageCreative: Record<string, unknown>;
  adCreate: Record<string, unknown>;
  swap: Record<string, unknown>;
};
const inputs = golden.inputs;

function sunspot() {
  const raw = loadFixtureConfig("sunspot") as { meta: Record<string, unknown> } & Record<string, unknown>;
  return enabledConfig({ ...raw, meta: { ...raw.meta, igUserId: inputs.igActorId } });
}

/** Replaces the listed allowed differences with fixed tokens. */
function normalise(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalise(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Thumbnail (image_hash vs image_url) and image media (image_hash vs picture) are allowed differences.
      if (k === "image_hash" || k === "image_url" || k === "picture") out.media = "<MEDIA>";
      else out[k] = normalise(v, k);
    }
    return out;
  }
  if (typeof value === "string") {
    if (key === "name" && (/^Aurinkopulssi /.test(value) || /^[A-Z0-9]+-[a-z0-9-]+-(image|video)-\d{8}-[0-9a-f]{6}$/.test(value))) return "<NAME>";
    if (key === "link") {
      const url = new URL(value);
      expect(url.searchParams.get("utm_source")).toBe("meta");
      expect(url.searchParams.get("utm_medium")).toBe("paid");
      expect(url.searchParams.get("utm_campaign")).toBe(inputs.utmCampaign);
      return `${url.origin}${url.pathname}`;
    }
    if (/^<[A-Z_]+>$/.test(value) || /^\{[a-z_]+\}$/.test(value)) return "<ID>";
  }
  return value;
}

function rig() {
  const config = sunspot();
  const copy = { message: inputs.message, title: inputs.title, description: inputs.linkDescription };
  const r = serviceRig({
    config,
    creatives: [
      videoCreative({ brand: "AUR", copy, cta: inputs.ctaType, landingUrlKey: "get", utmCampaign: inputs.utmCampaign, posterUrl: "https://media.sunspot.fi/poster.jpg" }),
      imageCreative({ brand: "AUR", copy, cta: inputs.ctaType, landingUrlKey: "get", utmCampaign: inputs.utmCampaign, aspectRatio: "1:1" }),
    ],
  });
  return { ...r, bindings: memoryBindingStore() };
}

describe("golden: publish-ad.mjs shape for Sunspot", () => {
  it("video creative and PAUSED ad body match publish-ad.mjs except the allowed differences", async () => {
    const { service, routes } = rig();
    const plan = await service.plan("11111111-1111-4111-8111-111111111111", { creativeId: CREATIVE_VIDEO });
    expect(normalise(plan.creative.body)).toEqual(normalise(golden.videoCreative));
    // The config adopts the Aurinkopulssi ad set; the binding in the rig wins, so compare the rest.
    expect(normalise({ ...plan.ad.body, adset_id: inputs.adsetId })).toEqual(normalise(golden.adCreate));
    expect(plan.creative.path).toBe(`act_${inputs.adAccount}/adcreatives`);
    expect(plan.ad.path).toBe(`act_${inputs.adAccount}/ads`);
    expect(routes.writes()).toEqual([]);
  });

  it("image creative matches createImageCreative except picture vs image_hash (G4)", async () => {
    const { service } = rig();
    const plan = await service.plan("11111111-1111-4111-8111-111111111111", { creativeId: CREATIVE_IMAGE });
    const body = plan.creative.body.object_story_spec as { instagram_user_id?: unknown };
    expect(body.instagram_user_id).toBeUndefined();
    expect(normalise(plan.creative.body)).toEqual(normalise(golden.imageCreative));
  });
});
