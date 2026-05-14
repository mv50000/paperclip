import { describe, expect, it } from "vitest";
import { parseCursorJsonl, isCursorUnknownSessionError } from "./parse.js";

describe("parseCursorJsonl", () => {
  it("parses session id, assistant text, usage, cost, and errors from a complete stream", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        session_id: "cursor_sess_1",
        message: {
          content: [{ type: "text", text: "Hello from Cursor" }],
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "cursor_sess_1",
        result: "Task done",
        total_cost_usd: 0.003,
        usage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 80,
        },
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("cursor_sess_1");
    expect(parsed.summary).toBe("Hello from Cursor");
    expect(parsed.usage).toEqual({
      inputTokens: 200,
      cachedInputTokens: 50,
      outputTokens: 80,
    });
    expect(parsed.costUsd).toBeCloseTo(0.003, 6);
    expect(parsed.errorMessage).toBeNull();
  });

  it("uses result text as summary when no assistant messages present", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        session_id: "s2",
        result: "Completed the refactoring",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.summary).toBe("Completed the refactoring");
  });

  it("captures error messages from error events", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        message: "model unavailable",
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.errorMessage).toBe("model unavailable");
  });

  it("captures error messages from result events with is_error", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "API key expired",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.errorMessage).toBe("API key expired");
  });

  it("captures error from system events with error subtype", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "error",
        message: "connection lost",
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.errorMessage).toBe("connection lost");
  });

  it("handles text-type events for backwards compatibility", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "compat_sess",
        part: { text: "Legacy text event" },
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("compat_sess");
    expect(parsed.summary).toBe("Legacy text event");
  });

  it("accumulates usage from step_finish events", () => {
    const stdout = [
      JSON.stringify({
        type: "step_finish",
        part: {
          cost: 0.001,
          tokens: { input: 50, output: 20, cache: { read: 10 } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        part: {
          cost: 0.002,
          tokens: { input: 30, output: 15, cache: { read: 5 } },
        },
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(80);
    expect(parsed.usage.outputTokens).toBe(35);
    expect(parsed.usage.cachedInputTokens).toBe(15);
    expect(parsed.costUsd).toBeCloseTo(0.003, 6);
  });

  it("handles empty stdout gracefully", () => {
    const parsed = parseCursorJsonl("");
    expect(parsed.sessionId).toBeNull();
    expect(parsed.summary).toBe("");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.costUsd).toBeNull();
  });

  it("reads session id from sessionId field", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      sessionId: "camelCase_sess",
      message: "direct text",
    });
    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("camelCase_sess");
  });

  it("strips stdout/stderr prefixes via stream normalization", () => {
    const stdout = [
      `stdout: ${JSON.stringify({ type: "assistant", session_id: "norm_sess", message: "Normalized" })}`,
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.sessionId).toBe("norm_sess");
    expect(parsed.summary).toBe("Normalized");
  });

  it("supports alternative usage field names in result events", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          outputTokens: 40,
        },
        cost_usd: 0.005,
      }),
    ].join("\n");

    const parsed = parseCursorJsonl(stdout);
    expect(parsed.usage.inputTokens).toBe(100);
    expect(parsed.usage.cachedInputTokens).toBe(25);
    expect(parsed.usage.outputTokens).toBe(40);
    expect(parsed.costUsd).toBeCloseTo(0.005, 6);
  });
});

describe("isCursorUnknownSessionError", () => {
  it("detects 'unknown session' in stdout", () => {
    expect(isCursorUnknownSessionError("unknown session abc", "")).toBe(true);
  });

  it("detects 'unknown chat' in stderr", () => {
    expect(isCursorUnknownSessionError("", "unknown chat xyz")).toBe(true);
  });

  it("detects 'session ... not found'", () => {
    expect(isCursorUnknownSessionError("session abc not found", "")).toBe(true);
  });

  it("detects 'could not resume'", () => {
    expect(isCursorUnknownSessionError("could not resume", "")).toBe(true);
  });

  it("detects 'resume ... not found'", () => {
    expect(isCursorUnknownSessionError("", "resume session not found")).toBe(true);
  });

  it("does not classify unrelated failures as stale sessions", () => {
    expect(isCursorUnknownSessionError("model overloaded", "")).toBe(false);
    expect(isCursorUnknownSessionError("", "rate limit exceeded")).toBe(false);
  });
});
