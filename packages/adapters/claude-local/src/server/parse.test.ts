import { describe, expect, it } from "vitest";
import {
  claudeModelUsageTotals,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  extractClaudeLoginUrl,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
} from "./parse.js";

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeModelNotFoundError", () => {
  it("detects model resolution failures from structured and fallback output", () => {
    expect(isClaudeModelNotFoundError({
      parsed: {
        result: "API Error: 404 model not found: claude-haiku-4-6",
      },
    })).toBe(true);
    expect(isClaudeModelNotFoundError({
      stderr: "Unknown model claude-haiku-4-6",
    })).toBe(true);
  });

  it("does not classify unrelated provider failures as model resolution errors", () => {
    expect(isClaudeModelNotFoundError({
      errorMessage: "API Error: 503 service unavailable",
    })).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
  });

  it("classifies Claude session-limit windows as provider quota and extracts the retry time", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});

describe("parseClaudeStreamJson", () => {
  it("extracts session id, model, cost, usage, and summary from a complete stream", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess_abc123",
        model: "claude-sonnet-4-20250514",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess_abc123",
        message: {
          content: [{ type: "text", text: "Hello from Claude" }],
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess_abc123",
        result: "Task completed successfully.",
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 150,
          cache_read_input_tokens: 30,
          output_tokens: 60,
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.sessionId).toBe("sess_abc123");
    expect(parsed.model).toBe("claude-sonnet-4-20250514");
    expect(parsed.costUsd).toBeCloseTo(0.0042, 6);
    expect(parsed.usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 30,
      outputTokens: 60,
    });
    expect(parsed.summary).toBe("Task completed successfully.");
    expect(parsed.resultJson).not.toBeNull();
  });

  it("returns assistant text as summary when no result event is present", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess_noResult",
        model: "claude-opus-4-20250514",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First paragraph" },
            { type: "text", text: "Second paragraph" },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.sessionId).toBe("sess_noResult");
    expect(parsed.summary).toBe("First paragraph\n\nSecond paragraph");
    expect(parsed.costUsd).toBeNull();
    expect(parsed.usage).toBeNull();
    expect(parsed.resultJson).toBeNull();
  });

  it("handles empty stdout gracefully", () => {
    const parsed = parseClaudeStreamJson("");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.model).toBe("");
    expect(parsed.summary).toBe("");
    expect(parsed.costUsd).toBeNull();
    expect(parsed.usage).toBeNull();
  });

  it("skips non-JSON lines without crashing", () => {
    const stdout = [
      "some random debug output",
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" }),
      "another noisy line",
      JSON.stringify({ type: "result", result: "Done", usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 }, total_cost_usd: 0.001 }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.summary).toBe("Done");
  });

  it("ignores non-text content blocks in assistant messages", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "bash", input: "ls" },
            { type: "text", text: "Here are the files" },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.summary).toBe("Here are the files");
  });
});

describe("extractClaudeLoginUrl", () => {
  it("extracts an anthropic auth URL", () => {
    const text = "Please visit https://console.anthropic.com/auth/login to log in.";
    expect(extractClaudeLoginUrl(text)).toBe("https://console.anthropic.com/auth/login");
  });

  it("extracts a claude URL when multiple URLs are present", () => {
    const text = "Go to https://example.com/unrelated or https://claude.ai/auth/callback for login.";
    expect(extractClaudeLoginUrl(text)).toBe("https://claude.ai/auth/callback");
  });

  it("returns the first URL if no claude/anthropic/auth URL is found", () => {
    const text = "Visit https://example.com/dashboard for help.";
    expect(extractClaudeLoginUrl(text)).toBe("https://example.com/dashboard");
  });

  it("returns null for text with no URLs", () => {
    expect(extractClaudeLoginUrl("No URLs here")).toBeNull();
  });
});

