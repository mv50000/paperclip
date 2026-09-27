import type {
  InstanceExperimentalSettingsWithManaged,
  InstanceGeneralSettings,
  InstanceSystemPauseState,
  InstanceSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SystemPauseStateResponse {
  state: InstanceSystemPauseState | null;
}

export interface SystemResumeResponse {
  state: null;
  cleared: boolean;
}

export interface ConcurrencyResponse {
  maxGlobalConcurrentRuns: number;
  globalRunningCount: number;
  globalAvailableSlots: number;
}

export const instanceSettingsApi = {
  get: () =>
    api.get<InstanceSettings>("/instance/settings"),
  update: (patch: PatchInstanceSettings) =>
    api.patch<InstanceSettings>("/instance/settings", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettingsWithManaged>("/instance/settings/experimental", patch),
  // --- RK9 Custom --- system pause + global concurrency
  getSystemPauseState: () =>
    api.get<SystemPauseStateResponse>("/instance/system-pause"),
  pauseSystem: (input: { reason?: string } = {}) =>
    api.post<SystemPauseStateResponse>("/instance/system-pause", input),
  resumeSystem: () =>
    api.post<SystemResumeResponse>("/instance/system-resume", {}),
  getConcurrency: () =>
    api.get<ConcurrencyResponse>("/instance/concurrency"),
  previewIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<IssueGraphLivenessAutoRecoveryPreview>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
      input,
    ),
  runIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<{
      findings: number;
      autoRecoveryEnabled: boolean;
      lookbackHours: number;
      cutoff: string;
      escalationsCreated: number;
      existingEscalations: number;
      skipped: number;
      skippedAutoRecoveryDisabled: number;
      skippedOutsideLookback: number;
      dependencyWakeBackstopChecked: number;
      dependencyWakesHealed: number;
      dependencyWakeExistingSkipped: number;
      dependencyWakeLivePathSkipped: number;
      dependencyWakeInteractionSkipped: number;
      dependencyWakePauseHoldSkipped: number;
      dependencyWakeNotReadySkipped: number;
      dependencyWakeCandidateLimitSkipped: number;
      dependencyWakeDeferredOrFailed: number;
      dependencyWakeEnqueueFailed: number;
      dependencyWakeIssueIds: string[];
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
};
