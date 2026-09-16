// RK9-225: pins the rule that decides whether a DNSBL verdict is published at
// all. A list we cannot query must not export `outreach_ip_listed` (that gauge
// is what `OutreachIpListed` alerts on), and its blindness must be visible in
// `outreach_dnsbl_list_ok` — blind is not the same as clean.
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolve4Mock, resolveNsMock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolveNsMock: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  resolve4: resolve4Mock,
  resolveNs: resolveNsMock,
  Resolver: class {
    setServers = vi.fn();
    resolve4 = vi.fn();
  },
}));

import { resetDnsblAuthoritativeCache, runOutreachDnsblCheck } from "../services/outreach/dnsbl.js";
import { renderOutreachPrometheusText, type OutreachPrometheusMetrics } from "../services/outreach/metrics.js";

const EMPTY_METRICS: OutreachPrometheusMetrics = {
  sent: [],
  bounce: [],
  replyTotal: 0,
  unsubscribeTotal: 0,
  queueDepth: 0,
  senderPaused: [],
};

const LISTS = ["zen.spamhaus.org", "bl.spamcop.net"];

afterEach(() => {
  resolve4Mock.mockReset();
  resolveNsMock.mockReset();
  resetDnsblAuthoritativeCache();
});

describe("renderOutreachPrometheusText — DNSBL gauges", () => {
  it("publishes no verdict for a list that refused the query, and marks it blind", async () => {
    resolve4Mock.mockImplementation(async (query: string) => {
      if (query.includes("zen.spamhaus.org")) return ["127.255.255.254"]; // open-resolver error
      if (query.startsWith("2.0.0.127")) return ["127.0.0.2"]; // canary listed
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    resolveNsMock.mockRejectedValue(new Error("no NS"));

    await runOutreachDnsblCheck({ lists: LISTS, productionIp: "203.0.113.5" });
    const text = renderOutreachPrometheusText(EMPTY_METRICS);

    expect(text).not.toContain('outreach_ip_listed{list="zen.spamhaus.org"}');
    expect(text).toContain('outreach_ip_listed{list="bl.spamcop.net"} 0');
    expect(text).toContain('outreach_dnsbl_list_ok{list="zen.spamhaus.org"} 0');
    expect(text).toContain('outreach_dnsbl_list_ok{list="bl.spamcop.net"} 1');
    expect(text).toContain("outreach_dnsbl_selftest_ok 0");
  });

  it("publishes a real listing when the list answers normally", async () => {
    resolve4Mock.mockImplementation(async (query: string) => {
      if (query.startsWith("2.0.0.127")) return ["127.0.0.2"];
      if (query.includes("bl.spamcop.net")) return ["127.0.0.2"];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });

    await runOutreachDnsblCheck({ lists: LISTS, productionIp: "203.0.113.5" });
    const text = renderOutreachPrometheusText(EMPTY_METRICS);

    expect(text).toContain('outreach_ip_listed{list="bl.spamcop.net"} 1');
    expect(text).toContain('outreach_ip_listed{list="zen.spamhaus.org"} 0');
    expect(text).toContain("outreach_dnsbl_selftest_ok 1");
  });
});
