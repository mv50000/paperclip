import { describe, expect, it } from "vitest";
import {
  parseGeminiJsonl,
  isGeminiUnknownSessionError,
  describeGeminiFailure,
  detectGeminiAuthRequired,
  detectGeminiQuotaExhausted,
  isGeminiTurnLimitResult,
} from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("parses session id, assistant text, usage, cost from a complete stream", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        session_id: "gem_sess_1",
        message: {
          content: [{ type: "text", text: "Hello from Gemini" }],
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "gem_sess_1",
        result: "Done",
        total_cost_usd: 0.002,
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
        },
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.sessionId).toBe("gem_sess_1");
    expect(parsed.summary).toBe("Hello from Gemini");
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.002, 6);
    expect(parsed.errorMessage).toBeNull();
  });

  it("reads session id from checkpoint_id or thread_id", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      checkpoint_id: "chk_abc",
      message: "text",
    });
    expect(parseGeminiJsonl(stdout).sessionId).toBe("chk_abc");

    const stdout2 = JSON.stringify({
      type: "assistant",
      thread_id: "thread_xyz",
      message: "text",
    });
    expect(parseGeminiJsonl(stdout2).sessionId).toBe("thread_xyz");
  });

  it("uses result text as summary when no assistant messages present", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "Refactored the module",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.summary).toBe("Refactored the module");
  });

  it("accumulates usage from Gemini usageMetadata format", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        usage: {
          usageMetadata: {
            promptTokenCount: 80,
            cachedContentTokenCount: 15,
            candidatesTokenCount: 40,
          },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        usage: {
          usageMetadata: {
            promptTokenCount: 20,
            cachedContentTokenCount: 5,
            candidatesTokenCount: 10,
          },
        },
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(20);
    expect(parsed.usage.outputTokens).toBe(50);
  });

  it("captures error messages from error events", () => {
    const stdout = JSON.stringify({
      type: "error",
      message: "model overloaded",
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.errorMessage).toBe("model overloaded");
  });

  it("captures error from result events with is_error", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      error: "API key invalid",
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.errorMessage).toBe("API key invalid");
  });

  it("captures error from system events with error subtype", () => {
    const stdout = JSON.stringify({
      type: "system",
      subtype: "error",
      message: "sandbox failure",
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.errorMessage).toBe("sandbox failure");
  });

  it("parses question/choice interactions", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "question",
            prompt: "Which option?",
            choices: [
              { key: "a", label: "Option A", description: "First option" },
              { key: "b", label: "Option B" },
            ],
          },
        ],
      },
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.question).not.toBeNull();
    expect(parsed.question!.prompt).toBe("Which option?");
    expect(parsed.question!.choices).toHaveLength(2);
    expect(parsed.question!.choices[0].key).toBe("a");
    expect(parsed.question!.choices[1].description).toBeUndefined();
  });

  it("handles text-type events for backwards compatibility", () => {
    const stdout = JSON.stringify({
      type: "text",
      part: { text: "Legacy text" },
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.summary).toBe("Legacy text");
  });

  it("collects content-type blocks in assistant messages", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "content", content: "From content block" },
          { type: "output_text", text: "From output_text block" },
        ],
      },
    });

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.summary).toContain("From content block");
    expect(parsed.summary).toContain("From output_text block");
  });

  it("handles empty stdout gracefully", () => {
    const parsed = parseGeminiJsonl("");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.costUsd).toBeNull();
    expect(parsed.question).toBeNull();
  });

  it("accumulates usage from step_finish events and takes latest cost", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        usage: { input_tokens: 50, output_tokens: 25 },
        cost_usd: 0.001,
      }),
      JSON.stringify({
        type: "step_finish",
        usage: { input_tokens: 30, output_tokens: 15 },
        cost_usd: 0.002,
      }),
    ].join("\n");

    const parsed = parseGeminiJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(40);
    // cost is overwritten (not accumulated) — last event wins
    expect(parsed.costUsd).toBeCloseTo(0.002, 6);
  });
});

