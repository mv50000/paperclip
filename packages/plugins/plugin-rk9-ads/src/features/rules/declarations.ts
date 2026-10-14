import type { FeatureDeclarations } from "../types.js";

/** Rule engine; pause-only, shadow mode first (A11, RK9-515). */
export const rulesDeclarations: FeatureDeclarations = {
  key: "rules",
  owner: "RK9-515",
  jobs: [
    {
      jobKey: "rules-evaluate",
      displayName: "Evaluate rules",
      description: "Hourly rule evaluation for the company's brand.",
      schedule: "0 * * * *",
    },
  ],
};
