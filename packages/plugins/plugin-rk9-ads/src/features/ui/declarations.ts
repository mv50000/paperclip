import type { FeatureDeclarations } from "../types.js";

/**
 * Operator UI slots (A12, RK9-518). Only A12 writes src/ui/** (G13); the
 * scaffold ships placeholders so every declared slot resolves.
 */
export const uiDeclarations: FeatureDeclarations = {
  key: "ui",
  owner: "RK9-518",
  uiSlots: [
    { type: "page", id: "rk9-ads-page", displayName: "Mainonta", exportName: "AdsPage", routePath: "ads" },
    { type: "sidebar", id: "rk9-ads-sidebar", displayName: "Mainonta", exportName: "SidebarLink" },
    {
      type: "companySettingsPage",
      id: "rk9-ads-settings",
      displayName: "Mainonta",
      exportName: "SettingsPage",
      routePath: "ads",
    },
    { type: "dashboardWidget", id: "rk9-ads-widget", displayName: "Mainonta", exportName: "AdsWidget" },
  ],
};
