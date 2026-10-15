/**
 * Parity with /opt/repos/sunspot/marketing/ops/sunspot-pulse-off.sh (A6, RK9-511).
 *
 * The fixtures in tests/fixtures/sunspot-pulse-off/ were recorded read-only
 * from the Sunspot ad account and feed on 2026-10-15 (G19). Sunspot is off
 * season, so the recorded state is "pulse already off"; the "pulse on" cases
 * set the campaign and its three newest ads ACTIVE on top of the recording.
 *
 * `scriptPlan` restates the script's selection rules. The plugin side runs the
 * real pauseAll in dry-run mode and the real data-gate evaluation.
 *
 * Known deviation: the script counts terraces whose status is clear or
 * partly-clear; the plugin's data gate reads one number at a JSON pointer
 * (BrandConfig.schedule.dataGate). The plugin feed here carries that count as
 * `/inSunNow`, computed from the same recorded terraces. Moving Sunspot onto
 * the plugin needs such a field in the feed (out of scope, RK9-505).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateDataGate } from "../../src/features/spend-guard/data-gate.js";
import type { PauseAllResult } from "../../src/features/spend-guard/killswitch.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta, type FakeObject } from "./fake-meta.js";
import { rig, telegramBlock } from "./rig.js";

const CAMPAIGN_ID = "120247250925830775";
const SUN_MIN = 8;
const FEED_URL = "https://sunspot.fi/api/feed";

function load<T>(name: string): T {
  return (JSON.parse(readFileSync(new URL(`../fixtures/sunspot-pulse-off/${name}.json`, import.meta.url), "utf8")) as { body: T }).body;
}

const recordedCampaign = load<FakeObject>("campaign");
const recordedAds = load<{ data: FakeObject[] }>("ads").data;
const recordedFeed = load<{ terraces: Array<{ id: string; status: string }> }>("feed");

interface Inputs {
  campaign: FakeObject;
  ads: FakeObject[];
  feed: { terraces: Array<{ id: string; status: string }> } | null;
}

function pulseOn(): Inputs {
  const ads = recordedAds.map((ad, index) => ({ ...ad, status: index < 3 ? "ACTIVE" : ad.status, effective_status: undefined }));
  return { campaign: { ...recordedCampaign, status: "ACTIVE", effective_status: "ACTIVE" }, ads, feed: recordedFeed };
}

function recorded(): Inputs {
  return { campaign: { ...recordedCampaign }, ads: recordedAds.map((ad) => ({ ...ad })), feed: recordedFeed };
}

function sunny(inputs: Inputs): Inputs {
  const terraces = recordedFeed.terraces.map((terrace, index) => ({ ...terrace, status: index < 10 ? "clear" : terrace.status }));
  return { ...inputs, feed: { terraces } };
}

/** The script's rule: in-sun count = terraces with status clear or partly-clear. */
function inSun(feed: NonNullable<Inputs["feed"]>): number {
  return feed.terraces.filter((terrace) => terrace.status === "clear" || terrace.status === "partly-clear").length;
}

/** What sunspot-pulse-off.sh [--data-gate] --dry-run would pause, as ids (ads, then the campaign). */
function scriptPlan(inputs: Inputs, dataGate: boolean): string[] {
  const campaignActive = inputs.campaign.status === "ACTIVE";
  if (dataGate) {
    if (!campaignActive) return [];
    if (inputs.feed === null) return [];
    if (inSun(inputs.feed) >= SUN_MIN) return [];
  }
  // ?fields=id,name,status&limit=50, one page, status == ACTIVE.
  const activeAds = inputs.ads.slice(0, 50).filter((ad) => ad.status === "ACTIVE").map((ad) => ad.id);
  if (activeAds.length === 0 && !campaignActive) return [];
  return [...activeAds, ...(campaignActive ? [inputs.campaign.id] : [])];
}

function sunspotRig(inputs: Inputs) {
  const meta = new FakeMeta("1336862981968191");
  meta.campaigns = [inputs.campaign];
  meta.ads = inputs.ads.map((ad) => ({ ...ad, campaign_id: CAMPAIGN_ID }));
  const config = brandConfig({
    brandCode: "AUR",
    telegram: telegramBlock(),
    schedule: {
      scheduledPause: { enabled: true, at: "21:30" },
      dataGate: { url: FEED_URL, jsonPointer: "/inSunNow", operator: "gte", threshold: SUN_MIN },
    },
  });
  config.meta = { ...(config.meta as object), adAccountId: "act_1336862981968191", campaignId: CAMPAIGN_ID };
  const r = rig({ meta, config });
  r.feeds.set(FEED_URL, () =>
    inputs.feed === null ? new Response("bad gateway", { status: 502 }) : new Response(JSON.stringify({ inSunNow: inSun(inputs.feed) })),
  );
  return r;
}

async function pluginPlan(inputs: Inputs, dataGate: boolean): Promise<string[]> {
  const r = sunspotRig(inputs);
  if (dataGate) {
    const outcome = await evaluateDataGate(r.harness.ctx.http.fetch, {
      url: FEED_URL,
      jsonPointer: "/inSunNow",
      operator: "gte",
      threshold: SUN_MIN,
    });
    if (outcome.action === "skip") return [];
  }
  const result = await r.harness.performAction<PauseAllResult>("pause-all", { dryRun: true }, { companyId: COMPANY_A, actor: { type: "user", userId: "u" } });
  expect(r.meta.writes).toHaveLength(0);
  return [...result.pausedAds.map((ad) => ad.id), ...result.pausedCampaigns.map((campaign) => campaign.id)];
}

describe("parity with sunspot-pulse-off.sh --dry-run on recorded inputs", () => {
  it("the recorded fixtures are what they claim", () => {
    expect(recordedCampaign).toMatchObject({ id: CAMPAIGN_ID, name: "Aurinkopulssi" });
    expect(recordedAds.length).toBeGreaterThan(3);
    expect(recordedAds.length).toBeLessThanOrEqual(50);
    expect(recordedFeed.terraces.length).toBeGreaterThan(100);
  });

  it.each([
    ["recorded (pulse already off)", recorded, false],
    ["pulse on, nightly", pulseOn, false],
    ["recorded, --data-gate", recorded, true],
    ["pulse on, --data-gate, no terrace in sun", pulseOn, true],
    ["pulse on, --data-gate, 10 terraces in sun", () => sunny(pulseOn()), true],
    ["pulse on, --data-gate, feed unavailable", () => ({ ...pulseOn(), feed: null }), true],
  ] as const)("%s: same pause list", async (_label, make, dataGate) => {
    const inputs = make();
    const expected = scriptPlan(inputs, dataGate);
    expect(await pluginPlan(make(), dataGate)).toEqual(expected);
  });

  it("the pulse-on case pauses the three ACTIVE ads and the campaign", () => {
    expect(scriptPlan(pulseOn(), false)).toEqual([...recordedAds.slice(0, 3).map((ad) => ad.id), CAMPAIGN_ID]);
  });
});
