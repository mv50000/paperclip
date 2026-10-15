/**
 * Read-only parity check of the insights ingest against Sunspot's morning SOP
 * (RK9-512, G19: Sunspot's ads are paused, reads are safe).
 *
 * The SOP (/opt/repos/sunspot/marketing/ops/sunspot-aamu-sop.sh) reads one
 * account-level row (spend, impressions, inline_link_clicks) and computes
 * CPC = spend / inline_link_clicks. This script reads the same day both ways,
 * the SOP's account-level query and the plugin's ad-level ingest, and compares
 * spend, impressions, link clicks and CPC. Exit code 1 on a mismatch.
 *
 * Not part of any test run. It runs only when RK9_ADS_LIVE_SMOKE=1, and the
 * client is always in readOnly mode.
 *
 *   RK9_ADS_LIVE_SMOKE=1 pnpm exec tsx scripts/parity-sunspot-insights.ts [--date YYYY-MM-DD] [--record <file>]
 *
 * Without --date it uses yesterday in the account time zone (the SOP's
 * date_preset=yesterday). Token: as in scripts/live-smoke-sunspot.ts.
 * `--record <file>` writes both Graph bodies as a test fixture (no token in them).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { GraphHealth, MetaGraphClient } from "../src/meta/graph.js";
import { getAccountSummary, getInsights, parseDecimalMoney } from "../src/meta/methods.js";
import { redactText } from "../src/meta/redact.js";
import { fetchAdDays, OPTIONAL_INSIGHT_FIELDS, toDayRow } from "../src/insights/ingest.js";
import { addDays } from "../src/insights/mtd.js";
import { localDate } from "../src/kit/local-time.js";
import { linkCpc, parseCount } from "../src/metrics/cpc.js";

const SUNSPOT_AD_ACCOUNT = "act_1336862981968191";

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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.env.RK9_ADS_LIVE_SMOKE !== "1") {
    console.log("Skipped: set RK9_ADS_LIVE_SMOKE=1 to run the read-only parity check.");
    return;
  }
  const token = loadToken();
  const client = new MetaGraphClient({
    companyId: "parity",
    tokenRef: { type: "secret_ref", secretId: "parity-env" },
    http: { fetch: (url, init) => fetch(url, init) },
    secrets: { resolve: async () => token },
    mode: "readOnly",
    health: new GraphHealth(),
  });

  const account = await getAccountSummary(client, SUNSPOT_AD_ACCOUNT);
  const date = arg("--date") ?? addDays(localDate(new Date(), account.timezone), -1);
  const window = { since: date, until: date };

  // The SOP's query, as a time range for the same day.
  const sopRows = await getInsights(client, SUNSPOT_AD_ACCOUNT, {
    level: "account",
    timeRange: window,
    fields: ["spend", "impressions", "inline_link_clicks"],
  });
  const sop = sopRows[0] ?? {};
  // No row means no spend that day (the SOP prints nothing then).
  const sopSpend = sopRows.length > 0 ? parseDecimalMoney(sop.spend, "spend") : 0;
  const sopImpressions = parseCount(sop.impressions);
  const sopClicks = parseCount(sop.inline_link_clicks);

  const { rows: adRows, skipped } = await fetchAdDays(client, SUNSPOT_AD_ACCOUNT, window, OPTIONAL_INSIGHT_FIELDS);
  const parsed = adRows
    .map((row) => toDayRow(row, { brandCode: "AUR", currency: account.currency, withActions: false, finalBefore: date }))
    .filter((row) => row !== null);
  const spend = parsed.reduce((total, row) => total + row.spendCents, 0);
  const impressions = parsed.reduce((total, row) => total + row.impressions, 0);
  const clicks = parsed.reduce((total, row) => total + row.inlineLinkClicks, 0);

  const report = {
    date,
    accountTimeZone: account.timezone,
    sop: { spendCents: sopSpend, impressions: sopImpressions, inlineLinkClicks: sopClicks, cpc: linkCpc(sopSpend, sopClicks) },
    plugin: { ads: parsed.length, spendCents: spend, impressions, inlineLinkClicks: clicks, cpc: linkCpc(spend, clicks), skipped },
  };
  console.log(JSON.stringify(report, null, 2));

  const recordFile = arg("--record");
  if (recordFile) {
    writeFileSync(
      recordFile,
      `${JSON.stringify(
        {
          source: `recorded ${new Date().toISOString().slice(0, 10)} from Sunspot ${SUNSPOT_AD_ACCOUNT} with scripts/parity-sunspot-insights.ts --record (read-only)`,
          date,
          accountTimeZone: account.timezone,
          accountLevel: { data: sopRows },
          adLevel: { data: adRows },
        },
        null,
        2,
      )}\n`,
    );
  }

  const ok = spend === sopSpend && impressions === sopImpressions && clicks === sopClicks;
  console.log(ok ? "PARITY OK" : "PARITY MISMATCH");
  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(redactText(text));
  process.exitCode = 1;
});
