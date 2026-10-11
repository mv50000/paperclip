// --- RK9 Custom (RK9-490): the services an approved `voice_action` calls for
// the side effects of the same action in the UI. A separate module so route
// tests can replace it with mocks. ---
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues as issueRows } from "@paperclipai/db";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { externalObjectService } from "./external-objects.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  issueRecoveryActionService,
  issueReferenceService,
  issueThreadInteractionService,
  issueTreeControlService,
  routineService,
  taskWatchdogService,
} from "./index.js";
import { issueService } from "./issues.js";
import { runnerGoalService } from "./runner-goals.js";
import type { VoiceActionDeps } from "./rk9-voice-action.js";

export function createVoiceActionDeps(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
): Omit<VoiceActionDeps, "approvalSvc" | "logActivity"> {
  const instanceSettings = instanceSettingsService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  return {
    db,
    issuesSvc: issueService(db),
    heartbeat,
    runnerGoals: runnerGoalService(db),
    recoveryActions: issueRecoveryActionService(db),
    treeControl: issueTreeControlService(db),
    executionWorkspaces: executionWorkspaceService(db),
    interactions: issueThreadInteractionService(db),
    issueReferences: issueReferenceService(db),
    externalObjects: externalObjectService(db, {
      pluginWorkerManager: options.pluginWorkerManager,
      enabled: async () => (await instanceSettings.getExperimental()).enableExternalObjects === true,
    }),
    routines: routineService(db, { pluginWorkerManager: options.pluginWorkerManager }),
    environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: options.pluginWorkerManager }),
    taskWatchdogs: taskWatchdogService(db, { enqueueWakeup: heartbeat.wakeup }),
    markBlockedOwnerNotified: async (issue, notifiedAt) => {
      await db
        .update(issueRows)
        .set({ blockedOwnerNotifiedAt: notifiedAt })
        .where(and(eq(issueRows.id, issue.id), eq(issueRows.companyId, issue.companyId)));
    },
  };
}
// --- end RK9 Custom ---
