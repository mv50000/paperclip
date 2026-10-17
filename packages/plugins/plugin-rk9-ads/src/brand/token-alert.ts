/**
 * Expired or revoked Meta token (Graph code 190), A4 RK9-510.
 *
 * The job or action that saw it fails without a retry loop (the Meta client
 * never retries a 190). This module tells the operator once per incident:
 * - one Telegram message to the brand chat, marker `token-alert:<brand>:<class>`;
 * - one Paperclip issue in the brand company, originKind `plugin:<pluginId>`
 *   (G18) and originId `rk9-ads:<brand>:<class>`, marker = the originId.
 *
 * Markers are alert_dedupe rows claimed before the send or create, so two
 * overlapping runs never both send. A failed Telegram send gives its marker
 * back (the next run sends). A failed issue create gives its marker back only
 * when the host refused it before it ran (as with fatigue issues): any other
 * failure may have created the issue. The plugin has no issues.read, so the
 * marker is what "reuse" means: while it stands, no second issue is made.
 * The next successful token check clears both markers, so a later incident
 * is reported again.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfigDraft } from "../config.js";
import type { OnceStore } from "../features/spend-guard/support.js";
import { hostRefused } from "../insights/fatigue-issues.js";
import { TOKEN_INVALID_ERROR_CLASS, type MetaGraphError, type OperatorErrorClass } from "../meta/errors.js";
import { redactText } from "../meta/redact.js";

export const TOKEN_ALERT_KIND = "token_alert";
export const TOKEN_ISSUE_KIND = "token_issue";

/** `rk9-ads:<brand>:<class>`: the issue originId and its dedupe marker. */
export function tokenIncidentKey(brandCode: string, errorClass: OperatorErrorClass = TOKEN_INVALID_ERROR_CLASS): string {
  return `rk9-ads:${brandCode}:${errorClass}`;
}

export function tokenAlertKey(brandCode: string, errorClass: OperatorErrorClass = TOKEN_INVALID_ERROR_CLASS): string {
  return `token-alert:${brandCode}:${errorClass}`;
}

export interface TokenAlertDeps {
  ctx: Pick<PluginContext, "issues" | "logger">;
  store: OnceStore;
  pluginId: string;
  /** Sends one plain message to the brand chat. Throws when it did not go out. */
  sendTelegram(companyId: string, config: BrandConfigDraft, text: string): Promise<"sent" | "not_configured">;
}

export interface TokenIncidentReport {
  errorClass: OperatorErrorClass;
  telegram: "sent" | "already_sent" | "not_configured" | "failed";
  issue: "created" | "exists" | "failed";
}

function safe(error: unknown): string {
  return redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
}

export function tokenAlertText(config: BrandConfigDraft, error: MetaGraphError, context: string): string {
  const name = config.displayName || config.brandCode;
  return [
    `🔑 ${name}: Meta-token ei kelpaa (Graph ${error.code ?? 190}${error.subcode ? `/${error.subcode}` : ""}).`,
    `Toiminto ${context} epäonnistui eikä sitä yritetä uudelleen.`,
    "Luo system userille uusi token ja päivitä secret, johon meta.accessTokenRef osoittaa. Aja sitten Tarkista yhteys.",
  ].join("\n");
}

export function tokenIssueBody(config: BrandConfigDraft, error: MetaGraphError, context: string): { title: string; description: string } {
  return {
    title: `${config.brandCode}: Meta-token ei kelpaa, kierrä system user -token`,
    description: [
      `RK9 Ads sai Metalta virheen 190 (token vanhentunut, peruttu tai virheellinen). Toiminto **${context}** epäonnistui, eikä sitä yritetä uudelleen.`,
      "",
      `- Graph code ${error.code ?? 190}, subcode ${error.subcode ?? "-"}, fbtrace_id ${error.fbtraceId ?? "-"}`,
      `- Mainostili act_${config.meta.adAccountId}`,
      "",
      "Korjaus:",
      "1. Luo Business Settingsissä brändin system userille uusi token (ads_management, ads_read).",
      "2. Päivitä company secret, johon pluginin `meta.accessTokenRef` osoittaa.",
      "3. Aja pluginin asetussivulla **Tarkista yhteys**. Onnistunut tarkistus nollaa tämän hälytyksen.",
      "4. Sulje tämä issue.",
    ].join("\n"),
  };
}

/** Reports one 190. Never throws: the caller still fails its own job with the original error. */
export async function reportTokenInvalid(
  deps: TokenAlertDeps,
  companyId: string,
  config: BrandConfigDraft,
  error: MetaGraphError,
  context: string,
): Promise<TokenIncidentReport> {
  const errorClass = TOKEN_INVALID_ERROR_CLASS;
  const report: TokenIncidentReport = { errorClass, telegram: "already_sent", issue: "exists" };
  const logMeta = { companyId, brandCode: config.brandCode, errorClass, subcode: error.subcode, context };

  try {
    const alertKey = tokenAlertKey(config.brandCode, errorClass);
    if (await deps.store.claim(companyId, alertKey, TOKEN_ALERT_KIND, { subcode: error.subcode, context })) {
      try {
        report.telegram = await deps.sendTelegram(companyId, config, tokenAlertText(config, error, context));
        if (report.telegram === "not_configured") await deps.store.release(companyId, alertKey);
      } catch (sendError) {
        report.telegram = "failed";
        await deps.store.release(companyId, alertKey);
        deps.ctx.logger.warn("rk9-ads token alert: Telegram send failed; retried next time", { ...logMeta, error: safe(sendError) });
      }
    }
  } catch (markerError) {
    report.telegram = "failed";
    deps.ctx.logger.warn("rk9-ads token alert: marker failed", { ...logMeta, error: safe(markerError) });
  }

  const incidentKey = tokenIncidentKey(config.brandCode, errorClass);
  let claimed = false;
  try {
    claimed = await deps.store.claim(companyId, incidentKey, TOKEN_ISSUE_KIND, { subcode: error.subcode, context });
  } catch (markerError) {
    report.issue = "failed";
    deps.ctx.logger.warn("rk9-ads token alert: issue marker failed", { ...logMeta, error: safe(markerError) });
  }
  if (claimed) {
    try {
      const body = tokenIssueBody(config, error, context);
      await deps.ctx.issues.create({
        companyId,
        title: body.title,
        description: body.description,
        status: "todo",
        priority: "high",
        originKind: `plugin:${deps.pluginId}`,
        originId: incidentKey,
      });
      report.issue = "created";
    } catch (createError) {
      report.issue = "failed";
      const refused = hostRefused(createError);
      deps.ctx.logger.warn(refused ? "rk9-ads token alert: issue create refused; retried next time" : "rk9-ads token alert: issue create outcome unknown; not retried", {
        ...logMeta,
        error: safe(createError),
      });
      if (refused) await deps.store.release(companyId, incidentKey).catch(() => undefined);
    }
  }
  deps.ctx.logger.error("rk9-ads: Meta token invalid", { ...logMeta, telegram: report.telegram, issue: report.issue });
  return report;
}

/** A successful token check ends the incident: the next 190 is reported again. */
export async function clearTokenIncident(deps: Pick<TokenAlertDeps, "store" | "ctx">, companyId: string, brandCode: string): Promise<void> {
  try {
    await deps.store.release(companyId, tokenAlertKey(brandCode));
    await deps.store.release(companyId, tokenIncidentKey(brandCode));
  } catch (error) {
    deps.ctx.logger.warn("rk9-ads token alert: could not clear the incident markers", { companyId, error: safe(error) });
  }
}
