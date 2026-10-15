/**
 * Live media smoke against Sunspot's ad account (RK9-513, G19: Sunspot's ads
 * are paused). Operator-run only: tests and CI never start it.
 *
 * It uploads one reel by `file_url` and waits until Meta reports it ready,
 * then uploads one PNG as base64 bytes and prints its image_hash. Before and
 * after, it lists campaigns, ad sets and ads and fails if any object appeared.
 * The write guard lets through only the advideos and adimages edges, so
 * nothing that can spend money can be created.
 *
 *   RK9_ADS_LIVE_SMOKE=1 pnpm exec tsx scripts/live-media-smoke.ts \
 *     --video-url https://<public host>/<reel ~20MB>.mp4 --png ./path/to/image.png
 *
 * Token: META_ADS_ACCESS_TOKEN, or the META_ADS_ACCESS_TOKEN line in
 * META_ADS_ENV (default ~/.config/sunspot/meta-ads.env). Output is redacted.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GRAPH_VERSION, GraphHealth, MetaGraphClient, type GuardedWriteHook } from "../src/meta/graph.js";
import { listAds, listAdSets, listCampaigns, uploadImageBytes, uploadVideoByUrl, waitForVideoReady } from "../src/meta/methods.js";
import { redactText } from "../src/meta/redact.js";
import { isDryRun } from "../src/meta/types.js";
import { checkMediaUrl } from "../src/creative-manifest/schema.js";

const SUNSPOT_AD_ACCOUNT = "act_1336862981968191";
const MEDIA_ONLY_EDGE_RE = /^act_\d+\/(advideos|adimages)$/;

function loadToken(): string {
  const fromEnv = process.env.META_ADS_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.META_ADS_ENV ?? path.join(homedir(), ".config", "sunspot", "meta-ads.env");
  if (existsSync(file)) {
    const match = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?META_ADS_ACCESS_TOKEN\s*=\s*(.+?)\s*$/m);
    const value = match?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  throw new Error(`No token: set META_ADS_ACCESS_TOKEN or put it in ${file}`);
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Media uploads only. Everything else, a status write included, is refused. */
const mediaOnly: GuardedWriteHook = (plan) =>
  plan.method === "POST" && MEDIA_ONLY_EDGE_RE.test(plan.path)
    ? { allow: true }
    : { allow: false, reason: "the live media smoke writes only advideos and adimages" };

async function objectIds(client: MetaGraphClient): Promise<Set<string>> {
  const [campaigns, adSets, ads] = await Promise.all([
    listCampaigns(client, SUNSPOT_AD_ACCOUNT, { maxPages: 5 }),
    listAdSets(client, SUNSPOT_AD_ACCOUNT, { maxPages: 5 }),
    listAds(client, SUNSPOT_AD_ACCOUNT, { maxPages: 5 }),
  ]);
  return new Set([
    ...campaigns.map((row) => `campaign:${row.id}`),
    ...adSets.map((row) => `adset:${row.id}`),
    ...ads.map((row) => `ad:${row.id}`),
  ]);
}

async function main(): Promise<void> {
  if (process.env.RK9_ADS_LIVE_SMOKE !== "1") {
    console.log("Skipped: set RK9_ADS_LIVE_SMOKE=1 to upload test media to Sunspot's ad account.");
    return;
  }
  const videoUrl = arg("--video-url");
  const urlProblem = checkMediaUrl(videoUrl);
  if (urlProblem) throw new Error(`--video-url ${urlProblem.message}`);
  const pngPath = arg("--png");
  const png = readFileSync(pngPath);
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${pngPath} is not a PNG`);

  const token = loadToken();
  const known = [token];
  const client = new MetaGraphClient({
    companyId: "live-media-smoke",
    tokenRef: { type: "secret_ref", secretId: "live-smoke-env" },
    http: { fetch: (url, init) => fetch(url, init) },
    secrets: { resolve: async () => token },
    logger: {
      info: (message, meta) => console.log(redactText(`${message} ${JSON.stringify(meta ?? {})}`, known)),
      warn: (message, meta) => console.warn(redactText(`${message} ${JSON.stringify(meta ?? {})}`, known)),
    },
    mode: "live",
    guardedWrite: mediaOnly,
    health: new GraphHealth(),
  });

  console.log(`Live media smoke, Graph ${GRAPH_VERSION}, ${SUNSPOT_AD_ACCOUNT}`);
  const before = await objectIds(client);
  console.log(`Objects before: ${before.size}`);

  const video = await uploadVideoByUrl(client, SUNSPOT_AD_ACCOUNT, { fileUrl: videoUrl, name: "rk9-ads-live-media-smoke" });
  if (isDryRun(video)) throw new Error("unexpected dry run");
  console.log(`Video uploaded: video_id=${video.videoId}; waiting for status ready`);
  await waitForVideoReady(client, video.videoId, { intervalMs: 10_000, timeoutMs: 15 * 60_000 });
  console.log(`Video ${video.videoId} is ready`);

  const image = await uploadImageBytes(client, SUNSPOT_AD_ACCOUNT, { bytesBase64: png.toString("base64"), name: path.basename(pngPath) });
  if (isDryRun(image)) throw new Error("unexpected dry run");
  console.log(`Image uploaded: image_hash=${image.imageHash}`);

  const after = await objectIds(client);
  const appeared = [...after].filter((id) => !before.has(id));
  if (appeared.length > 0) throw new Error(`New campaign, ad set or ad objects appeared: ${appeared.join(", ")}`);
  console.log(`Objects after: ${after.size}; no new campaign, ad set or ad. OK`);
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(redactText(text));
  process.exitCode = 1;
});
