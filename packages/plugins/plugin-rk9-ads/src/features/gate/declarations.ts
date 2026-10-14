import type { FeatureDeclarations } from "../types.js";

/** Telegram spend gate activation (A9, RK9-517). */
export const gateDeclarations: FeatureDeclarations = {
  key: "gate",
  owner: "RK9-517",
  jobs: [
    {
      jobKey: "gate-expiry",
      displayName: "Gate expiry",
      description: "Marks pending gate requests past valid_until as expired.",
      schedule: "*/5 * * * *",
    },
  ],
};
