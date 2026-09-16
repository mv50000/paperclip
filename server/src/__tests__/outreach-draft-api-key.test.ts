import { afterEach, describe, expect, it } from "vitest";
import { outreachAnthropicApiKey } from "../services/outreach/draft.js";

/**
 * RK9-228: drafting is why a bare `ANTHROPIC_API_KEY` ended up in the server
 * environment, and that key moved the whole agent fleet onto metered billing.
 * Drafting now asks for its own name; the generic one remains a fallback so an
 * existing deployment keeps working until the operator renames the variable.
 */
const ORIGINAL_SPECIFIC = process.env.OUTREACH_ANTHROPIC_API_KEY;
const ORIGINAL_GENERIC = process.env.ANTHROPIC_API_KEY;

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("OUTREACH_ANTHROPIC_API_KEY", ORIGINAL_SPECIFIC);
  restore("ANTHROPIC_API_KEY", ORIGINAL_GENERIC);
});

describe("outreach drafting api key", () => {
  it("prefers the feature-specific variable", () => {
    process.env.OUTREACH_ANTHROPIC_API_KEY = "sk-outreach";
    process.env.ANTHROPIC_API_KEY = "sk-generic";

    expect(outreachAnthropicApiKey()).toBe("sk-outreach");
  });

  it("falls back to the generic variable so existing deployments keep working", () => {
    delete process.env.OUTREACH_ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-generic";

    expect(outreachAnthropicApiKey()).toBe("sk-generic");
  });

  it("reports nothing when neither is set", () => {
    delete process.env.OUTREACH_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(outreachAnthropicApiKey()).toBeUndefined();
  });
});
