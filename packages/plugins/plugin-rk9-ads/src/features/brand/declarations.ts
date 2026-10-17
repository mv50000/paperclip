import type { FeatureDeclarations } from "../types.js";

/**
 * Brand preflight and provisioning (A4, RK9-510). Actions and data handlers
 * need no manifest entry, so this feature declares nothing: the operator UI
 * (A12) calls `verify-connection`, `provision` and `preflight-status`.
 */
export const brandDeclarations: FeatureDeclarations = {
  key: "brand",
  owner: "RK9-510",
};
