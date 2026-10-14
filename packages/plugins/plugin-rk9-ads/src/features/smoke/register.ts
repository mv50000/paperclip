import { configSecretRefs } from "../../config.js";
import { listCompanyConfigs } from "../../company-configs.js";
import { localDate, localTime } from "../../kit/local-time.js";
import type { FeatureRuntime } from "../types.js";
import { SMOKE_JOB_KEY } from "./declarations.js";

export const SMOKE_ACTIVITY_MESSAGE = "rk9-ads smoke check";

/**
 * Proves the runtime seams on a live instance: worker fork, job dispatch,
 * per-company config, per-company secret resolution, a company-scoped ledger
 * read and the activity log. Secret values stay in local variables only: the
 * job records whether each ref resolved, never the value or its length.
 */
export function register(runtime: FeatureRuntime): void {
  const { ctx, ledger } = runtime;

  ctx.jobs.register(SMOKE_JOB_KEY, async (job) => {
    const now = new Date();
    const companies = await listCompanyConfigs(ctx);
    let configured = 0;

    for (const { companyId, result } of companies) {
      if (result.state === "absent") continue;
      if (result.state === "unavailable") {
        ctx.logger.warn("rk9-ads smoke: config unavailable", { companyId, error: result.error });
        continue;
      }
      configured += 1;

      if (result.state === "invalid") {
        // Paths only: the messages can echo what the operator typed.
        const paths = result.errors.map((message) => message.split(":")[0]);
        ctx.logger.warn("rk9-ads smoke: invalid config", { companyId, paths });
        await ctx.activity.log({
          companyId,
          message: SMOKE_ACTIVITY_MESSAGE,
          metadata: { runId: job.runId, configState: "invalid", errorCount: result.errors.length },
        });
        continue;
      }

      const { config } = result;
      // Not named "secrets": the host redacts metadata keys that look secret-like.
      const refChecks: Array<{ path: string; resolved: boolean }> = [];
      for (const { configPath, ref } of configSecretRefs(config)) {
        try {
          const value = await ctx.secrets.resolve(ref, { companyId, configPath });
          refChecks.push({ path: configPath, resolved: typeof value === "string" && value.length > 0 });
        } catch (error) {
          refChecks.push({ path: configPath, resolved: false });
          ctx.logger.warn("rk9-ads smoke: secret ref did not resolve", {
            companyId,
            configPath,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }

      const brandBindings = await ledger.count(companyId, "brand_bindings");

      await ctx.activity.log({
        companyId,
        message: SMOKE_ACTIVITY_MESSAGE,
        metadata: {
          runId: job.runId,
          configState: "enabled",
          brandCode: config.brandCode,
          timeZone: config.timeZone,
          localDate: localDate(now, config.timeZone),
          localTime: localTime(now, config.timeZone),
          refChecks,
          brandBindings,
        },
      });
    }

    ctx.logger.info("rk9-ads smoke check done", { runId: job.runId, companies: companies.length, configured });
  });
}
