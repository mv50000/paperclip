/**
 * View and action keys the UI calls. Plain strings: the UI bundle must not
 * import worker modules. tests/ui-handlers.spec.ts pins each one to the
 * worker's own constant.
 */

/** Manifest PLUGIN_ID; the host config route takes the plugin key. */
export const PLUGIN_KEY = "rk9-ads";

/** Read views: actions loaded with useViewData (view-data.ts), so the worker gets the host's company (RK9-583). */
export const VIEW = {
  overview: "ads-overview",
  widget: "ads-widget",
  settings: "ads-settings",
  preflight: "preflight-status",
  rules: "rules",
} as const;

export const ACTION = {
  pauseAd: "pause-ad",
  pauseAll: "pause-all",
  clearHalt: "clear-halt",
  resendGateCard: "resend_gate_card",
  digestPreview: "digest.dryRun",
  verifyConnection: "verify-connection",
  provision: "provision",
  rulesDryRun: "rules.dryRun",
  rulesPrepareSave: "rules.prepareSave",
} as const;

/** The host's plugin settings page with the generated config form. */
export const HOST_CONFIG_PATH = `/company/settings/instance/plugins/${PLUGIN_KEY}`;
/** This plugin's company settings page (slot companySettingsPage, routePath "ads"). */
export const SETTINGS_PATH = "/company/settings/ads";
