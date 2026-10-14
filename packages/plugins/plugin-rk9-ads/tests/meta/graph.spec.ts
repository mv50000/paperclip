import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidParamError,
  MediaProcessingError,
  MediaTimeoutError,
  MetaGraphError,
  MetaResponseError,
  POLICY_ACCEPTANCE_FIX,
  PolicyAcceptanceRequiredError,
  RateLimitError,
  ReadOnlyViolationError,
  TokenInvalidError,
  WriteRefusedError,
} from "../../src/meta/errors.js";
import {
  createMetaClient,
  encodeParams,
  GRAPH_VERSION,
  GraphHealth,
  graphHealth,
  graphUrl,
  pausedOnlyWrites,
  regainAccessMs,
  type WritePlan,
} from "../../src/meta/graph.js";
import {
  createAd,
  createAdCreative,
  getAccountSummary,
  getInsights,
  getObjectStatus,
  getVideoThumbnails,
  listAds,
  listAdSets,
  listCampaigns,
  parseMinorUnits,
  setObjectStatus,
  uploadImageBytes,
  uploadVideoByUrl,
  waitForVideoReady,
} from "../../src/meta/methods.js";
import { isDryRun } from "../../src/meta/types.js";
import { ACT, COMPANY, FakeGraph, fixture, makeClient, SENTINEL_TOKEN, TOKEN_REF } from "./fake-graph.js";

const GRAPH_PREFIX = `https://graph.facebook.com/${GRAPH_VERSION}/`;
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Every write method, called once. Used by the read-only and dry-run sweeps. */
const WRITE_CALLS: Array<[string, (client: ReturnType<typeof makeClient>["client"]) => Promise<unknown>]> = [
  ["uploadVideoByUrl", (c) => uploadVideoByUrl(c, ACT, { fileUrl: "https://cdn.example.com/reel.mp4", name: "reel" })],
  ["uploadImageBytes", (c) => uploadImageBytes(c, ACT, { bytesBase64: PNG_BASE64, name: "pic" })],
  ["createAdCreative", (c) => createAdCreative(c, ACT, { name: "creative", object_story_spec: { page_id: "1" } })],
  ["createAd", (c) => createAd(c, ACT, { name: "ad", adsetId: "120247250925850775", creativeId: "23850000000000001" })],
  ["setObjectStatus", (c) => setObjectStatus(c, "120247250925830775", "PAUSED")],
  ["post", (c) => c.post("120247250925830775", { name: "x" })],
  ["delete", (c) => c.delete("120247250925830775")],
];

