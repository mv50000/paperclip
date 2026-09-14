// RK9-197: daily DNSBL (DNS blocklist) reputation check for the outreach
// sending IP. Pure `node:dns` — no new dependency. A DNSBL is queried by
// reversing the IP's octets and looking it up as a subdomain of the list
// (e.g. `2.0.0.127.zen.spamhaus.org`); an A-record response means "listed",
// NXDOMAIN/no-data means "not listed". `127.0.0.2` is the industry-standard
// canary test address that every real DNSBL is required to list — querying
// it daily is the AC's "hälyttää testilistauksella" self-test: it doesn't
// check reputation, it checks that the query mechanism itself still works
// (DNS egress, correct query construction). A `false` self-test result means
// "we can't trust any of the real results below", not "we're not listed".
import { resolve4 } from "node:dns/promises";
import { logger } from "../../middleware/logger.js";

export const OUTREACH_DNSBL_DEFAULT_LISTS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
] as const;

/** Every real DNSBL is required to list this address — used only for the self-test, never a real reputation check. */
export const OUTREACH_DNSBL_CANARY_IP = "127.0.0.2";

export interface DnsblLookupResult {
  list: string;
  ip: string;
  listed: boolean;
  /** Set when the lookup itself failed for a reason other than "not listed" (e.g. DNS server unreachable) — `listed` is `false` in that case too, but the caller shouldn't treat it as a clean result. */
  error: string | null;
}

function reverseIpOctets(ip: string): string {
  return ip.split(".").reverse().join(".");
}

export async function checkDnsbl(list: string, ip: string): Promise<DnsblLookupResult> {
  const query = `${reverseIpOctets(ip)}.${list}`;
  try {
    await resolve4(query);
    return { list, ip, listed: true, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { list, ip, listed: false, error: null };
    }
    return { list, ip, listed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkAllDnsbl(lists: readonly string[], ip: string): Promise<DnsblLookupResult[]> {
  return Promise.all(lists.map((list) => checkDnsbl(list, ip)));
}

export interface OutreachDnsblState {
  checkedAt: Date | null;
  /** The configured sending IP as of the last check, or `null` if none was configured (the reputation check is then skipped — only the self-test still runs). */
  productionIp: string | null;
  results: DnsblLookupResult[];
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
  selfTest: { checkedAt: null, ok: null },
};

export function getOutreachDnsblState(): OutreachDnsblState {
  return state;
}

export interface RunDnsblCheckOpts {
  lists?: readonly string[];
  /** The outreach sending IP (rk9-prod's outbound address) to check for real reputation listings. `undefined` skips the reputation check but still runs the canary self-test. */
  productionIp: string | undefined;
}

export async function runOutreachDnsblCheck(opts: RunDnsblCheckOpts): Promise<OutreachDnsblState> {
  const lists = opts.lists ?? OUTREACH_DNSBL_DEFAULT_LISTS;
  const now = new Date();

  const canary = await checkDnsbl(lists[0] ?? OUTREACH_DNSBL_DEFAULT_LISTS[0], OUTREACH_DNSBL_CANARY_IP);
  const selfTestOk = canary.listed && canary.error === null;
  state.selfTest = { checkedAt: now, ok: selfTestOk };
  if (!selfTestOk) {
    logger.error({ canary }, "outreach DNSBL self-test failed: canary address not reported as listed");
  }

  if (opts.productionIp) {
    state.results = await checkAllDnsbl(lists, opts.productionIp);
    state.productionIp = opts.productionIp;
    const listedOn = state.results.filter((r) => r.listed);
    if (listedOn.length > 0) {
      logger.error(
        { productionIp: opts.productionIp, listedOn: listedOn.map((r) => r.list) },
        "outreach sending IP is listed on a DNSBL",
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
