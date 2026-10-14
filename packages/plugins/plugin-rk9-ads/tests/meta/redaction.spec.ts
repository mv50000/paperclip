import { describe, expect, it } from "vitest";
import { GraphHealth } from "../../src/meta/graph.js";
import { createAd, getAccountSummary, listAds, uploadVideoByUrl } from "../../src/meta/methods.js";
import { REDACTED, redactText, redactValue, stripAccessToken } from "../../src/meta/redact.js";
import { ACT, FakeGraph, fixture, makeClient, SENTINEL_TOKEN, type Captured } from "./fake-graph.js";

const META_SHAPED = "EAAGm0PX4ZCpsBAFakeTokenValue1234567890abcdef";

/** Everything the client produced, as one string: errors (message, cause, JSON, stack), logs, activity. */
function allOutput(errors: unknown[], captured: Captured): string {
  const errorText = errors.map((error) => {
    if (!(error instanceof Error)) return String(error);
    return JSON.stringify({
      message: error.message,
      stack: error.stack,
      cause: (error as { cause?: unknown }).cause === undefined ? null : String((error as { cause?: unknown }).cause),
      json: JSON.stringify(error),
      string: String(error),
      props: { ...error },
    });
  });
  return JSON.stringify({ errorText, logs: captured.logs, activity: captured.activity });
}

function expectNoToken(output: string): void {
  expect(output).not.toContain(SENTINEL_TOKEN);
  expect(output).not.toContain(encodeURIComponent(SENTINEL_TOKEN));
}

describe("token redaction", () => {
  it("keeps a planted token out of every error, log, activity entry and dry-run plan", async () => {
    const errors: unknown[] = [];
    const catchInto = (promise: Promise<unknown>) => promise.catch((error: unknown) => void errors.push(error));

    // 1. Graph echoes the token in the message (error-190 plants it).
    const graph = new FakeGraph(
      fixture("error-190"),
      // 2. Graph echoes it in the end-user fields.
      {
        status: 400,
        body: {
          error: {
            message: `Invalid OAuth access token - Cannot parse access token: ${SENTINEL_TOKEN}`,
            code: 190,
            error_user_msg: `token ${SENTINEL_TOKEN} expired`,
            error_user_title: SENTINEL_TOKEN,
            fbtrace_id: "x",
          },
        },
      },
      // 3. The transport fails with the token in the error text.
      new TypeError(`fetch failed: https://graph.facebook.com/x?access_token=${encodeURIComponent(SENTINEL_TOKEN)}`),
      // 4. A paging next URL carries the token; then rate limiting logs a warning.
      fixture("ads-page-1-drift"),
      fixture("error-613"),
      fixture("ads-page-2"),
    );
    const { client, captured } = makeClient(graph, { health: new GraphHealth() });

    await catchInto(getAccountSummary(client, ACT));
    await catchInto(getAccountSummary(client, ACT));
    await catchInto(getAccountSummary(client, ACT));
    await listAds(client, ACT);

    // 5. Dry-run plans with the token in a field value (a URL query and plain text).
    const { client: dry, captured: dryCaptured } = makeClient(new FakeGraph(), { mode: "dryRun" });
    const plan = await createAd(dry, ACT, {
      name: "ad",
      adsetId: "1",
      creativeId: "2",
      extra: { tracking_specs: { url: `https://x.example/?access_token=${SENTINEL_TOKEN}` }, note: `Bearer ${META_SHAPED}` },
    });
    await uploadVideoByUrl(dry, ACT, { fileUrl: `https://cdn.example.com/v.mp4?access_token=${META_SHAPED}` });

    // 6. The secret store itself fails with the value in its message.
    const { client: broken, captured: brokenCaptured } = makeClient(new FakeGraph(), {
      secrets: {
        resolve: async () => {
          throw new Error(`provider said access_token=${SENTINEL_TOKEN}`);
        },
      },
    });
    await catchInto(getAccountSummary(broken, ACT));

    expect(errors).toHaveLength(4);
    for (const error of errors) {
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
    const output =
      allOutput(errors, captured) +
      allOutput([], dryCaptured) +
      allOutput([], brokenCaptured) +
      JSON.stringify(plan) +
      JSON.stringify(graph.calls.map((call) => call.url));
    expectNoToken(output);
    expect(output).not.toContain(META_SHAPED);
    expect(output).toContain(REDACTED);
    // The second request in the paging walk went out without the token in its URL.
    expect(graph.calls[4]!.url).not.toContain("access_token");
  });
});

describe("redact helpers", () => {
  it("redacts known values, URL-encoded values and token shapes", () => {
    const text = [
      `raw ${SENTINEL_TOKEN}`,
      `encoded ${encodeURIComponent(SENTINEL_TOKEN)}`,
      `https://graph.facebook.com/me?fields=id&access_token=abc123&x=1`,
      `{"access_token":"abc123"}`,
      `Authorization: Bearer abc.def-123`,
      `shape ${META_SHAPED}`,
    ].join("\n");
    const out = redactText(text, [SENTINEL_TOKEN]);
    expect(out).not.toContain(SENTINEL_TOKEN);
    expect(out).not.toContain(encodeURIComponent(SENTINEL_TOKEN));
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("abc.def-123");
    expect(out).not.toContain(META_SHAPED);
    expect(out).toContain("fields=id&access_token=[REDACTED]&x=1");
  });

  it("drops secret-named keys whole and survives cycles and errors", () => {
    const value: Record<string, unknown> = {
      access_token: "x",
      Authorization: "Bearer y",
      nested: [{ token: 1, url: "https://a/?access_token=z" }],
      error: Object.assign(new Error(`bad ${SENTINEL_TOKEN}`), { cause: SENTINEL_TOKEN }),
    };
    value.self = value;
    const out = redactValue(value, [SENTINEL_TOKEN]);
    const text = JSON.stringify(out);
    expect(text).not.toContain(SENTINEL_TOKEN);
    expect(out.access_token).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    expect(out.self).toBe("[Circular]");
    expect(text).toContain("access_token=[REDACTED]");
  });

  it("strips access_token from a URL and keeps the rest", () => {
    const url = stripAccessToken("https://graph.facebook.com/x/y?access_token=t&after=c&appsecret_proof=p");
    expect(url.search).toBe("?after=c");
  });
});
