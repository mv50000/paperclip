import type { FeatureDeclarations } from "../types.js";

/** Creative manifest ingress and read-only agent tools (A7, RK9-513). */
export const creativesDeclarations: FeatureDeclarations = {
  key: "creatives",
  owner: "RK9-513",
  apiRoutes: [
    {
      routeKey: "stage-creative",
      method: "POST",
      path: "/creatives",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  tools: [
    {
      name: "rk9ads_stage_creative",
      displayName: "Stage creative",
      description: "Stages a creative manifest v1 (media as HTTPS URL) for publishing. Does not activate anything.",
      parametersSchema: {
        type: "object",
        properties: { manifest: { type: "object", description: "Creative manifest v1" } },
        required: ["manifest"],
      },
    },
    {
      name: "rk9ads_list_ads",
      displayName: "List ads",
      description: "Read-only: lists this company's ads and their status.",
      parametersSchema: { type: "object", properties: { status: { type: "string" } } },
    },
    {
      name: "rk9ads_get_insights",
      displayName: "Get ad insights",
      description: "Read-only: daily insights for this company's ads.",
      parametersSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "YYYY-MM-DD" },
          until: { type: "string", description: "YYYY-MM-DD" },
          adId: { type: "string" },
        },
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