describe("detectClaudeLoginRequired", () => {
  it("detects login required from parsed result", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "not logged in" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from stderr", () => {
    const result = detectClaudeLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Please run `claude login` first",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from error messages", () => {
    const result = detectClaudeLoginRequired({
      parsed: { errors: ["authentication required"] },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("returns false when no login is required", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "Task completed" },
      stdout: "all good",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
  });

  it("extracts login URL when present", () => {
    const result = detectClaudeLoginRequired({
      parsed: null,
      stdout: "Please log in at https://console.anthropic.com/auth/login",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
    expect(result.loginUrl).toBe("https://console.anthropic.com/auth/login");
  });
});

describe("describeClaudeFailure", () => {
  it("includes subtype and result detail", () => {
    const desc = describeClaudeFailure({
      subtype: "error_max_turns",
      result: "Reached maximum turns",
    });
    expect(desc).toBe("Claude run failed: subtype=error_max_turns: Reached maximum turns");
  });

  it("falls back to error messages when result is empty", () => {
    const desc = describeClaudeFailure({
      errors: ["something broke"],
    });
    expect(desc).toBe("Claude run failed: something broke");
  });

  it("returns null when there is no detail", () => {
    expect(describeClaudeFailure({})).toBeNull();
  });
});

describe("isClaudeMaxTurnsResult", () => {
  it("detects error_max_turns subtype", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "error_max_turns" })).toBe(true);
  });

  it("detects max_turns stop_reason", () => {
    expect(isClaudeMaxTurnsResult({ stop_reason: "max_turns" })).toBe(true);
  });

  // --- RK9 Custom: v2026.720.0 detects max turns from structured fields only, so the fork's
  // free-text case now expects false ---
  it("ignores max-turns wording in free result text", () => {
    expect(isClaudeMaxTurnsResult({ result: "Reached maximum turns limit" })).toBe(false);
  });

  it("returns false for normal results", () => {
    expect(isClaudeMaxTurnsResult({ result: "Completed normally" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isClaudeMaxTurnsResult(null)).toBe(false);
    expect(isClaudeMaxTurnsResult(undefined)).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects 'no conversation found with session id'", () => {
    expect(
      isClaudeUnknownSessionError({ result: "no conversation found with session id sess_abc" }),
    ).toBe(true);
  });

  it("detects 'unknown session'", () => {
    expect(
      isClaudeUnknownSessionError({ errors: ["unknown session"] }),
    ).toBe(true);
  });

  it("detects 'session ... not found'", () => {
    expect(
      isClaudeUnknownSessionError({ result: "session sess_xyz not found" }),
    ).toBe(true);
  });

  it("does not classify unrelated failures as stale sessions", () => {
    expect(isClaudeUnknownSessionError({ result: "model overloaded" })).toBe(false);
    expect(isClaudeUnknownSessionError({ errors: ["rate limited"] })).toBe(false);
  });
});

describe("claudeModelUsageTotals", () => {
  it("sums per-model usage across models and counts cache writes as input", () => {
    const totals = claudeModelUsageTotals({
      "claude-fable-5": {
        inputTokens: 100,
        outputTokens: 70_000,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 4_000,
        costUSD: 1.2,
      },
      "claude-haiku-4-5": {
        inputTokens: 50,
        outputTokens: 7_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 500,
        costUSD: 0.05,
      },
    });
    expect(totals).toEqual({
      inputTokens: 4_650,
      outputTokens: 77_000,
      cachedInputTokens: 260_000,
    });
  });

  it("returns null for missing or empty modelUsage", () => {
    expect(claudeModelUsageTotals(undefined)).toBeNull();
    expect(claudeModelUsageTotals({})).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  const resultEvent = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 1_800, cache_read_input_tokens: 20 },
      ...extra,
    });

  it("prefers modelUsage totals over the main-loop usage block and marks them per-run", () => {
    const parsed = parseClaudeStreamJson(
      `${resultEvent({
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 90,
            outputTokens: 77_000,
            cacheReadInputTokens: 300_000,
            cacheCreationInputTokens: 2_000,
          },
        },
      })}\n`,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 2_090,
      outputTokens: 77_000,
      cachedInputTokens: 300_000,
    });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(1.25);
  });

  it("falls back to the result usage block when modelUsage is absent", () => {
    const parsed = parseClaudeStreamJson(`${resultEvent({})}\n`);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1_800,
      cachedInputTokens: 20,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});
