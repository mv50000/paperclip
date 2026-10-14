import type { FeatureDeclarations } from "../types.js";

export const SMOKE_JOB_KEY = "smoke";

/** Scaffold seam check (RK9-507). Manual trigger only: no schedule. */
export const smokeDeclarations: FeatureDeclarations = {
  key: "smoke",
  owner: "RK9-507",
  jobs: [
    {
      jobKey: SMOKE_JOB_KEY,
      displayName: "Smoke check",
      description:
        "Reads each company's config, resolves its secret refs, counts its ledger rows and writes one activity entry per configured company. Never logs secret values.",
    },
  ],
};