describe("Graph URL and request shape", () => {
  it("builds every URL on the one pinned version", () => {
    expect(GRAPH_VERSION).toBe("v23.0");
    expect(graphUrl("act_1/campaigns", { fields: "id", limit: 5 }).toString()).toBe(
      `${GRAPH_PREFIX}act_1/campaigns?fields=id&limit=5`,
    );
  });

  it("refuses paths that could leave the Graph host or the version", () => {
    for (const bad of ["../v2.0/me", "https://evil.example/x", "act_1/../me", "a b", "act_1?x=1", "", "a//b"]) {
      expect(() => graphUrl(bad), bad).toThrow(InvalidParamError);
    }
  });

  it("refuses access_token and write overrides as parameters", () => {
    for (const key of ["access_token", "ACCESS_TOKEN", "method", "Method", "_method", "batch", "appsecret_proof"]) {
      expect(() => encodeParams({ [key]: "x" }), key).toThrow(InvalidParamError);
    }
  });

  it("refuses parameter names that are not plain identifiers", () => {
    for (const key of ["method ", " method", "a.b", "fields[]", ""]) {
      expect(() => encodeParams({ [key]: "x" }), JSON.stringify(key)).toThrow(InvalidParamError);
    }
    expect(encodeParams({ time_range: { since: "a" }, fields: "id" }).toString()).toBe("time_range=%7B%22since%22%3A%22a%22%7D&fields=id");
  });

  it("cannot smuggle a write through a GET in read-only mode", async () => {
    const graph = new FakeGraph(fixture("account"));
    const { client } = makeClient(graph, { mode: "readOnly" });
    await expect(client.get("120247250925830775", { method: "post", status: "ACTIVE" })).rejects.toThrow(InvalidParamError);
    await expect(client.get("120247250925830775", { batch: [{ method: "POST" }] })).rejects.toThrow(InvalidParamError);
    expect(graph.calls).toHaveLength(0);
  });

  it("sends the token as a Bearer header resolved per call, never in the URL", async () => {
    const graph = new FakeGraph(fixture("account"), fixture("account"));
    const { client, captured } = makeClient(graph);
    await getAccountSummary(client, ACT);
    await getAccountSummary(client, "1336862981968191");

    expect(graph.calls).toHaveLength(2);
    for (const call of graph.calls) {
      expect(call.url.startsWith(`${GRAPH_PREFIX}act_1336862981968191?`)).toBe(true);
      expect(call.url).not.toContain("access_token");
      expect(call.url).not.toContain(encodeURIComponent(SENTINEL_TOKEN));
      expect(call.headers.Authorization).toBe(`Bearer ${SENTINEL_TOKEN}`);
    }
    expect(captured.resolves).toEqual([
      { companyId: COMPANY, configPath: "meta.accessTokenRef" },
      { companyId: COMPANY, configPath: "meta.accessTokenRef" },
    ]);
  });

  it("sends write bodies as form-encoded strings with objects as JSON", async () => {
    const graph = new FakeGraph(fixture("ad"));
    const { client } = makeClient(graph);
    const result = await createAd(client, ACT, {
      name: "Ololla 1",
      adsetId: "120247250925850775",
      creativeId: "23850000000000001",
    });
    expect(result).toEqual({ adId: "23850000000000002" });
    const call = graph.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${GRAPH_PREFIX}act_1336862981968191/ads`);
    expect(typeof call.body).toBe("string");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(call.body as string);
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("adset_id")).toBe("120247250925850775");
    expect(JSON.parse(body.get("creative")!)).toEqual({ creative_id: "23850000000000001" });
    expect(body.has("access_token")).toBe(false);
  });
});

describe("account summary", () => {
  it("normalises the recorded Sunspot account without float math", async () => {
    const { client } = makeClient(new FakeGraph(fixture("account")));
    expect(await getAccountSummary(client, ACT)).toEqual({
      accountId: "1336862981968191",
      currency: "EUR",
      timezone: "Europe/Helsinki",
      spendCapCents: 10000,
      amountSpentCents: 0,
      status: "ACTIVE",
      statusCode: 1,
    });
  });

  it("refuses a summary without amount_spent instead of reading it as zero spend", async () => {
    const base = fixture("account");
    const { client } = makeClient(new FakeGraph({ ...base, body: { ...(base.body as object), amount_spent: undefined } }));
    await expect(getAccountSummary(client, ACT)).rejects.toThrow(MetaResponseError);
  });

  it("maps spend_cap 0 or absent to null and keeps large minor-unit strings exact", async () => {
    const base = fixture("account");
    const body = base.body as Record<string, unknown>;
    const zero = { ...base, body: { ...body, spend_cap: "0", amount_spent: "9007199254740991", account_status: 9 } };
    const absent = { ...base, body: { ...body, spend_cap: undefined, account_status: 12345 } };
    const { client } = makeClient(new FakeGraph(zero, absent));

    const first = await getAccountSummary(client, ACT);
    expect(first.spendCapCents).toBeNull();
    expect(first.amountSpentCents).toBe(9007199254740991);
    expect(first.status).toBe("IN_GRACE_PERIOD");
    const second = await getAccountSummary(client, ACT);
    expect(second.spendCapCents).toBeNull();
    expect(second.status).toBe("UNKNOWN");
  });

  it("rejects money that is not an integer string", () => {
    for (const bad of ["12.50", "-1", "1e3", "", "9007199254740993", 1.5, null]) {
      expect(() => parseMinorUnits(bad, "amount_spent"), String(bad)).toThrow(MetaResponseError);
    }
    expect(parseMinorUnits("0012", "x")).toBe(12);
  });

  it("refuses a malformed ad account id before any request", async () => {
    const graph = new FakeGraph();
    const { client } = makeClient(graph);
    await expect(getAccountSummary(client, "act_12a")).rejects.toThrow(InvalidParamError);
    expect(graph.calls).toHaveLength(0);
  });
});

describe("paging", () => {
  it("follows two pages, strips access_token from next and stays on the pinned version", async () => {
    const graph = new FakeGraph(fixture("ads-page-1"), fixture("ads-page-2"));
    const { client } = makeClient(graph);
    const ads = await listAds(client, ACT);

    expect(ads.map((ad) => ad.id)).toEqual([
      "120248676310950775",
      "120248499449520775",
      "120248441720170775",
      expect.any(String),
    ]);
    expect(ads[0]).toMatchObject({
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      adsetId: "120247250925850775",
      campaignId: "120247250925830775",
      creativeId: "1834346481095193",
    });
    const second = new URL(graph.calls[1]!.url);
    expect(second.searchParams.has("access_token")).toBe(false);
    expect(second.searchParams.get("after")).toBeTruthy();
    expect(graph.calls[1]!.url.startsWith(`${GRAPH_PREFIX}act_1336862981968191/ads?`)).toBe(true);
    expect(graph.calls[1]!.url).not.toContain(encodeURIComponent(SENTINEL_TOKEN));
  });

  it("makes list and insights methods throw instead of returning a truncated result", async () => {
    const graph = new FakeGraph(fixture("ads-page-1"), {
      ...fixture("insights-yesterday"),
      body: { data: [{ spend: "1.00" }], paging: { next: `${GRAPH_PREFIX}act_1336862981968191/insights?after=c` } },
    });
    const { client } = makeClient(graph);
    await expect(listAds(client, ACT, { maxPages: 1 })).rejects.toThrow(/raise maxPages/);
    await expect(
      getInsights(client, ACT, { level: "ad", datePreset: "this_month", fields: ["spend"], maxPages: 1 }),
    ).rejects.toThrow(/raise maxPages/);
  });

  it("refuses a paging.next that is present but not a URL string", async () => {
    const page = fixture("ads-page-1");
    const body = page.body as { data: unknown[] };
    const { client } = makeClient(new FakeGraph({ ...page, body: { ...body, paging: { next: { url: "x" } } } }));
    await expect(listAds(client, ACT)).rejects.toThrow(MetaResponseError);
  });

  it("treats a NaN or infinite page cap as the default", async () => {
    const graph = new FakeGraph(fixture("ads-page-1"), fixture("ads-page-2"));
    const { client } = makeClient(graph);
    const page = await client.paginate("act_1336862981968191/ads", {}, { maxPages: Number.NaN });
    expect(page).toMatchObject({ pages: 2, truncated: false });
  });

  it("stops at the page cap and says so", async () => {
    const graph = new FakeGraph(fixture("ads-page-1"));
    const { client } = makeClient(graph);
    const page = await client.paginate("act_1336862981968191/ads", {}, { maxPages: 1 });
    expect(page).toMatchObject({ pages: 1, truncated: true });
    expect(page.data).toHaveLength(2);
    expect(graph.calls).toHaveLength(1);
  });

  it("refuses a next URL on another host, so the token never leaves Graph", async () => {
    const graph = new FakeGraph(fixture("ads-page-1-foreign-host"));
    const { client } = makeClient(graph);
    await expect(listAds(client, ACT)).rejects.toThrow(/refused/);
    expect(graph.calls).toHaveLength(1);
  });

  it("refuses a next URL that leaves the edge or carries a write override", async () => {
    const page = fixture("ads-page-1");
    const body = page.body as { data: unknown[]; paging: { next: string } };
    const withNext = (next: string) => ({ ...page, body: { ...body, paging: { next } } });
    const base = `${GRAPH_PREFIX}act_1336862981968191`;
    const graph = new FakeGraph(
      withNext(`${base}/ads?after=c&method=post&status=ACTIVE`),
      withNext(`${base}/ads?after=c&BATCH=x`),
      withNext(`${GRAPH_PREFIX}act_999/ads?after=c`),
      withNext(`${GRAPH_PREFIX}me/adaccounts?after=c`),
      withNext(`${base}/ads?after=c&method%20=post`),
    );
    const { client } = makeClient(graph);
    for (let i = 0; i < 5; i += 1) {
      await expect(listAds(client, ACT)).rejects.toThrow(/refused/);
    }
    expect(graph.calls).toHaveLength(5);
    expect(graph.calls.every((call) => call.url.includes("act_1336862981968191/ads?"))).toBe(true);
  });

  it("strips access_token in any letter case from next", async () => {
    const page = fixture("ads-page-1");
    const body = page.body as { data: unknown[]; paging: { next: string } };
    const next = `${GRAPH_PREFIX}act_1336862981968191/ads?Access_Token=${encodeURIComponent(SENTINEL_TOKEN)}&after=c`;
    const graph = new FakeGraph({ ...page, body: { ...body, paging: { next } } }, fixture("ads-page-2"));
    const { client } = makeClient(graph);
    await listAds(client, ACT);
    expect(graph.calls[1]!.url).toBe(`${GRAPH_PREFIX}act_1336862981968191/ads?after=c`);
  });

  it("warns once on version drift: logger, one activity entry, client status and worker health", async () => {
    const health = new GraphHealth();
    const graph = new FakeGraph(fixture("ads-page-1-drift"), fixture("ads-page-2"), fixture("ads-page-1-drift"), fixture("ads-page-2"));
    const { client, captured } = makeClient(graph, { health });

    await listAds(client, ACT);
    await listAds(client, ACT);

    expect(graph.calls[1]!.url.startsWith(GRAPH_PREFIX)).toBe(true);
    expect(captured.activity).toHaveLength(1);
    expect(captured.activity[0]).toMatchObject({
      companyId: COMPANY,
      message: "rk9-ads: Meta Graph API version drift",
      metadata: { expectedVersion: "v23.0", observedVersion: "v25.0", source: "paging" },
    });
    expect(captured.logs.filter((log) => log.message.includes("drift"))).toHaveLength(1);
    expect(client.status().drift).toMatchObject({ observedVersion: "v25.0" });
    expect(health.snapshot()).toMatchObject({ status: "degraded", drift: { observedVersion: "v25.0" } });
  });

  it("writes the drift activity entry once per worker and observed version, and keeps the latest drift", async () => {
    const health = new GraphHealth();
    const header = (version: string) => ({ ...fixture("account"), headers: { "facebook-api-version": version } });
    const first = makeClient(new FakeGraph(header("v25.0")), { health });
    const second = makeClient(new FakeGraph(header("v25.0")), { health });
    const third = makeClient(new FakeGraph(header("v26.0")), { health });
    for (const { client } of [first, second, third]) {
      await getAccountSummary(client, ACT);
      await Promise.resolve();
    }
    expect(first.captured.activity).toHaveLength(1);
    expect(second.captured.activity).toHaveLength(0);
    expect(second.client.status().drift).toMatchObject({ observedVersion: "v25.0" });
    expect(third.captured.activity).toHaveLength(1);
    expect(health.snapshot().drift).toMatchObject({ observedVersion: "v26.0" });
  });

  it("createMetaClient feeds the worker-wide graphHealth through ctx", async () => {
    graphHealth.reset();
    try {
      const graph = new FakeGraph({ ...fixture("account"), headers: { "facebook-api-version": "v25.0" } });
      const activity: unknown[] = [];
      const client = createMetaClient(
        {
          http: { fetch: graph.fetch },
          secrets: { resolve: async () => SENTINEL_TOKEN },
          logger: { info: () => undefined, warn: () => undefined },
          activity: { log: async (entry) => void activity.push(entry) },
        },
        { companyId: COMPANY, tokenRef: TOKEN_REF },
      );
      await getAccountSummary(client, ACT);
      await Promise.resolve();
      expect(graphHealth.snapshot()).toMatchObject({ status: "degraded", drift: { observedVersion: "v25.0" } });
      expect(activity).toHaveLength(1);
      expect(graph.calls[0]!.headers.Authorization).toBe(`Bearer ${SENTINEL_TOKEN}`);
    } finally {
      graphHealth.reset();
    }
  });

  it("also notices drift in the facebook-api-version response header", async () => {
    const health = new GraphHealth();
    const account = fixture("account");
    const graph = new FakeGraph({ ...account, headers: { "facebook-api-version": "v25.0" } });
    const { client, captured } = makeClient(graph, { health });
    await getAccountSummary(client, ACT);
    await Promise.resolve();
    expect(health.snapshot().status).toBe("degraded");
    expect(captured.activity).toHaveLength(1);
  });
});

describe("error mapping", () => {
  it.each([
    ["error-190", TokenInvalidError, 190, null],
    ["error-100", InvalidParamError, 100, null],
    ["error-2859024", PolicyAcceptanceRequiredError, 100, 2859024],
    ["error-unknown", MetaGraphError, 2, 99],
  ] as const)("maps %s", async (name, type, code, subcode) => {
    const { client } = makeClient(new FakeGraph(fixture(name)));
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as MetaGraphError;
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
    expect(error.subcode).toBe(subcode);
    expect(error.fbtraceId).toMatch(/^AbCdEf/);
    expect(error.message).toContain(`code ${code}`);
  });

  it("gives the policy error a human-readable fix", async () => {
    const { client } = makeClient(new FakeGraph(fixture("error-2859024")));
    const error = (await createAd(client, ACT, {
      name: "ad",
      adsetId: "1",
      creativeId: "2",
    }).catch((e: unknown) => e)) as PolicyAcceptanceRequiredError;
    expect(error).toBeInstanceOf(PolicyAcceptanceRequiredError);
    expect(error.fix).toBe(POLICY_ACCEPTANCE_FIX);
    expect(error.message).toContain("Ads Manager");
  });

  it("refuses a JSON answer that is not an object", async () => {
    for (const body of ["null", "[]", "42"]) {
      const { client } = makeClient(new FakeGraph({ status: 200, body }));
      await expect(setObjectStatus(client, "1", "PAUSED"), body).rejects.toThrow(MetaResponseError);
    }
  });

  it("wraps a non-JSON answer", async () => {
    const { client } = makeClient(new FakeGraph({ status: 502, body: "<html>Bad gateway</html>" }));
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as MetaGraphError;
    expect(error).toBeInstanceOf(MetaGraphError);
    expect(error.httpStatus).toBe(502);
  });
});

describe("rate limits", () => {
  it("retries with backoff and succeeds within the bounds", async () => {
    const graph = new FakeGraph(fixture("error-613"), fixture("error-613"), fixture("account"));
    const { client, captured } = makeClient(graph);
    const summary = await getAccountSummary(client, ACT);
    expect(summary.currency).toBe("EUR");
    expect(graph.calls).toHaveLength(3);
    expect(captured.sleeps).toEqual([1_000, 2_000]);
    expect(captured.logs.filter((log) => log.message.includes("rate limited"))).toHaveLength(2);
  });

  it("gives up after the attempt cap with a RateLimitError", async () => {
    const graph = new FakeGraph(fixture("error-613"), fixture("error-613"), fixture("error-613"), fixture("account"));
    const { client, captured } = makeClient(graph);
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.attempts).toBe(3);
    expect(graph.calls).toHaveLength(3);
    expect(captured.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(30_000);
  });

  it("fails at once when Meta's own estimate exceeds the wait budget", async () => {
    const graph = new FakeGraph(fixture("error-80004-long-wait"), fixture("account"));
    const { client, captured } = makeClient(graph);
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.code).toBe(80004);
    expect(error.retryAfterMs).toBe(5 * 60_000);
    expect(error.attempts).toBe(1);
    expect(captured.sleeps).toEqual([]);
  });

  it("caps the configured total wait below the host's 30 s call limit", async () => {
    const graph = new FakeGraph(...Array.from({ length: 10 }, () => fixture("error-613")));
    const { client, captured } = makeClient(graph, { retry: { maxAttempts: 10, baseDelayMs: 4_000, maxTotalWaitMs: 120_000 } });
    await expect(getAccountSummary(client, ACT)).rejects.toThrow(RateLimitError);
    expect(captured.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(30_000);
  });

  it("falls back to bounded defaults for NaN, infinite or missing retry settings", async () => {
    const graph = new FakeGraph(...Array.from({ length: 20 }, () => fixture("error-613")));
    const { client, captured } = makeClient(graph, {
      retry: { maxAttempts: Number.NaN, baseDelayMs: Number.POSITIVE_INFINITY, maxTotalWaitMs: undefined },
    });
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.attempts).toBe(3);
    expect(captured.sleeps).toEqual([1_000, 2_000]);

    const many = new FakeGraph(...Array.from({ length: 20 }, () => fixture("error-613")));
    const capped = makeClient(many, { retry: { maxAttempts: 1_000, baseDelayMs: 0 } });
    await expect(getAccountSummary(capped.client, ACT)).rejects.toThrow(RateLimitError);
    expect(many.calls).toHaveLength(5);
  });

  it("reserves the slowest fetch so far for the next attempt", async () => {
    let now = 0;
    const graph = new FakeGraph(fixture("error-613"), fixture("account"));
    const slowFetch = async (url: string, init?: RequestInit) => {
      now += 12_000;
      return graph.fetch(url, init);
    };
    // 12 s fetch + 1 s backoff + 12 s reserved > 20 s budget: no retry.
    const { client } = makeClient(graph, { http: { fetch: slowFetch }, now: () => now, sleep: async (ms) => void (now += ms) });
    await expect(getAccountSummary(client, ACT)).rejects.toThrow(RateLimitError);
    expect(graph.calls).toHaveLength(1);
  });

  it("counts time spent in fetches against the wait budget", async () => {
    let now = 0;
    const graph = new FakeGraph(fixture("error-613"), fixture("account"));
    const slowFetch = async (url: string, init?: RequestInit) => {
      now += 19_500;
      return graph.fetch(url, init);
    };
    const { client } = makeClient(graph, { http: { fetch: slowFetch }, now: () => now, sleep: async (ms) => void (now += ms) });
    const error = (await getAccountSummary(client, ACT).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(graph.calls).toHaveLength(1);
  });

  it("reads estimated_time_to_regain_access from either usage header", () => {
    const headers = new Headers({
      "x-business-use-case-usage": JSON.stringify({ "1": [{ estimated_time_to_regain_access: 2 }] }),
      "x-app-usage": JSON.stringify({ call_count: 99, estimated_time_to_regain_access: 3 }),
    });
    expect(regainAccessMs(headers)).toBe(3 * 60_000);
    expect(regainAccessMs(new Headers({ "x-app-usage": "not json" }))).toBeNull();
  });
});

describe("read-only and dry-run modes", () => {
  it.each(WRITE_CALLS)("read-only refuses %s before any fetch or secret read", async (_name, call) => {
    const graph = new FakeGraph();
    const { client, captured } = makeClient(graph, { mode: "readOnly" });
    await expect(call(client)).rejects.toThrow(ReadOnlyViolationError);
    expect(graph.calls).toHaveLength(0);
    expect(captured.resolves).toHaveLength(0);
  });

  it("dry-run plans every write and sends none", async () => {
    const graph = new FakeGraph();
    const { client, captured } = makeClient(graph, { mode: "dryRun" });
    for (const [name, call] of WRITE_CALLS) {
      const result = await call(client);
      expect(isDryRun(result), name).toBe(true);
    }
    expect(graph.calls).toHaveLength(0);
    expect(graph.nonGetCalls).toHaveLength(0);
    expect(captured.logs.filter((log) => log.message === "rk9-ads meta dry-run write")).toHaveLength(WRITE_CALLS.length);
    const planned = (await createAd(client, ACT, { name: "ad", adsetId: "1", creativeId: "2" })) as {
      planned: { method: string; path: string; fields: Record<string, unknown> };
    };
    expect(planned.planned).toMatchObject({ method: "POST", path: "act_1336862981968191/ads", fields: { status: "PAUSED" } });
  });

  it("dry-run still serves reads", async () => {
    const graph = new FakeGraph(fixture("account"));
    const { client } = makeClient(graph, { mode: "dryRun" });
    await getAccountSummary(client, ACT);
    expect(graph.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("by default refuses activation and creates that are not PAUSED", async () => {
    const graph = new FakeGraph(fixture("ad"));
    const { client } = makeClient(graph);
    await expect(setObjectStatus(client, "120247250925830775", "ACTIVE")).rejects.toThrow(WriteRefusedError);
    await expect(client.post("act_1336862981968191/campaigns", { name: "c", objective: "OUTCOME_TRAFFIC" })).rejects.toThrow(
      WriteRefusedError,
    );
    await expect(client.post("act_1336862981968191/adsets", { name: "s", configured_status: "active" })).rejects.toThrow(
      WriteRefusedError,
    );
    expect(graph.calls).toHaveLength(0);

    // createAd always sends PAUSED, whatever `extra` says.
    await createAd(client, ACT, { name: "ad", adsetId: "1", creativeId: "2", extra: { status: "ACTIVE" } });
    expect(new URLSearchParams(graph.calls[0]!.body as string).get("status")).toBe("PAUSED");
    expect(pausedOnlyWrites({ companyId: COMPANY, mode: "live", method: "POST", path: "1", fields: { name: "x" } })).toEqual({
      allow: true,
    });
  });

  it.each([
    ["a leading slash on a create without status", "/act_1336862981968191/ads", { name: "a", adset_id: "1" }],
    ["an upper-case account prefix", "ACT_1336862981968191/campaigns", { name: "c", status: "PAUSED" }],
    ["activation through copies", "120247250925830775/copies", { status_option: "ACTIVE" }],
    ["an async batch", "act_1336862981968191/async_batch_requests", { adbatch: [{ relative_url: "1", body: "status=ACTIVE" }] }],
    ["a budget change", "120247250925850775", { daily_budget: "100000000" }],
    ["a padded ACTIVE", "120247250925850775", { status: " ACTIVE" }],
    ["a padded PAUSED create", "act_1336862981968191/ads", { name: "a", status: " PAUSED" }],
    ["an unknown edge", "act_1336862981968191/customaudiences", { name: "x" }],
  ] as const)("the default hook refuses %s", async (_label, path, fields) => {
    const graph = new FakeGraph(fixture("ad"));
    const { client } = makeClient(graph);
    await expect(client.post(path, fields as Record<string, unknown>)).rejects.toThrow(WriteRefusedError);
    expect(graph.calls).toHaveLength(0);
  });

  it("the default hook allows media, PAUSED creates, pause, rename and a bare delete", () => {
    const plan = (method: "POST" | "DELETE", path: string, fields: Record<string, unknown>) =>
      pausedOnlyWrites({ companyId: COMPANY, mode: "live", method, path, fields });
    expect(plan("POST", "act_1/adimages", { bytes: "AAAA" })).toEqual({ allow: true });
    expect(plan("POST", "act_1/advideos", { file_url: "https://x" })).toEqual({ allow: true });
    expect(plan("POST", "act_1/adcreatives", { name: "c" })).toEqual({ allow: true });
    expect(plan("POST", "act_1/adsets", { name: "s", status: "PAUSED", daily_budget: "322" })).toEqual({ allow: true });
    expect(plan("POST", "123", { status: "PAUSED" })).toEqual({ allow: true });
    expect(plan("POST", "123", { name: "renamed" })).toEqual({ allow: true });
    expect(plan("DELETE", "123", {})).toEqual({ allow: true });
    expect(plan("DELETE", "123", { status: "ACTIVE" }).allow).toBe(false);
    expect(plan("POST", "123", {}).allow).toBe(false);
  });

  it("guards the fields that are sent, not a getter, Proxy or prototype", async () => {
    const graph = new FakeGraph(fixture("ad"), fixture("ad"), fixture("ad"));
    const { client } = makeClient(graph);
    let reads = 0;
    const flipping = {
      name: "x",
      get status() {
        reads += 1;
        return reads === 1 ? "ACTIVE" : "PAUSED";
      },
    };
    await expect(client.post("act_1336862981968191/campaigns", flipping)).rejects.toThrow(WriteRefusedError);

    const inherited = Object.assign(Object.create({ status: "PAUSED" }) as Record<string, unknown>, { name: "x" });
    await expect(client.post("act_1336862981968191/ads", inherited)).rejects.toThrow(WriteRefusedError);

    let proxyReads = 0;
    const proxy = new Proxy({ name: "x", status: "PAUSED" } as Record<string, unknown>, {
      get: (target, key) => (key === "status" && proxyReads++ > 0 ? "ACTIVE" : target[key as string]),
    });
    await client.post("act_1336862981968191/campaigns", proxy);
    expect(new URLSearchParams(graph.calls[0]!.body as string).get("status")).toBe("PAUSED");
    expect(graph.calls).toHaveLength(1);
  });

  it("hands the guard a frozen copy", async () => {
    let frozen = false;
    const { client } = makeClient(new FakeGraph(), {
      mode: "dryRun",
      guardedWrite: (plan) => {
        frozen = Object.isFrozen(plan.fields) && Object.isFrozen(plan.fields.creative as object);
        return { allow: true };
      },
    });
    await createAd(client, ACT, { name: "a", adsetId: "1", creativeId: "2" });
    expect(frozen).toBe(true);
  });

  it("keeps mode and the sender out of reach of a cast", async () => {
    const graph = new FakeGraph(fixture("ad"));
    const { client } = makeClient(graph, { mode: "readOnly" });
    const loose = client as unknown as Record<string, unknown>;
    expect(() => {
      loose.mode = "live";
    }).toThrow(TypeError);
    expect(loose.send).toBeUndefined();
    expect(loose.options).toBeUndefined();
    await expect(setObjectStatus(client, "1", "PAUSED")).rejects.toThrow(ReadOnlyViolationError);
    expect(graph.calls).toHaveLength(0);
  });

  it("reports the normalised path in a dry-run plan", async () => {
    const { client } = makeClient(new FakeGraph(), { mode: "dryRun" });
    const result = await client.post("/123", { status: "PAUSED" });
    expect(isDryRun(result) && result.planned.path).toBe("123");
  });

  it("gives the guard the normalised path that is actually sent", async () => {
    const plans: WritePlan[] = [];
    const graph = new FakeGraph(fixture("ad"));
    const { client } = makeClient(graph, { guardedWrite: (plan) => (plans.push(plan), { allow: true }) });
    await client.post("//act_1336862981968191/ads", { name: "a", status: "PAUSED" });
    expect(plans[0]!.path).toBe("act_1336862981968191/ads");
    expect(graph.calls[0]!.url).toBe(`${GRAPH_PREFIX}act_1336862981968191/ads`);
  });

  it("passes every write through the guardedWrite hook, which can refuse it", async () => {
    const graph = new FakeGraph();
    const plans: WritePlan[] = [];
    const { client } = makeClient(graph, {
      guardedWrite: (plan) => {
        plans.push(plan);
        return plan.fields.status === "ACTIVE" ? { allow: false, reason: "kill switch on" } : { allow: true };
      },
      mode: "dryRun",
    });
    await expect(setObjectStatus(client, "120247250925830775", "ACTIVE")).rejects.toThrow(WriteRefusedError);
    await setObjectStatus(client, "120247250925830775", "PAUSED");
    expect(plans.map((plan) => plan.fields.status)).toEqual(["ACTIVE", "PAUSED"]);
    expect(plans[0]).toMatchObject({ companyId: COMPANY, method: "POST", path: "120247250925830775", mode: "dryRun" });
    expect(graph.calls).toHaveLength(0);
  });
});

describe("media", () => {
  it("uploads a video by file_url and waits until it is ready", async () => {
    const graph = new FakeGraph(fixture("video-upload"), fixture("video-processing"), fixture("video-processing"), fixture("video-ready"));
    const { client, captured } = makeClient(graph);
    const upload = await uploadVideoByUrl(client, ACT, { fileUrl: "https://cdn.example.com/reel.mp4" });
    expect(upload).toEqual({ videoId: "1234567890123456" });
    const body = new URLSearchParams(graph.calls[0]!.body as string);
    expect(body.get("file_url")).toBe("https://cdn.example.com/reel.mp4");
    expect(graph.calls[0]!.url).toBe(`${GRAPH_PREFIX}act_1336862981968191/advideos`);

    await expect(waitForVideoReady(client, "1234567890123456", { intervalMs: 3_000 })).resolves.toEqual({
      videoId: "1234567890123456",
      status: "ready",
    });
    expect(captured.sleeps).toEqual([3_000, 3_000]);
  });

  it("refuses a non-https video URL", async () => {
    const graph = new FakeGraph();
    const { client } = makeClient(graph);
    await expect(uploadVideoByUrl(client, ACT, { fileUrl: "file:///etc/passwd" })).rejects.toThrow(InvalidParamError);
    expect(graph.calls).toHaveLength(0);
  });

  it("bounds the video wait when given NaN or zero", async () => {
    const graph = new FakeGraph(...Array.from({ length: 1_300 }, () => fixture("video-processing")));
    const { client, captured } = makeClient(graph);
    await expect(waitForVideoReady(client, "1234567890123456", { timeoutMs: Number.NaN, intervalMs: 0 })).rejects.toThrow(
      MediaTimeoutError,
    );
    // Default 10 min timeout, interval clamped up to 0.5 s.
    expect(captured.sleeps.every((ms) => ms >= 500)).toBe(true);
    expect(graph.calls.length).toBeLessThanOrEqual(1_201);
  });

  it("throws MediaProcessingError when processing fails", async () => {
    const { client } = makeClient(new FakeGraph(fixture("video-processing"), fixture("video-error")));
    const error = (await waitForVideoReady(client, "1234567890123456", { intervalMs: 10 }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(MediaProcessingError);
    expect(error.message).toContain("unsupported codec");
  });

  describe("with fake timers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("throws MediaTimeoutError when the video stays in processing", async () => {
      vi.useFakeTimers();
      const graph = new FakeGraph(...Array.from({ length: 20 }, () => fixture("video-processing")));
      // Default sleep and clock, so the vitest fake timers drive them.
      const { client } = makeClient(graph, { sleep: undefined, now: undefined });
      const waiting = waitForVideoReady(client, "1234567890123456", { intervalMs: 5_000, timeoutMs: 30_000 });
      const assertion = expect(waiting).rejects.toBeInstanceOf(MediaTimeoutError);
      await vi.runAllTimersAsync();
      await assertion;
      expect(graph.calls.length).toBe(7);
    });
  });

  it("uploads image bytes as the base64 bytes field and returns the hash", async () => {
    const graph = new FakeGraph(fixture("adimages"));
    const { client } = makeClient(graph);
    const result = await uploadImageBytes(client, ACT, { bytesBase64: PNG_BASE64 });
    expect(result).toEqual({ imageHash: "0d500843a1d4699a0b41e99f4137a5c3", url: "https://scontent.example.fbcdn.net/image.png" });
    expect(typeof graph.calls[0]!.body).toBe("string");
    expect(new URLSearchParams(graph.calls[0]!.body as string).get("bytes")).toBe(PNG_BASE64);
  });

  it("refuses bytes that are not base64 before any request", async () => {
    const graph = new FakeGraph();
    const { client } = makeClient(graph);
    await expect(uploadImageBytes(client, ACT, { bytesBase64: "not base64!" })).rejects.toThrow(InvalidParamError);
    expect(graph.calls).toHaveLength(0);
  });

  it("lists video thumbnails", async () => {
    const { client } = makeClient(new FakeGraph(fixture("video-thumbnails")));
    const thumbs = await getVideoThumbnails(client, "1234567890123456");
    expect(thumbs).toEqual([
      { id: "111", uri: "https://scontent.example.fbcdn.net/thumb1.jpg", isPreferred: true, width: 1080, height: 1920 },
      { id: "112", uri: "https://scontent.example.fbcdn.net/thumb2.jpg", isPreferred: false, width: 1080, height: 1920 },
    ]);
  });

  it("creates an ad creative with a JSON object_story_spec", async () => {
    const graph = new FakeGraph(fixture("adcreative"));
    const { client } = makeClient(graph);
    const spec = { page_id: "1284777064729996", video_data: { video_id: "1234567890123456", image_hash: "abc" } };
    expect(await createAdCreative(client, ACT, { name: "c", object_story_spec: spec })).toEqual({ creativeId: "23850000000000001" });
    expect(JSON.parse(new URLSearchParams(graph.calls[0]!.body as string).get("object_story_spec")!)).toEqual(spec);
  });
});

describe("lists, status and insights", () => {
  it("lists campaigns and ad sets with status fields", async () => {
    const campaigns = { status: 200, body: { data: [{ id: "1", name: "C", status: "PAUSED", effective_status: "PAUSED" }] } };
    const adsets = {
      status: 200,
      body: { data: [{ id: "2", name: "S", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", campaign_id: "1" }] },
    };
    const graph = new FakeGraph(campaigns, adsets);
    const { client } = makeClient(graph);
    expect(await listCampaigns(client, ACT, { effectiveStatus: ["ACTIVE", "PAUSED"] })).toEqual([
      { id: "1", name: "C", status: "PAUSED", effectiveStatus: "PAUSED" },
    ]);
    expect(await listAdSets(client, ACT)).toEqual([
      { id: "2", name: "S", status: "ACTIVE", effectiveStatus: "CAMPAIGN_PAUSED", campaignId: "1" },
    ]);
    expect(new URL(graph.calls[0]!.url).searchParams.get("effective_status")).toBe('["ACTIVE","PAUSED"]');
  });

  it("reads one object's status", async () => {
    const graph = new FakeGraph({ status: 200, body: { id: "9", name: "A", status: "PAUSED", effective_status: "PAUSED" } });
    const { client } = makeClient(graph);
    expect(await getObjectStatus(client, "9")).toEqual({ id: "9", name: "A", status: "PAUSED", effectiveStatus: "PAUSED" });
  });

  it("gets insights by date preset or time range, never both", async () => {
    const graph = new FakeGraph(fixture("insights-yesterday"), fixture("insights-yesterday"));
    const { client } = makeClient(graph);
    const rows = await getInsights(client, ACT, { level: "account", datePreset: "yesterday", fields: ["spend", "impressions"] });
    expect(rows[0]).toMatchObject({ spend: "3.21", date_start: "2026-10-13" });
    await getInsights(client, ACT, {
      level: "ad",
      timeRange: { since: "2026-10-01", until: "2026-10-13" },
      timeIncrement: 1,
      fields: ["spend"],
    });
    const second = new URL(graph.calls[1]!.url).searchParams;
    expect(JSON.parse(second.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-13" });
    expect(second.get("date_preset")).toBeNull();

    await expect(
      getInsights(client, ACT, { level: "ad", datePreset: "yesterday", timeRange: { since: "2026-10-01", until: "2026-10-02" }, fields: ["spend"] }),
    ).rejects.toThrow(InvalidParamError);
    await expect(getInsights(client, ACT, { level: "ad", fields: ["spend"] })).rejects.toThrow(InvalidParamError);
    expect(graph.calls).toHaveLength(2);
  });
});
