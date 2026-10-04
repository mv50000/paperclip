// RK9-434: can the recipient's domain receive mail at all? A hard bounce for a
// dead domain (`5.4.4 Host or domain name not found`, e.g. info@8aisi.com on
// 1.10.) counts towards the auto-pause rule (auto-pause-logic.ts: >2 % hard
// bounces over 7 d), so a single dead address per ~50 sends pauses the sender
// identity. This check runs before drafting and before the scheduler promotes
// a message, so such an address never reaches SMTP and never becomes a
// bounce event. Pure `node:dns` — no new dependency. The verdict mapping is
// separate from the lookups so it is unit-testable without a network.

import { Resolver } from "node:dns/promises";

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** The three lookups the check needs; injectable so tests never touch real DNS. */
export interface RecipientDomainResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export type RecipientDomainVerdict =
  | { status: "ok" }
  | { status: "unresolvable"; detail: string }
  | { status: "transient"; detail: string };

/** Per-lookup timeout. A slow resolver must not stall the scheduler transaction. */
export const RECIPIENT_DOMAIN_LOOKUP_TIMEOUT_MS = 5_000;

/** One DNS lookup, reduced to what the decision needs: records, or an error code. */
export type LookupResult<T> = { ok: true; records: T[] } | { ok: false; code: string };

export type DnsErrorClass = "nxdomain" | "nodata" | "transient";

/**
 * Maps a Node/c-ares error code to a verdict class. Only NXDOMAIN-like codes
 * mean "domain does not exist"; ENODATA means the name exists but has no
 * record of that type. Everything else (timeout, SERVFAIL, refused, ...) says
 * nothing about the domain and must never block a send for good.
 */
export function classifyDnsError(code: string | undefined): DnsErrorClass {
  if (code === "ENOTFOUND" || code === "EBADNAME") return "nxdomain";
  if (code === "ENODATA") return "nodata";
  return "transient";
}

/** RFC 7505 null MX: a single MX whose exchange is empty or the root ".". */
export function isNullMx(records: MxRecord[]): boolean {
  if (records.length !== 1) return false;
  const exchange = records[0].exchange.trim();
  return exchange === "" || exchange === ".";
}

/** Lowercased domain part of an address, trailing dot stripped; null when there is none. */
export function recipientDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return domain === "" ? null : domain;
}

/**
 * First half of the decision, from the MX lookup alone. Returns
 * `"needs_address_fallback"` when there is no MX and RFC 5321 §5.1's implicit
 * MX (the domain's own A/AAAA record) has to decide.
 */
export function decideFromMx(mx: LookupResult<MxRecord>): RecipientDomainVerdict | "needs_address_fallback" {
  if (mx.ok && mx.records.length > 0) {
    return isNullMx(mx.records) ? { status: "unresolvable", detail: "null_mx" } : { status: "ok" };
  }
  if (!mx.ok) {
    const cls = classifyDnsError(mx.code);
    if (cls === "nxdomain") return { status: "unresolvable", detail: "nxdomain" };
    if (cls === "transient") return { status: "transient", detail: `mx_lookup_${mx.code || "unknown"}` };
  }
  return "needs_address_fallback";
}

/** Implicit-MX decision: any A/AAAA record means the domain accepts mail. */
export function decideFromAddresses(a: LookupResult<string>, aaaa: LookupResult<string>): RecipientDomainVerdict {
  if ((a.ok && a.records.length > 0) || (aaaa.ok && aaaa.records.length > 0)) return { status: "ok" };
  for (const r of [a, aaaa]) {
    if (!r.ok && classifyDnsError(r.code) === "transient") {
      return { status: "transient", detail: `address_lookup_${r.code || "unknown"}` };
    }
  }
  return { status: "unresolvable", detail: "no_mx_no_address" };
}

async function settle<T>(lookup: Promise<T[]>): Promise<LookupResult<T>> {
  try {
    return { ok: true, records: await lookup };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN" };
  }
}

function withTimeout<T>(lookup: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("dns lookup timed out"), { code: "ETIMEOUT" })), ms);
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/** Real resolver: system nameservers, one try, short timeout (c-ares) plus a hard race as a backstop. */
export function createSystemRecipientDomainResolver(
  timeoutMs: number = RECIPIENT_DOMAIN_LOOKUP_TIMEOUT_MS,
): RecipientDomainResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const backstopMs = timeoutMs + 1_000;
  return {
    resolveMx: (domain) => withTimeout(resolver.resolveMx(domain), backstopMs),
    resolve4: (domain) => withTimeout(resolver.resolve4(domain), backstopMs),
    resolve6: (domain) => withTimeout(resolver.resolve6(domain), backstopMs),
  };
}

/**
 * Checks whether `email`'s domain can receive mail. Never throws: a DNS
 * failure that says nothing about the domain is `transient`, which callers
 * treat as "try again later", not as a rejection.
 */
export async function checkRecipientDomain(
  email: string,
  resolver: RecipientDomainResolver = createSystemRecipientDomainResolver(),
): Promise<RecipientDomainVerdict> {
  const domain = recipientDomain(email);
  if (!domain) return { status: "unresolvable", detail: "malformed_email" };
  const fromMx = decideFromMx(await settle(resolver.resolveMx(domain)));
  if (fromMx !== "needs_address_fallback") return fromMx;
  const [a, aaaa] = await Promise.all([settle(resolver.resolve4(domain)), settle(resolver.resolve6(domain))]);
  return decideFromAddresses(a, aaaa);
}
