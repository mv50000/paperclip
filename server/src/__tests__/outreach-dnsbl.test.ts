import { afterEach, describe, expect, it, vi } from "vitest";

const { resolve4Mock, resolveNsMock, resolverResolve4Mock, setServersMock } = vi.hoisted(() => ({
  resolve4Mock: vi.fn(),
  resolveNsMock: vi.fn(),
  resolverResolve4Mock: vi.fn(),
  setServersMock: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  resolve4: resolve4Mock,
  resolveNs: resolveNsMock,
  Resolver: class {
    setServers = setServersMock;
    resolve4 = resolverResolve4Mock;
  },
}));

import {
  checkDnsbl,
  getOutreachDnsblState,
  isDnsblListTrustworthy,
  OUTREACH_DNSBL_CANARY_IP,
  resetDnsblAuthoritativeCache,
  runOutreachDnsblCheck,
} from "../services/outreach/dnsbl.js";

function resetAll(): void {
  resolve4Mock.mockReset();
  resolveNsMock.mockReset();
  resolverResolve4Mock.mockReset();
  setServersMock.mockReset();
  resetDnsblAuthoritativeCache();
}

describe("checkDnsbl", () => {
  afterEach(resetAll);

  it("queries the reversed-octet DNSBL hostname", async () => {
    resolve4Mock.mockResolvedValueOnce(["127.0.0.2"]);
    await checkDnsbl("zen.spamhaus.org", "1.2.3.4");
    expect(resolve4Mock).toHaveBeenCalledWith("4.3.2.1.zen.spamhaus.org");
  });

  it("is listed when the query answers inside 127.0.0.0/8", async () => {
    resolve4Mock.mockResolvedValueOnce(["127.0.0.2"]);
    const result = await checkDnsbl("zen.spamhaus.org", OUTREACH_DNSBL_CANARY_IP);
    expect(result).toEqual({
      list: "zen.spamhaus.org",
      ip: OUTREACH_DNSBL_CANARY_IP,
      listed: true,
      codes: ["127.0.0.2"],
      error: null,
      viaAuthoritative: false,
    });
  });

  it("is not listed on ENOTFOUND (no A record for the query)", async () => {
    resolve4Mock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    const result = await checkDnsbl("zen.spamhaus.org", "9.9.9.9");
    expect(result.listed).toBe(false);
    expect(result.error).toBeNull();
  });

  it("is not listed on ENODATA", async () => {
    resolve4Mock.mockRejectedValueOnce(Object.assign(new Error("no data"), { code: "ENODATA" }));
    const result = await checkDnsbl("zen.spamhaus.org", "9.9.9.9");
    expect(result.listed).toBe(false);
    expect(result.error).toBeNull();
  });

  it("surfaces a non-DNS error instead of silently reporting 'not listed'", async () => {
    resolve4Mock.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));
    const result = await checkDnsbl("zen.spamhaus.org", "9.9.9.9");
    expect(result.listed).toBe(false);
    expect(result.error).toBe("timeout");
  });

  // RK9-225: this is the false alert that fired daily — Spamhaus answers
  // "open resolver" with an A-record, and it is an error, not a listing.
  it("treats a 127.255.255.x answer as a refused query, not a listing", async () => {
    resolve4Mock.mockResolvedValueOnce(["127.255.255.254"]);
    const result = await checkDnsbl("zen.spamhaus.org", "89.167.78.13", { authoritativeFallback: false });
    expect(result.listed).toBe(false);
    expect(result.error).toBe("query_refused:127.255.255.254");
    expect(result.codes).toEqual(["127.255.255.254"]);
  });

  it("treats an answer outside 127.0.0.0/8 as an error (captive/wildcard DNS)", async () => {
    resolve4Mock.mockResolvedValueOnce(["93.184.216.34"]);
    const result = await checkDnsbl("zen.spamhaus.org", "89.167.78.13");
    expect(result.listed).toBe(false);
    expect(result.error).toBe("unexpected_answer:93.184.216.34");
  });

  it("retries a refused query against the list's authoritative nameservers", async () => {
    resolve4Mock.mockImplementation(async (name: string) => {
      if (name.endsWith(".zen.spamhaus.org")) return ["127.255.255.254"]; // public resolver: refused
      return ["192.0.2.10"]; // NS hostname -> address
    });
    resolveNsMock.mockResolvedValue(["b.gns.spamhaus.org"]);
    resolverResolve4Mock.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));

    const result = await checkDnsbl("zen.spamhaus.org", "89.167.78.13");
    expect(setServersMock).toHaveBeenCalledWith(["192.0.2.10"]);
    expect(result).toMatchObject({ listed: false, error: null, viaAuthoritative: true });
  });

  it("reports a real listing found via the authoritative fallback", async () => {
    resolve4Mock.mockImplementation(async (name: string) => {
      if (name.endsWith(".zen.spamhaus.org")) return ["127.255.255.254"];
      return ["192.0.2.10"];
    });
    resolveNsMock.mockResolvedValue(["b.gns.spamhaus.org"]);
    resolverResolve4Mock.mockResolvedValue(["127.0.0.4"]);

    const result = await checkDnsbl("zen.spamhaus.org", "89.167.78.13");
    expect(result).toMatchObject({ listed: true, error: null, viaAuthoritative: true, codes: ["127.0.0.4"] });
  });

  it("keeps the refusal visible when the authoritative retry also fails", async () => {
    resolve4Mock.mockImplementation(async (name: string) => {
      if (name.endsWith(".zen.spamhaus.org")) return ["127.255.255.254"];
      return ["192.0.2.10"];
    });
    resolveNsMock.mockResolvedValue(["b.gns.spamhaus.org"]);
    resolverResolve4Mock.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }));

    const result = await checkDnsbl("zen.spamhaus.org", "89.167.78.13");
    expect(result.listed).toBe(false);
    expect(result.error).toBe("query_refused:127.255.255.254; authoritative:timeout");
  });
});

