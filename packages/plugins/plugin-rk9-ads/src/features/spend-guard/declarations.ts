import type { FeatureDeclarations } from "../types.js";

/** Spend guard, kill switch and scheduled pause (A6, RK9-511). */
export const spendGuardDeclarations: FeatureDeclarations = {
  key: "spend-guard",
  owner: "RK9-511",
  jobs: [
    {
      jobKey: "scheduled-pause",
      displayName: "Scheduled pause",
      description: "Runs every 5 min (UTC cron) and pauses once per local day at or after schedule.scheduledPause.at.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [
    {
      name: "rk9ads_pause_all",
      displayName: "Pause all ads",
      description: "Kill switch: pauses every active ad of this company's brand. Cannot activate anything.",
      parametersSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the ads are paused" } },
        required: ["reason"],
      },
    },
    {
      name: "rk9ads_get_pacing",
      displayName: "Get spend pacing",
      description: "Read-only: month-to-date spend against the monthly cap.",
      parametersSchema: { type: "object", properties: {} },
    },
  ],
};
