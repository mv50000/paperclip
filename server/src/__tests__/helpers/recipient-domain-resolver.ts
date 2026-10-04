// RK9-434: DNS stub for outreach tests — tests must never make real DNS queries.
import type { RecipientDomainResolver } from "../../services/outreach/recipient-domain.js";

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Every domain has an MX. */
export const okResolver: RecipientDomainResolver = {
  resolveMx: async () => [{ exchange: "mx.test.invalid", priority: 10 }],
  resolve4: async () => {
    throw dnsError("ENODATA");
  },
  resolve6: async () => {
    throw dnsError("ENODATA");
  },
};

/** Per-domain behaviour: "ok" | "nxdomain" | "timeout"; unlisted domains are "ok". Records every MX lookup. */
export function domainResolver(behaviour: Record<string, "ok" | "nxdomain" | "timeout">) {
  const lookups: string[] = [];
  const resolver: RecipientDomainResolver = {
    resolveMx: async (domain) => {
      lookups.push(domain);
      const b = behaviour[domain] ?? "ok";
      if (b === "nxdomain") throw dnsError("ENOTFOUND");
      if (b === "timeout") throw dnsError("ETIMEOUT");
      return [{ exchange: `mx.${domain}`, priority: 10 }];
    },
    resolve4: async () => {
      throw dnsError("ENODATA");
    },
    resolve6: async () => {
      throw dnsError("ENODATA");
    },
  };
  return { resolver, lookups };
}
