import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
  extractClaudeLoginUrl,
  detectClaudeLoginRequired,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeImageProcessingError,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
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

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
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

  it("detects max turns in result text", () => {
    expect(isClaudeMaxTurnsResult({ result: "Reached maximum turns limit" })).toBe(true);
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