describe("runOutreachDnsblCheck", () => {
  afterEach(resetAll);

  it("runs the canary self-test and reports ok when the canary is listed", async () => {
    resolve4Mock.mockResolvedValue(["127.0.0.2"]); // every query "listed"
    const state = await runOutreachDnsblCheck({ productionIp: undefined });
    expect(state.selfTest.ok).toBe(true);
    expect(state.selfTests).toHaveLength(3); // one canary lookup per default list
    expect(state.results).toEqual([]);
    expect(state.productionIp).toBeNull();
  });

  it("reports the self-test as failed when the canary is NOT listed (the checker itself is broken)", async () => {
    resolve4Mock.mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    const state = await runOutreachDnsblCheck({ productionIp: undefined });
    expect(state.selfTest.ok).toBe(false);
  });

  it("checks every configured list against the production IP when one is set", async () => {
    resolve4Mock.mockImplementation(async (query: string) => {
      if (query.startsWith("2.0.0.127")) return ["127.0.0.2"]; // canary always listed
      if (query.includes("zen.spamhaus.org")) return ["127.0.0.2"]; // production IP listed on this one
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    const state = await runOutreachDnsblCheck({
      lists: ["zen.spamhaus.org", "bl.spamcop.net"],
      productionIp: "203.0.113.5",
    });
    expect(state.productionIp).toBe("203.0.113.5");
    expect(state.results.map((r) => ({ list: r.list, listed: r.listed, error: r.error }))).toEqual([
      { list: "zen.spamhaus.org", listed: true, error: null },
      { list: "bl.spamcop.net", listed: false, error: null },
    ]);
    expect(isDnsblListTrustworthy(state, "zen.spamhaus.org")).toBe(true);
    expect(getOutreachDnsblState()).toBe(state);
  });

  // The production situation on 16.9.2026: zen refuses us through the public
  // resolver while the other two lists answer normally.
  it("marks only the refusing list as untrustworthy, leaving the others usable", async () => {
    resolve4Mock.mockImplementation(async (query: string) => {
      if (query.includes("zen.spamhaus.org")) return ["127.255.255.254"];
      if (query.startsWith("2.0.0.127")) return ["127.0.0.2"];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    resolveNsMock.mockRejectedValue(new Error("no NS")); // authoritative fallback unavailable

    const state = await runOutreachDnsblCheck({
      lists: ["zen.spamhaus.org", "bl.spamcop.net"],
      productionIp: "203.0.113.5",
    });
    expect(state.selfTest.ok).toBe(false);
    expect(isDnsblListTrustworthy(state, "zen.spamhaus.org")).toBe(false);
    expect(isDnsblListTrustworthy(state, "bl.spamcop.net")).toBe(true);
    expect(state.results.find((r) => r.list === "zen.spamhaus.org")?.listed).toBe(false);
  });
});
