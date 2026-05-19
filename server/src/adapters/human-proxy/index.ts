import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "../types.js";

const HUMAN_PROXY_INVOCATION_MESSAGE =
  "Human proxy agent cannot be invoked — assigned issues are picked up manually via /implement.";

async function execute(_ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  throw new Error(HUMAN_PROXY_INVOCATION_MESSAGE);
}

async function testEnvironment(
  _ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "human_proxy",
    status: "pass",
    checks: [
      {
        code: "human_proxy.no_runtime",
        level: "info",
        message:
          "Human proxy agent — no runtime to test. Issues assigned to this agent are handled by a human via /implement.",
      },
    ],
    testedAt: new Date().toISOString(),
  };
}

export const humanProxyAdapter: ServerAdapterModule = {
  type: "human_proxy",
  execute,
  testEnvironment,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: `# human_proxy agent configuration

Adapter: human_proxy

Human-proxy agents are assignment targets only — they never run automatically.
A human picks up the work interactively via \`/implement <ISSUE>\`.

No configuration fields are required. Heartbeat, recovery, assignment-wakeup,
and routines all skip human_proxy agents.
`,
};
