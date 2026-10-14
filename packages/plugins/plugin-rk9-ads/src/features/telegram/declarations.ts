import type { FeatureDeclarations } from "../types.js";

/**
 * Telegram transport (A5, RK9-509). Long-poll is the default; the webhook is the
 * optional mode. Note for webhook mode: the host stores every webhook request's
 * headers in plugin_webhook_deliveries, including X-Telegram-Bot-Api-Secret-Token.
 */
export const telegramDeclarations: FeatureDeclarations = {
  key: "telegram",
  owner: "RK9-509",
  webhooks: [
    {
      endpointKey: "telegram",
      displayName: "Telegram updates",
      description: "Telegram Bot API updates in webhook mode. Verified with X-Telegram-Bot-Api-Secret-Token.",
    },
  ],
};
