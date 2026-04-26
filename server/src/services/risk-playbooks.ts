import type { RiskCategoryCode } from "@paperclipai/shared";

export interface PlaybookAutoAction {
  type: string;
  description: string;
}

export interface Playbook {
  code: string;
  name: string;
  autoActions: PlaybookAutoAction[];
  manualSteps: string[];
  escalationPath: string[];
  resolutionCriteria: string[];
}

export const PLAYBOOKS: Partial<Record<RiskCategoryCode, Playbook>> = {
  AGENT_CRASH_LOOP: {
    code: "AGENT_CRASH_LOOP",
    name: "Agent Crash Loop Response",
    autoActions: [
      { type: "pause_agent", description: "Pause the crashing agent" },
      { type: "reassign_tasks", description: "Move in-progress tasks to backlog" },
      { type: "create_approval", description: "Create board approval for investigation" },
    ],
    manualSteps: [
      "Review last 5 heartbeat run logs for root cause",
      "Check if adapter config changed recently",
      "Verify execution workspace is healthy",
      "Fix root cause and resume agent",
    ],
    escalationPath: ["meta-agent", "cto", "board"],
    resolutionCriteria: [
      "Agent has 3+ consecutive successful runs after fix",
      "Root cause documented in incident resolution note",
    ],
  },
  COST_RUNAWAY: {
    code: "COST_RUNAWAY",
    name: "Runaway Spending Response",
    autoActions: [
      { type: "lock_budget", description: "Lock the company budget" },
      { type: "create_approval", description: "Create board approval for budget review" },
    ],
    manualSteps: [
      "Identify which agents are driving the spike",
      "Check for stuck or looping heartbeats",
      "Review cost events for anomalous patterns",
      "Adjust budgets or pause problematic agents",
    ],
    escalationPath: ["cfo", "ceo", "board"],
    resolutionCriteria: [
      "Spending rate returned to normal levels for 24h",
      "Root cause identified and addressed",
    ],
  },
  AGENT_SILENT: {
    code: "AGENT_SILENT",
    name: "Silent Agent Response",
    autoActions: [
      { type: "create_approval", description: "Create board notification" },
    ],
    manualSteps: [
      "Check agent process status and logs",
      "Verify heartbeat schedule is correctly configured",
      "Check for infrastructure issues (disk, network)",
      "Restart agent if process is dead",
    ],
    escalationPath: ["cto", "board"],
    resolutionCriteria: [
      "Agent has resumed heartbeat runs",
      "Root cause identified",
    ],
  },
  COMPLIANCE_DRIFT: {
    code: "COMPLIANCE_DRIFT",
    name: "Compliance Drift Response",
    autoActions: [
      { type: "create_approval", description: "Create board approval for compliance review" },
    ],
    manualSteps: [
      "Identify which compliance requirements are not met",
      "Review recent configuration changes",
      "Create remediation tasks",
      "Verify compliance after remediation",
    ],
    escalationPath: ["legal-officer", "ceo", "board"],
    resolutionCriteria: [
      "All compliance requirements met",
      "Governance drift detector confirms compliance",
    ],
  },
  BLOCKER_CHAIN: {
    code: "BLOCKER_CHAIN",
    name: "Blocker Chain Resolution",
    autoActions: [],
    manualSteps: [
      "Map the full blocker dependency chain",
      "Identify the root blocker",
      "Assign the root blocker to appropriate agent",
      "Set critical priority on root blocker",
    ],
    escalationPath: ["cto", "ceo"],
    resolutionCriteria: [
      "Root blocker resolved",
      "All downstream issues unblocked",
    ],
  },
};
