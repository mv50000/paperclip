// RK9-197: daily DNSBL (DNS blocklist) reputation check for the outreach
// sending IP. Pure `node:dns` — no new dependency. A DNSBL is queried by
// reversing the IP's octets and looking it up as a subdomain of the list
// (e.g. `2.0.0.127.zen.spamhaus.org`); an A-record in `127.0.0.0/8` means
// "listed", NXDOMAIN/no-data means "not listed". `127.0.0.2` is the
// industry-standard canary test address that every real DNSBL is required to
// list — querying it daily is the AC's "hälyttää testilistauksella" self-test:
// it doesn't check reputation, it checks that the query mechanism itself still
// works (DNS egress, correct query construction). A `false` self-test result
// means "we can't trust any of the real results below", not "we're not listed".
//
// RK9-225: a DNSBL also answers *query errors* with an A-record, in the
// reserved `127.255.255.0/24` range — Spamhaus returns `127.255.255.254`
// ("open resolver") for every query that arrives through a public resolver,
// which is what paperclip-01's resolver is. Treating any A-record as a listing
// made the daily check alert `OutreachIpListed` every single day while the real
// answer (from the list's own nameservers) was "not listed". So: error codes
// are errors, and a refused lookup is retried once against the list's
// authoritative nameservers, which answer us directly without a DQS key.
import { Resolver, resolve4, resolveNs } from "node:dns/promises";
import { logger } from "../../middleware/logger.js";

export const OUTREACH_DNSBL_DEFAULT_LISTS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
] as const;

/** Every real DNSBL is required to list this address — used only for the self-test, never a real reputation check. */
export const OUTREACH_DNSBL_CANARY_IP = "127.0.0.2";

/** Prefix of the reserved range DNSBLs use for query errors (open resolver, rate limit, missing key, malformed query). */
const DNSBL_ERROR_CODE_PREFIX = "127.255.255.";

/** Error strings starting with this mean "the list refused to answer us", not "not listed". */
export const DNSBL_QUERY_REFUSED = "query_refused";

export interface DnsblLookupResult {
  list: string;
  ip: string;
  listed: boolean;
  /** The raw A-records the list answered with (`127.0.0.2`, `127.255.255.254`, …) — kept for logs and the digest. */
  codes: string[];
  /** Set when the lookup itself failed or was refused (DNS server unreachable, `127.255.255.x` error code) — `listed` is `false` in that case too, but the caller must not treat it as a clean result. */
  error: string | null;
  /** True when this answer came from the list's own nameservers after the default resolver was refused. */
  viaAuthoritative: boolean;
}

function reverseIpOctets(ip: string): string {
  return ip.split(".").reverse().join(".");
}

function isErrorCode(address: string): boolean {
  return address.startsWith(DNSBL_ERROR_CODE_PREFIX);
}

/** A listing is always answered inside `127.0.0.0/8` — anything else is a hijacked/wildcard resolver, not a verdict. */
function isListingCode(address: string): boolean {
  return address.startsWith("127.") && !isErrorCode(address);
}

export function isQueryRefused(result: DnsblLookupResult): boolean {
  return result.error !== null && result.error.startsWith(DNSBL_QUERY_REFUSED);
}

function classifyAnswers(
  list: string,
  ip: string,
  addresses: string[],
  viaAuthoritative: boolean,
): DnsblLookupResult {
  const base = { list, ip, codes: addresses, viaAuthoritative };
  if (addresses.length === 0) {
    return { ...base, listed: false, error: null };
  }
  const refused = addresses.filter(isErrorCode);
  if (refused.length > 0) {
    return { ...base, listed: false, error: `${DNSBL_QUERY_REFUSED}:${refused.join(",")}` };
  }
  if (!addresses.every(isListingCode)) {
    return { ...base, listed: false, error: `unexpected_answer:${addresses.join(",")}` };
  }
  return { ...base, listed: true, error: null };
}

// Resolved once per process: the NS records of a DNSBL zone change about never,
// and the fallback is only reached when the default resolver is refused.
const authoritativeServerCache = new Map<string, string[] | null>();

/** Test seam — the cache would otherwise leak between cases. */
export function resetDnsblAuthoritativeCache(): void {
  authoritativeServerCache.clear();
}

async function authoritativeServers(list: string): Promise<string[] | null> {
  const cached = authoritativeServerCache.get(list);
  if (cached !== undefined) return cached;
  let servers: string[] | null = null;
  try {
    const names = await resolveNs(list);
    const addresses = await Promise.all(
      names.slice(0, 3).map((name) => resolve4(name).catch(() => [] as string[])),
    );
    const flat = addresses.flat();
    servers = flat.length > 0 ? flat : null;
  } catch (err) {
    logger.warn({ list, err }, "could not resolve DNSBL authoritative nameservers");
    servers = null;
  }
  authoritativeServerCache.set(list, servers);
  return servers;
}

async function lookupOnce(list: string, ip: string, servers: string[] | null): Promise<DnsblLookupResult> {
  const query = `${reverseIpOctets(ip)}.${list}`;
  const viaAuthoritative = servers !== null;
  try {
    let addresses: string[];
    if (servers === null) {
      addresses = await resolve4(query);
    } else {
      const resolver = new Resolver();
      resolver.setServers(servers);
      addresses = await resolver.resolve4(query);
    }
    return classifyAnswers(list, ip, addresses, viaAuthoritative);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { list, ip, listed: false, codes: [], error: null, viaAuthoritative };
    }
    return {
      list,
      ip,
      listed: false,
      codes: [],
      error: err instanceof Error ? err.message : String(err),
      viaAuthoritative,
    };
  }
}

