import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { risksApi, type RiskEntry, type RiskIncident } from "../api/risks";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { MetricCard } from "../components/MetricCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Activity,
  TrendingUp,
  Play,
  Check,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLORS: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-yellow-600 dark:text-yellow-400",
  low: "text-blue-600 dark:text-blue-400",
};

const DOMAIN_LABELS: Record<string, string> = {
  operational: "Operational",
  financial: "Financial",
  governance: "Governance",
  compliance: "Compliance",
};

type Tab = "overview" | "risks" | "incidents";

export function RiskManagement() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [riskStatusFilter, setRiskStatusFilter] = useState<string>("open");

  useEffect(() => {
    setBreadcrumbs([{ label: "Risks" }]);
  }, [setBreadcrumbs]);

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: queryKeys.risks.summary(selectedCompanyId!),
    queryFn: () => risksApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: risks, isLoading: risksLoading } = useQuery({
    queryKey: queryKeys.risks.list(selectedCompanyId!, riskStatusFilter),
    queryFn: () => risksApi.list(selectedCompanyId!, { status: riskStatusFilter }),
    enabled: !!selectedCompanyId,
  });

  const { data: incidents, isLoading: incidentsLoading } = useQuery({
    queryKey: queryKeys.risks.incidents(selectedCompanyId!),
    queryFn: () => risksApi.listIncidents(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const runMonitorsMutation = useMutation({
    mutationFn: () => risksApi.runMonitors(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risks"] });
    },
  });

  const acknowledgeIncident = useMutation({
    mutationFn: (incidentId: string) =>
      risksApi.updateIncident(selectedCompanyId!, incidentId, { action: "acknowledge" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risks"] });
    },
  });

  const resolveIncident = useMutation({
    mutationFn: (incidentId: string) =>
      risksApi.updateIncident(selectedCompanyId!, incidentId, { action: "resolve", resolutionNote: "Resolved via dashboard" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["risks"] });
    },
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-4">Select a company first.</p>;
  }

  if (summaryLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const openIncidents = incidents?.filter((i) =>
    ["detected", "acknowledged", "investigating", "mitigating"].includes(i.status),
  ) ?? [];

  return (
    <div className="space-y-6 p-1">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        {(["overview", "risks", "incidents"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "overview" ? "Overview" : t === "risks" ? "Risk Registry" : "Incidents"}
            {t === "incidents" && openIncidents.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 text-xs font-medium min-w-[18px] h-[18px] px-1">
                {openIncidents.length}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => runMonitorsMutation.mutate()}
          disabled={runMonitorsMutation.isPending}
          className="mb-1"
        >
          <Play className="h-3.5 w-3.5 mr-1.5" />
          {runMonitorsMutation.isPending ? "Running..." : "Run Monitors"}
        </Button>
      </div>

      {tab === "overview" && summary && <OverviewTab summary={summary} openIncidents={openIncidents} />}
      {tab === "risks" && (
        <RisksTab
          risks={risks ?? []}
          isLoading={risksLoading}
          statusFilter={riskStatusFilter}
          onStatusFilterChange={setRiskStatusFilter}
        />
      )}
      {tab === "incidents" && (
        <IncidentsTab
          incidents={incidents ?? []}
          isLoading={incidentsLoading}
          onAcknowledge={(id) => acknowledgeIncident.mutate(id)}
          onResolve={(id) => resolveIncident.mutate(id)}
        />
      )}
    </div>
  );
}

function OverviewTab({
  summary,
  openIncidents,
}: {
  summary: NonNullable<Awaited<ReturnType<typeof risksApi.summary>>>;
  openIncidents: RiskIncident[];
}) {
  const scoreColor =
    summary.overallScore >= 50 ? "text-red-600" : summary.overallScore >= 25 ? "text-orange-600" : "text-green-600";

  return (
    <div className="space-y-6">
      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border rounded-lg overflow-hidden border border-border">
        <MetricCard
          icon={Shield}
          value={summary.overallScore}
          label="Risk Score"
          description={<span className={scoreColor}>{summary.overallScore >= 50 ? "High risk" : summary.overallScore >= 25 ? "Elevated" : "Acceptable"}</span>}
        />
        <MetricCard
          icon={AlertTriangle}
          value={summary.openRisks}
          label="Open Risks"
        />
        <MetricCard
          icon={ShieldAlert}
          value={summary.openIncidents}
          label="Open Incidents"
        />
        <MetricCard
          icon={Activity}
          value={summary.trend.length}
          label="Snapshots"
          description="Data points for trending"
        />
      </div>

      {/* Domain scores */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Object.entries(summary.domainScores).map(([domain, score]) => (
          <div key={domain} className="rounded-lg border border-border p-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {DOMAIN_LABELS[domain] ?? domain}
            </p>
            <p className="text-2xl font-semibold mt-1 tabular-nums">{score}</p>
          </div>
        ))}
      </div>

      {/* Top risks */}
      {summary.topRisks.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Top Risks</h3>
          <div className="grid gap-2">
            {summary.topRisks.map((risk) => (
              <RiskRow key={risk.id} risk={risk} />
            ))}
          </div>
        </div>
      )}

      {/* Open incidents */}
      {openIncidents.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Open Incidents</h3>
          <div className="grid gap-2">
            {openIncidents.map((incident) => (
              <div key={incident.id} className="rounded-lg border border-border p-4 flex items-center gap-3">
                <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{incident.title}</p>
                  <p className="text-xs text-muted-foreground">{timeAgo(incident.detectedAt)}</p>
                </div>
                <StatusBadge status={incident.severity} />
                <StatusBadge status={incident.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trend chart placeholder */}
      {summary.trend.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Risk Score Trend</h3>
          <div className="rounded-lg border border-border p-4">
            <div className="flex items-end gap-1 h-24">
              {summary.trend.map((s, i) => {
                const maxScore = Math.max(...summary.trend.map((t) => t.overallScore), 1);
                const height = Math.max((s.overallScore / maxScore) * 100, 4);
                const color = s.overallScore >= 50 ? "bg-red-400" : s.overallScore >= 25 ? "bg-orange-400" : "bg-green-400";
                return (
                  <div
                    key={i}
                    className={cn("flex-1 rounded-t", color)}
                    style={{ height: `${height}%` }}
                    title={`${new Date(s.snapshotAt).toLocaleDateString()}: Score ${s.overallScore}`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between mt-2">
              <span className="text-xs text-muted-foreground">
                {summary.trend.length > 0 && new Date(summary.trend[0].snapshotAt).toLocaleDateString()}
              </span>
              <span className="text-xs text-muted-foreground">
                {summary.trend.length > 0 && new Date(summary.trend[summary.trend.length - 1].snapshotAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RisksTab({
  risks,
  isLoading,
  statusFilter,
  onStatusFilterChange,
}: {
  risks: RiskEntry[];
  isLoading: boolean;
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
}) {
  const statuses = ["open", "escalated", "mitigated", "accepted", "closed"];
  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => onStatusFilterChange(s)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
              statusFilter === s
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-accent",
            )}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      {isLoading && <PageSkeleton variant="list" />}

      {!isLoading && risks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No {statusFilter} risks.</p>
        </div>
      )}

      {!isLoading && risks.length > 0 && (
        <div className="grid gap-2">
          {risks.map((risk) => (
            <RiskRow key={risk.id} risk={risk} />
          ))}
        </div>
      )}
    </div>
  );
}

function RiskRow({ risk }: { risk: RiskEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center gap-3 text-left hover:bg-accent/30 transition-colors"
      >
        <div className={cn("text-sm font-semibold tabular-nums w-8 text-center", SEVERITY_COLORS[risk.severity] ?? "text-muted-foreground")}>
          {risk.riskScore}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{risk.title}</p>
          <p className="text-xs text-muted-foreground">
            {risk.scopeType} &middot; {risk.sourceMonitor ?? risk.source} &middot; {timeAgo(risk.detectedAt)}
          </p>
        </div>
        <StatusBadge status={risk.severity} />
        <StatusBadge status={risk.status} />
      </button>
      {expanded && risk.evidenceJson && (
        <div className="px-4 pb-4 pt-0 border-t border-border">
          <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-3 overflow-x-auto">
            {JSON.stringify(risk.evidenceJson, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function IncidentsTab({
  incidents,
  isLoading,
  onAcknowledge,
  onResolve,
}: {
  incidents: RiskIncident[];
  isLoading: boolean;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
}) {
  if (isLoading) return <PageSkeleton variant="list" />;

  if (incidents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No incidents.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {incidents.map((incident) => (
        <div key={incident.id} className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{incident.title}</p>
              <p className="text-xs text-muted-foreground">
                Detected {timeAgo(incident.detectedAt)}
                {incident.playbookCode && <> &middot; Playbook: {incident.playbookCode}</>}
              </p>
            </div>
            <StatusBadge status={incident.severity} />
            <StatusBadge status={incident.status} />
          </div>

          {/* Auto actions */}
          {incident.autoActions && incident.autoActions.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Auto-actions: {incident.autoActions.map((a) => (a as Record<string, unknown>).type).join(", ")}
            </div>
          )}

          {/* Timeline */}
          {incident.timelineJson.length > 0 && (
            <div className="space-y-1 pl-7">
              {incident.timelineJson.map((entry, i) => {
                const e = entry as { timestamp: string; actor: string; action: string; detail: string };
                return (
                  <div key={i} className="text-xs text-muted-foreground flex gap-2">
                    <span className="font-mono text-muted-foreground/60 shrink-0">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="font-medium">{e.action}</span>
                    <span className="truncate">{e.detail}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions */}
          {(incident.status === "detected" || incident.status === "acknowledged") && (
            <div className="flex gap-2 pl-7">
              {incident.status === "detected" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onAcknowledge(incident.id)}
                >
                  <Eye className="h-3.5 w-3.5 mr-1.5" />
                  Acknowledge
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => onResolve(incident.id)}
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Resolve
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
