// RK9-434: verdict mapping for the recipient-domain (MX) check. Resolvers are
// stubs — no test here makes a real DNS query.
import { describe, expect, it } from "vitest";
import {
  checkRecipientDomain,
  classifyDnsError,
  isNullMx,
  recipientDomain,
  type RecipientDomainResolver,
} from "../services/outreach/recipient-domain.js";

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function resolverOf(opts: {
  mx?: Array<{ exchange: string; priority: number }> | string;
  a?: string[] | string;
  aaaa?: string[] | string;
}): RecipientDomainResolver & { calls: string[] } {
  const calls: string[] = [];
  const pick = <T>(name: string, v: T[] | string | undefined): Promise<T[]> => {
    calls.push(name);
    if (typeof v === "string") return Promise.reject(dnsError(v));
    return Promise.resolve(v ?? []);
  };
  return {
    calls,
    resolveMx: () => pick("mx", opts.mx ?? "ENODATA"),
    resolve4: () => pick("a", opts.a ?? "ENODATA"),
    resolve6: () => pick("aaaa", opts.aaaa ?? "ENODATA"),
  };
}

describe("checkRecipientDomain", () => {
  it("NXDOMAIN (ENOTFOUND) on MX is unresolvable — the 8aisi.com case", async () => {
    const resolver = resolverOf({ mx: "ENOTFOUND" });
    const verdict = await checkRecipientDomain("info@8aisi.com", resolver);
    expect(verdict).toEqual({ status: "unresolvable", detail: "nxdomain" });
    expect(resolver.calls).toEqual(["mx"]);
  });

  it("MX records present is ok and skips the address lookups", async () => {
    const resolver = resolverOf({ mx: [{ exchange: "mx.example.com", priority: 10 }] });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "ok" });
    expect(resolver.calls).toEqual(["mx"]);
  });

  it.each(["", "."])("RFC 7505 null MX (exchange %j) is unresolvable", async (exchange) => {
    const resolver = resolverOf({ mx: [{ exchange, priority: 0 }] });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "unresolvable", detail: "null_mx" });
  });

  it("a null-looking MX next to real MX records does not count as null MX", async () => {
    const resolver = resolverOf({
      mx: [
        { exchange: ".", priority: 0 },
        { exchange: "mx.example.com", priority: 10 },
      ],
    });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "ok" });
  });

  it("no MX but an A record is ok (RFC 5321 implicit MX)", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: ["192.0.2.1"], aaaa: "ENODATA" });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "ok" });
  });

  it("no MX but only an AAAA record is ok", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: "ENODATA", aaaa: ["2001:db8::1"] });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "ok" });
  });

  it("no MX and no A/AAAA is unresolvable", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: "ENODATA", aaaa: "ENODATA" });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({
      status: "unresolvable",
      detail: "no_mx_no_address",
    });
  });

  it("no MX and NXDOMAIN on the address lookups is unresolvable", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: "ENOTFOUND", aaaa: "ENOTFOUND" });
    expect((await checkRecipientDomain("a@example.com", resolver)).status).toBe("unresolvable");
  });

  it.each(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EWHATEVER"])("%s on MX is transient, not unresolvable", async (code) => {
    const resolver = resolverOf({ mx: code });
    const verdict = await checkRecipientDomain("a@example.com", resolver);
    expect(verdict.status).toBe("transient");
  });

  it("no MX and a timeout on the address fallback is transient", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: "ETIMEOUT", aaaa: "ENODATA" });
    expect((await checkRecipientDomain("a@example.com", resolver)).status).toBe("transient");
  });

  it("an address found despite a failing sibling lookup is still ok", async () => {
    const resolver = resolverOf({ mx: "ENODATA", a: ["192.0.2.1"], aaaa: "ETIMEOUT" });
    expect(await checkRecipientDomain("a@example.com", resolver)).toEqual({ status: "ok" });
  });

  it.each(["no-at-sign", "user@", "user@  ", ""])("malformed address %j is unresolvable without a lookup", async (email) => {
    const resolver = resolverOf({ mx: [{ exchange: "mx.example.com", priority: 10 }] });
    expect(await checkRecipientDomain(email, resolver)).toEqual({ status: "unresolvable", detail: "malformed_email" });
    expect(resolver.calls).toEqual([]);
  });
});

describe("helpers", () => {
  it("classifies DNS error codes", () => {
    expect(classifyDnsError("ENOTFOUND")).toBe("nxdomain");
    expect(classifyDnsError("ENODATA")).toBe("nodata");
    expect(classifyDnsError("ETIMEOUT")).toBe("transient");
    expect(classifyDnsError("ESERVFAIL")).toBe("transient");
    expect(classifyDnsError(undefined)).toBe("transient");
  });

  it("extracts a normalized domain", () => {
    expect(recipientDomain("Info@8AISI.com")).toBe("8aisi.com");
    expect(recipientDomain("a@example.com.")).toBe("example.com");
    expect(recipientDomain("nope")).toBeNull();
  });

  it("detects a null MX only as the sole record", () => {
    expect(isNullMx([{ exchange: ".", priority: 0 }])).toBe(true);
    expect(isNullMx([])).toBe(false);
  });
});