export async function checkDnsbl(
  list: string,
  ip: string,
  opts: { authoritativeFallback?: boolean } = {},
): Promise<DnsblLookupResult> {
  const first = await lookupOnce(list, ip, null);
  if (!isQueryRefused(first) || opts.authoritativeFallback === false) return first;

  const servers = await authoritativeServers(list);
  if (servers === null) return first;
  const second = await lookupOnce(list, ip, servers);
  if (second.error === null) return second;
  // Both paths failed — report the authoritative attempt but keep the public
  // resolver's refusal code visible, it is the one that explains the situation.
  return { ...second, error: `${first.error}; authoritative:${second.error}` };
}

async function checkAllDnsbl(lists: readonly string[], ip: string): Promise<DnsblLookupResult[]> {
  return Promise.all(lists.map((list) => checkDnsbl(list, ip)));
}

export interface OutreachDnsblState {
  checkedAt: Date | null;
  /** The configured sending IP as of the last check, or `null` if none was configured (the reputation check is then skipped — only the self-test still runs). */
  productionIp: string | null;
  results: DnsblLookupResult[];
  /** One canary lookup per configured list: a list whose canary isn't reported as listed is blind, and its reputation result means nothing. */
  selfTests: DnsblLookupResult[];
  selfTest: { checkedAt: Date | null; ok: boolean | null };
}

// Module-level, in-process only (see docs/implementation-notes/outreach-metrics.md
// for why this isn't persisted): a restart just means the gauge is briefly
// unknown/stale until the next tick, and the cron kicks off shortly after
// boot rather than waiting a full day for its first data point.
const state: OutreachDnsblState = {
  checkedAt: null,
  productionIp: null,
  results: [],
  selfTests: [],
  selfTest: { checkedAt: null, ok: null },
};

export function getOutreachDnsblState(): OutreachDnsblState {
  return state;
}

/** A list is only trustworthy when its canary came back listed AND its reputation lookup wasn't refused. */
export function isDnsblListTrustworthy(dnsbl: OutreachDnsblState, list: string): boolean {
  const canary = dnsbl.selfTests.find((r) => r.list === list);
  if (!canary || !canary.listed || canary.error !== null) return false;
  const result = dnsbl.results.find((r) => r.list === list);
  return result === undefined || result.error === null;
}

export interface RunDnsblCheckOpts {
  lists?: readonly string[];
  /** The outreach sending IP (rk9-prod's outbound address) to check for real reputation listings. `undefined` skips the reputation check but still runs the canary self-test. */
  productionIp: string | undefined;
}

export async function runOutreachDnsblCheck(opts: RunDnsblCheckOpts): Promise<OutreachDnsblState> {
  const lists = opts.lists ?? OUTREACH_DNSBL_DEFAULT_LISTS;
  const now = new Date();

  state.selfTests = await checkAllDnsbl(lists, OUTREACH_DNSBL_CANARY_IP);
  const blind = state.selfTests.filter((r) => !r.listed || r.error !== null);
  const selfTestOk = state.selfTests.length > 0 && blind.length === 0;
  state.selfTest = { checkedAt: now, ok: selfTestOk };
  if (!selfTestOk) {
    logger.error(
      { blind: blind.map((r) => ({ list: r.list, error: r.error, codes: r.codes })) },
      "outreach DNSBL self-test failed: canary address not reported as listed — these lists are blind, not clean",
    );
  }

  if (opts.productionIp) {
    state.results = await checkAllDnsbl(lists, opts.productionIp);
    state.productionIp = opts.productionIp;
    const listedOn = state.results.filter((r) => r.listed && isDnsblListTrustworthy(state, r.list));
    const lookupErrors = state.results.filter((r) => r.error !== null);
    if (listedOn.length > 0) {
      logger.error(
        { productionIp: opts.productionIp, listedOn: listedOn.map((r) => ({ list: r.list, codes: r.codes })) },
        "outreach sending IP is listed on a DNSBL",
      );
    }
    if (lookupErrors.length > 0) {
      logger.warn(
        { productionIp: opts.productionIp, lookupErrors: lookupErrors.map((r) => ({ list: r.list, error: r.error })) },
        "outreach DNSBL lookup could not be completed for some lists — their reputation is unknown, not clean",
      );
    }
  } else {
    state.results = [];
    state.productionIp = null;
  }
  state.checkedAt = now;
  return state;
}

export interface OutreachDnsblCronHandle {
  stop(): void;
  runNow(): Promise<OutreachDnsblState>;
}

/**
 * Runs once daily plus an initial run shortly after boot (so the gauges
 * aren't empty for up to a day after a fresh deploy). A fixed `setInterval`
 * is good enough here — unlike the digest's exact "08:00 EEST" requirement,
 * the AC only asks for "ajaa päivittäin".
 */
export function startOutreachDnsblCron(opts: {
  lists?: readonly string[];
  productionIp: string | undefined;
  intervalMs?: number;
  initialDelayMs?: number;
}): OutreachDnsblCronHandle {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  async function tick(): Promise<OutreachDnsblState> {
    return runOutreachDnsblCheck({ lists: opts.lists, productionIp: opts.productionIp });
  }
  const initial = setTimeout(() => {
    void tick().catch((err) => logger.error({ err }, "outreach DNSBL initial check failed"));
  }, opts.initialDelayMs ?? 60_000);
  if (typeof initial.unref === "function") initial.unref();
  const interval = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, "outreach DNSBL check failed"));
  }, intervalMs);
  if (typeof interval.unref === "function") interval.unref();
  logger.info({ intervalMs }, "outreach DNSBL checker started");
  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
    runNow: tick,
  };
}
