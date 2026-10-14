/**
 * Read-only live smoke of the Meta client against Sunspot's ad account
 * (RK9-508, G19: Sunspot's ads are paused, reads are safe).
 *
 * Not part of any test run. It runs only when RK9_ADS_LIVE_SMOKE=1, and the
 * client is always in readOnly mode, so a write cannot reach Meta.
 *
 *   RK9_ADS_LIVE_SMOKE=1 pnpm exec tsx scripts/live-smoke-sunspot.ts [--record <dir>]
 *
 * Token: META_ADS_ACCESS_TOKEN, or the META_ADS_ACCESS_TOKEN line in
 * META_ADS_ENV (default ~/.config/sunspot/meta-ads.env). Output is redacted.
 * `--record <dir>` also writes each Graph response, token-scrubbed, as a
 * fixture file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GRAPH_VERSION, GraphHealth, MetaGraphClient, type FetchLike } from "../src/meta/graph.js";
import { getAccountSummary, getInsights, listAds, listAdSets, listCampaigns } from "../src/meta/methods.js";
import { redactText, redactValue, stripAccessToken } from "../src/meta/redact.js";

const SUNSPOT_AD_ACCOUNT = "act_1336862981968191";
const RECORDED_HEADERS = ["facebook-api-version", "x-business-use-case-usage", "x-app-usage", "x-ad-account-usage"];

function loadToken(): string {
  const fromEnv = process.env.META_ADS_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.META_ADS_ENV ?? path.join(homedir(), ".config", "sunspot", "meta-ads.env");
  if (existsSync(file)) {
    const match = readFileSync(file, "utf8").match(/^\s*META_ADS_ACCESS_TOKEN\s*=\s*(.+?)\s*$/m);
    if (match?.[1]) return match[1];
  }
  throw new Error(`No token: set META_ADS_ACCESS_TOKEN or put it in ${file}`);
}

async function main(): Promise<void> {
  if (process.env.RK9_ADS_LIVE_SMOKE !== "1") {
    console.log("Skipped: set RK9_ADS_LIVE_SMOKE=1 to run the read-only live smoke.");
    return;
  }
  const recordIndex = process.argv.indexOf("--record");
  const recordDir = recordIndex >= 0 ? process.argv[recordIndex + 1] : undefined;
  if (recordDir) mkdirSync(recordDir, { recursive: true });

  const token = loadToken();
  const known = [token];
  let calls = 0;
  let nonGetCalls = 0;

  const fetchLike: FetchLike = async (url, init) => {
    calls += 1;
    if ((init?.method ?? "GET") !== "GET") nonGetCalls += 1;
    const response = await fetch(url, init);
    if (!recordDir) return response;
    const body = await response.text();
    const headers: Record<string, string> = {};
    for (const name of RECORDED_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const target = stripAccessToken(url);
    const fixture = redactValue(
      {
        request: { method: init?.method ?? "GET", path: target.pathname, query: target.search },
        status: response.status,
        headers,
        body: (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })(),
      },
      known,
    );
    writeFileSync(path.join(recordDir, `live-${String(calls).padStart(2, "0")}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  const client = new MetaGraphClient({
    companyId: "live-smoke",
    tokenRef: { type: "secret_ref", secretId: "live-smoke-env" },
    http: { fetch: fetchLike },
    secrets: { resolve: async () => token },
    logger: {
      info: (message, meta) => console.log(redactText(`${message} ${JSON.stringify(meta ?? {})}`, known)),
      warn: (message, meta) => console.warn(redactText(`${message} ${JSON.stringify(meta ?? {})}`, known)),
    },
    mode: "readOnly",
    health: new GraphHealth(),
  });

  const print = (label: string, value: unknown) =>
    console.log(`\n## ${label}\n${redactText(JSON.stringify(redactValue(value, known), null, 2), known)}`);

  console.log(`Meta client live smoke, Graph ${GRAPH_VERSION}, ${SUNSPOT_AD_ACCOUNT}, mode=${client.mode}`);
  print("Account summary", await getAccountSummary(client, SUNSPOT_AD_ACCOUNT));
  const campaigns = await listCampaigns(client, SUNSPOT_AD_ACCOUNT, { maxPages: 3 });
  print(`Campaigns (${campaigns.length})`, campaigns);
  const adSets = await listAdSets(client, SUNSPOT_AD_ACCOUNT, { maxPages: 3 });
  print(`Ad sets (${adSets.length})`, adSets);
  const ads = await listAds(client, SUNSPOT_AD_ACCOUNT, { maxPages: 3 });
  print(`Ads (${ads.length})`, ads);
  const insights = await getInsights(client, SUNSPOT_AD_ACCOUNT, {
    level: "account",
    datePreset: "yesterday",
    fields: ["date_start", "date_stop", "spend", "impressions", "reach", "clicks", "inline_link_clicks"],
  });
  print(`Insights, yesterday (${insights.length} rows)`, insights);
  print("Client status", client.status());
  console.log(`\nGraph calls: ${calls}, non-GET calls: ${nonGetCalls}`);
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(redactText(text));
  process.exitCode = 1;
});
