import { afterEach, describe, expect, it } from "vitest";
import {
  INHERIT_OPT_IN_ENV_KEY,
  inheritableHostEnv,
  resolveClaudeBillingTypeForEnv,
} from "@paperclipai/adapter-claude-local/server";

/**
 * RK9-228. On 2026-09-13 an `ANTHROPIC_API_KEY` was added to the Paperclip
 * server's environment so one feature (outreach drafting) could call the
 * Messages API. The claude_local adapter inherited the whole `process.env`, so
 * every heartbeat agent stopped using subscription auth and started billing
 * metered API credit: $19.72 over 38 runs in 31 hours, then the credit ran out
 * and every company's agents died for a day and a half.
 *
 * These tests pin the rule that came out of it: API-key auth is a per-agent
 * choice, never something an agent inherits because the server happens to have
 * a key set for something else.
 */
const ORIGINAL_OPT_IN = process.env[INHERIT_OPT_IN_ENV_KEY];

afterEach(() => {
  if (ORIGINAL_OPT_IN === undefined) {
    delete process.env[INHERIT_OPT_IN_ENV_KEY];
  } else {
    process.env[INHERIT_OPT_IN_ENV_KEY] = ORIGINAL_OPT_IN;
  }
});

describe("claude_local host key inheritance", () => {
  it("does not inherit a server-wide ANTHROPIC_API_KEY", () => {
    const hostEnv = { ANTHROPIC_API_KEY: "sk-server-wide", PATH: "/usr/bin" };

    expect(inheritableHostEnv(hostEnv).ANTHROPIC_API_KEY).toBeUndefined();
    expect(inheritableHostEnv(hostEnv).PATH).toBe("/usr/bin");
  });

  it("stays on subscription billing when only the server environment has a key", () => {
    const hostEnv = { ANTHROPIC_API_KEY: "sk-server-wide" };

    expect(resolveClaudeBillingTypeForEnv({}, hostEnv)).toBe("subscription");
  });

  it("uses API-key billing when the agent's own adapter config sets the key", () => {
    const hostEnv = {};

    expect(resolveClaudeBillingTypeForEnv({ ANTHROPIC_API_KEY: "sk-agent" }, hostEnv)).toBe("api");
  });

  it("lets the agent's own key win over an absent inherited one", () => {
    const hostEnv = { ANTHROPIC_API_KEY: "sk-server-wide" };
    const effectiveBilling = resolveClaudeBillingTypeForEnv(
      { ANTHROPIC_API_KEY: "sk-agent" },
      hostEnv,
    );

    expect(effectiveBilling).toBe("api");
  });

  it("inherits the server key only when the deployment opts in", () => {
    const hostEnv = {
      ANTHROPIC_API_KEY: "sk-server-wide",
      [INHERIT_OPT_IN_ENV_KEY]: "1",
    };

    expect(inheritableHostEnv(hostEnv).ANTHROPIC_API_KEY).toBe("sk-server-wide");
    expect(resolveClaudeBillingTypeForEnv({}, hostEnv)).toBe("api");
  });

  it("treats an unset or falsy opt-in as not opting in", () => {
    for (const value of ["", "0", "false", "no", "maybe"]) {
      const hostEnv = {
        ANTHROPIC_API_KEY: "sk-server-wide",
        [INHERIT_OPT_IN_ENV_KEY]: value,
      };

      expect(resolveClaudeBillingTypeForEnv({}, hostEnv)).toBe("subscription");
    }
  });

  it("still reports Bedrock as metered without any Anthropic key", () => {
    const hostEnv = { CLAUDE_CODE_USE_BEDROCK: "1" };

    expect(resolveClaudeBillingTypeForEnv({}, hostEnv)).toBe("metered_api");
  });
});
