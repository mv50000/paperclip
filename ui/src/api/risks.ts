import { api } from "./client";

export interface RiskEntry {
  id: string;
  companyId: string;
  categoryId: string;
  scopeType: string;
  scopeId: string;
  title: string;
  description: string | null;
  status: string;
  severity: string;
  likelihood: string;
  riskScore: number;
  source: string;
  sourceMonitor: string | null;
  detectedAt: string;
  lastEvaluated: string;
  mitigatedAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  evidenceJson: Record<string, unknown> | null;
  mitigationJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskIncident {
  id: string;
  companyId: string;
  riskEntryId: string | null;
  title: string;
  severity: string;
  status: string;
  playbookCode: string | null;
  autoActions: Record<string, unknown>[] | null;
  manualActions: Record<string, unknown>[] | null;
  timelineJson: Record<string, unknown>[];
  assignedTo: string | null;
  approvalId: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskSummary {
  overallScore: number;
  domainScores: Record<string, number>;
  openRisks: number;
  openIncidents: number;
  topRisks: RiskEntry[];
  trend: Array<{
    snapshotAt: string;
    overallScore: number;
    domainScores: Record<string, number>;
    openRisks: number;
    openIncidents: number;
  }>;
}

export interface RiskPolicy {
  id: string;
  companyId: string;
  categoryCode: string;
  enabled: boolean;
  thresholdJson: Record<string, unknown>;
  autoActions: string[] | null;
  escalationSev: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitorResult {
  monitor: string;
  risksCreated: number;
  risksResolved: number;
  incidentsCreated: number;
  errors: string[];
}

export const risksApi = {
  list: (companyId: string, filters?: { status?: string; severity?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.severity) params.set("severity", filters.severity);
    const qs = params.toString();
    return api.get<RiskEntry[]>(`/companies/${companyId}/risks${qs ? `?${qs}` : ""}`);
  },
  get: (companyId: string, riskId: string) =>
    api.get<RiskEntry>(`/companies/${companyId}/risks/${riskId}`),
  update: (companyId: string, riskId: string, data: Record<string, unknown>) =>
    api.patch<RiskEntry>(`/companies/${companyId}/risks/${riskId}`, data),
  summary: (companyId: string) =>
    api.get<RiskSummary>(`/companies/${companyId}/risks/summary`),

  listIncidents: (companyId: string, filters?: { status?: string; severity?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.severity) params.set("severity", filters.severity);
    const qs = params.toString();
    return api.get<RiskIncident[]>(`/companies/${companyId}/incidents${qs ? `?${qs}` : ""}`);
  },
  getIncident: (companyId: string, incidentId: string) =>
    api.get<RiskIncident>(`/companies/${companyId}/incidents/${incidentId}`),
  updateIncident: (companyId: string, incidentId: string, data: Record<string, unknown>) =>
    api.patch<RiskIncident>(`/companies/${companyId}/incidents/${incidentId}`, data),

  listPolicies: (companyId: string) =>
    api.get<RiskPolicy[]>(`/companies/${companyId}/risk-policies`),
  upsertPolicy: (companyId: string, code: string, data: Record<string, unknown>) =>
    api.put<RiskPolicy>(`/companies/${companyId}/risk-policies/${code}`, data),

  runMonitors: (companyId: string) =>
    api.post<{ results: MonitorResult[] }>(`/companies/${companyId}/risks/monitor`, {}),
  takeSnapshot: (companyId: string) =>
    api.post<Record<string, unknown>>(`/companies/${companyId}/risks/snapshot`, {}),

  boardSummary: () =>
    api.get<Array<RiskSummary & { companyId: string; companyName: string }>>("/board/risks"),
};