describe("isGeminiUnknownSessionError", () => {
  it("detects 'unknown session'", () => {
    expect(isGeminiUnknownSessionError("unknown session abc", "")).toBe(true);
  });

  it("detects 'session ... not found'", () => {
    expect(isGeminiUnknownSessionError("", "session abc not found")).toBe(true);
  });

  it("detects 'checkpoint ... not found'", () => {
    expect(isGeminiUnknownSessionError("checkpoint chk_1 not found", "")).toBe(true);
  });

  it("detects 'cannot resume'", () => {
    expect(isGeminiUnknownSessionError("", "cannot resume session")).toBe(true);
  });

  it("detects 'failed to resume'", () => {
    expect(isGeminiUnknownSessionError("failed to resume", "")).toBe(true);
  });

  it("does not classify unrelated failures as stale sessions", () => {
    expect(isGeminiUnknownSessionError("model overloaded", "")).toBe(false);
    expect(isGeminiUnknownSessionError("", "rate limit exceeded")).toBe(false);
  });
});

describe("describeGeminiFailure", () => {
  it("includes status and error detail", () => {
    const desc = describeGeminiFailure({
      status: "FAILED",
      errors: ["something broke"],
    });
    expect(desc).toBe("Gemini run failed: status=FAILED: something broke");
  });

  it("includes error from error field", () => {
    const desc = describeGeminiFailure({
      error: "connection timeout",
    });
    expect(desc).toBe("Gemini run failed: connection timeout");
  });

  it("returns null when there is no detail", () => {
    expect(describeGeminiFailure({})).toBeNull();
  });
});

describe("detectGeminiAuthRequired", () => {
  it("detects auth required from stderr", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "",
      stderr: "API key required",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'not authenticated' pattern", () => {
    const result = detectGeminiAuthRequired({
      parsed: { errors: ["not authenticated"] },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("detects 'run gemini auth login first' pattern", () => {
    const result = detectGeminiAuthRequired({
      parsed: null,
      stdout: "run `gemini auth login` first",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("returns false when auth is not required", () => {
    const result = detectGeminiAuthRequired({
      parsed: { result: "completed" },
      stdout: "all good",
      stderr: "",
    });
    expect(result.requiresAuth).toBe(false);
  });
});

describe("detectGeminiQuotaExhausted", () => {
  it("detects resource_exhausted", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: { errors: ["RESOURCE_EXHAUSTED"] },
      stdout: "",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects 429 status code", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "",
      stderr: "HTTP 429 Too Many Requests",
    });
    expect(result.exhausted).toBe(true);
  });

  it("detects rate limit", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "rate-limit exceeded",
      stderr: "",
    });
    expect(result.exhausted).toBe(true);
  });

  it("returns false when quota is fine", () => {
    const result = detectGeminiQuotaExhausted({
      parsed: null,
      stdout: "completed normally",
      stderr: "",
    });
    expect(result.exhausted).toBe(false);
  });
});

describe("isGeminiTurnLimitResult", () => {
  it("detects exit code 53", () => {
    expect(isGeminiTurnLimitResult(null, 53)).toBe(true);
  });

  it("detects turn_limit status", () => {
    expect(isGeminiTurnLimitResult({ status: "turn_limit" })).toBe(true);
  });

  it("detects max_turns status", () => {
    expect(isGeminiTurnLimitResult({ status: "max_turns" })).toBe(true);
  });

  it("detects turn limit in error text", () => {
    expect(isGeminiTurnLimitResult({ error: "Turn limit reached" })).toBe(true);
    expect(isGeminiTurnLimitResult({ error: "maximum turns exceeded" })).toBe(true);
  });

  it("returns false for normal results", () => {
    expect(isGeminiTurnLimitResult({ status: "done" })).toBe(false);
    expect(isGeminiTurnLimitResult({ error: "some other error" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isGeminiTurnLimitResult(null)).toBe(false);
    expect(isGeminiTurnLimitResult(undefined)).toBe(false);
  });
});
