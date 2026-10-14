import type { FeatureDeclarations } from "../types.js";

/** Insights collection, daily digest and creative fatigue (A10, RK9-512). */
export const insightsDeclarations: FeatureDeclarations = {
  key: "insights",
  owner: "RK9-512",
  jobs: [
    {
      jobKey: "insights-hourly",
      displayName: "Insights refresh",
      description: "Refreshes today's insights every hour.",
      schedule: "5 * * * *",
    },
    {
      jobKey: "insights-daily-close",
      displayName: "Insights daily close",
      description: "Hourly UTC cron; after local midnight it finalises yesterday and backfills missing dates.",
      schedule: "20 * * * *",
    },
    {
      jobKey: "digest-tick",
      displayName: "Daily digest",
      description: "Every 15 min (UTC cron); sends the digest once per local day at or after digest.time.",
      schedule: "*/15 * * * *",
    },
  ],
};
