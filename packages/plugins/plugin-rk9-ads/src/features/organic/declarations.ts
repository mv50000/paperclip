import type { FeatureDeclarations } from "../types.js";

/**
 * Organic IG/FB posting (RK9-832). The agent tool only opens a Telegram card:
 * nothing is published until an approver taps "Julkaise" on that card.
 */
export const organicDeclarations: FeatureDeclarations = {
  key: "organic",
  owner: "RK9-832",
  jobs: [
    {
      jobKey: "organic-reconcile",
      displayName: "Organic reconcile",
      description: "Closes organic posts stuck in publishing from what Meta reports. Reads Meta, never writes to it.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [
    {
      name: "rk9ads_request_organic_post",
      displayName: "Request organic post",
      description:
        "Opens one Telegram approval card for an organic Instagram or Facebook Page post of a staged creative. Publishes nothing: only an approver's tap on the card publishes. Pass the brand-lint JSON result as brandLint.",
      parametersSchema: {
        type: "object",
        properties: {
          creativeId: { type: "string", description: "Staged creative id (rk9ads_stage_creative)" },
          channel: { type: "string", enum: ["ig_reel", "ig_feed", "fb_video", "fb_photo"] },
          caption: { type: "string", description: "Post text; default the creative's copy.message" },
          brandLint: { type: "object", description: "brand-lint --json result (rk9-motion scripts/brand-lint.mjs)" },
          aiGenerated: {
            type: "boolean",
            description: "True when the imagery is AI-generated: the post gets Instagram's AI info label. Only ig_reel and ig_feed; default false",
          },
        },
        required: ["creativeId", "channel", "brandLint"],
      },
    },
  ],
};
