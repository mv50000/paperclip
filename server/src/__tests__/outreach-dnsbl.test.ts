import { afterEach, describe, expect, it, vi } from "vitest";

const { resolve4Mock } = vi.hoisted(() => ({ resolve4Mock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: resolve4Mock }));

import { checkDnsbl, OUTREACH_DNSBL_CANARY_IP, runOutreachDnsblCheck, getOutreachDnsblState } from "../services/outreach/dnsbl.js";

describe("checkDnsbl", () => {
  afterEach(() => {
    resolve4Mock.mockReset();
  });

  it("queries the reversed-octet DNSBL hostname", async () => {
    resolve4Mock.mockResolvedValueOnce(["127.0.0.2"]);
    await checkDnsbl("zen.spamhaus.org", "1.2.3.4");
    expect(resolve4Mock).toHaveBeenCalledWith("4.3.2.1.zen.spamhaus.org");
  });

  it("is listed when the DNS query resolves", async () => {
    resolve4Mock.mockResolvedValueOnce(["127.0.0.2"]);
    const result = await checkDnsbl("zen.spamhaus.org", OUTREACH_DNSBL_CANARY_IP);
    expect(result).toEqual({ list: "zen.spamhaus.org", ip: OUTREACH_DNSBL_CANARY_IP, listed: true, error: null });
  });

  it("is not listed on ENOTFOUND (no A record for the query)", async () => {
    resolve4Mock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    const result = await checkDnsbl("zen.spamhaus.org", "9.9.9.9");
    expect(result).toEqual({ list: "zen.spamhaus.org", ip: "9.9.9.9", listed: false, error: null });
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
});

describe("runOutreachDnsblCheck", () => {
  afterEach(() => {
    resolve4Mock.mockReset();
  });

  it("runs the canary self-test and reports ok when the canary is listed", async () => {
    resolve4Mock.mockResolvedValue(["127.0.0.2"]); // every query "listed"
    const state = await runOutreachDnsblCheck({ productionIp: undefined });
    expect(state.selfTest.ok).toBe(true);
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
    expect(state.results).toEqual([
      { list: "zen.spamhaus.org", ip: "203.0.113.5", listed: true, error: null },
      { list: "bl.spamcop.net", ip: "203.0.113.5", listed: false, error: null },
    ]);
    expect(getOutreachDnsblState()).toBe(state);
  });
});
