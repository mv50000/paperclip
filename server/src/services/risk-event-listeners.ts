import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeAllLiveEvents } from "./live-events.js";
import { riskMonitorService } from "./risk-monitors.js";
import { logger } from "../middleware/logger.js";

const DEBOUNCE_MS = 30_000;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function startRiskEventListeners(db: Db) {
  const monitors = riskMonitorService(db);

  function scheduleCheck(key: string, companyId: string, runMonitor: (id: string) => Promise<unknown>) {
    const debounceKey = `${companyId}:${key}`;
    if (pending.has(debounceKey)) return;

    const timer = setTimeout(() => {
      pending.delete(debounceKey);
      void runMonitor(companyId).catch((err) => {
        logger.error({ err, companyId, monitor: key }, "event-driven risk monitor failed");
      });
    }, DEBOUNCE_MS);
    pending.set(debounceKey, timer);
  }

  subscribeAllLiveEvents((event: LiveEvent) => {
    if (event.companyId === "*") return;

    if (event.type === "heartbeat.run.status") {
      const status = (event.payload as Record<string, unknown>)?.status;
      if (status === "failed" || status === "error" || status === "timed_out") {
        scheduleCheck("execution_pattern", event.companyId, monitors.runExecutionPatternAnalyzer);
      }
    }

    if (event.type === "activity.logged") {
      const activityType = (event.payload as Record<string, unknown>)?.type;
      if (activityType === "cost_event.created" || activityType === "budget.exceeded") {
        scheduleCheck("cost_anomaly", event.companyId, monitors.runCostAnomalyDetector);
      }
    }
  });

  logger.info("risk event listeners started");
}
