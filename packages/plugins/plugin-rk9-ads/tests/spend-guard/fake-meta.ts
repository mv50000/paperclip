/**
 * A routing fake of the Meta Graph API for the spend-guard tests: it serves
 * an ad account, insights spend, campaigns, ad sets and ads with real paging,
 * applies `status=PAUSED` writes, and records every call.
 */

import { GRAPH_VERSION } from "../../src/meta/graph.js";

export interface FakeObject {
  id: string;
  name?: string;
  status: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  campaign_id?: string;
  adset_id?: string;
}

export interface FakeCallRecord {
  method: string;
  path: string;
  params: Record<string, string>;
  body: Record<string, string>;
}

const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Graph always sends effective_status; a fixture may leave it out. */
function withEffective(object: FakeObject): FakeObject {
  return { ...object, effective_status: object.effective_status ?? object.status };
}

export class FakeMeta {
  readonly accountId: string;
  account: Record<string, unknown>;
  /** Insights spend for a time range, as Graph's decimal string; null = no rows. */
  spend: (since: string, until: string) => string | null = () => "0.00";
  campaigns: FakeObject[] = [];
  adsets: FakeObject[] = [];
  ads: FakeObject[] = [];
  /** Object ids that belong to another ad account. */
  readonly foreign = new Set<string>();
  /** Objects per page of a list edge. */
  pageSize = 100;
  readonly calls: FakeCallRecord[] = [];
  /** Return an Error or a Response to fail a call. */
  fail: (call: FakeCallRecord) => Error | Response | null = () => null;

  constructor(accountId = "29231592883113369", account: Partial<Record<string, unknown>> = {}) {
    this.accountId = accountId;
    this.account = {
      currency: "EUR",
      timezone_name: "Europe/Helsinki",
      spend_cap: "10000",
      amount_spent: "0",
      account_status: 1,
      ...account,
    };
  }

  get writes(): FakeCallRecord[] {
    return this.calls.filter((call) => call.method !== "GET");
  }

  get insightsCalls(): FakeCallRecord[] {
    return this.calls.filter((call) => call.path.endsWith("/insights"));
  }

  private all(): FakeObject[] {
    return [...this.campaigns, ...this.adsets, ...this.ads];
  }

  private page(path: string, params: Record<string, string>, rows: FakeObject[]): Response {
    const offset = Number(params.after ?? "0");
    const slice = rows.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    const query = new URLSearchParams({ ...params, after: String(nextOffset) });
    return json(200, {
      data: slice.map(withEffective),
      ...(nextOffset < rows.length ? { paging: { next: `${BASE}/${path}?${query.toString()}` } } : {}),
    });
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/${GRAPH_VERSION}/`, "");
    const params = Object.fromEntries(parsed.searchParams.entries());
    const method = init?.method ?? "GET";
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body)).entries()) : {};
    const call = { method, path, params, body };
    this.calls.push(call);
    const failure = this.fail(call);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;

    const act = `act_${this.accountId}`;
    if (method === "GET") {
      if (path === act) return json(200, this.account);
      if (path === `${act}/insights`) {
        const range = JSON.parse(params.time_range ?? "{}") as { since?: string; until?: string };
        const spend = this.spend(range.since ?? "", range.until ?? "");
        return json(200, { data: spend === null ? [] : [{ spend, date_start: range.since, date_stop: range.until }] });
      }
      if (path === `${act}/campaigns`) return this.page(path, params, this.campaigns);
      if (path === `${act}/adsets`) return this.page(path, params, this.adsets);
      if (path === `${act}/ads`) return this.page(path, params, this.ads);
      const campaignAds = /^(\d+)\/ads$/.exec(path);
      if (campaignAds) return this.page(path, params, this.ads.filter((ad) => ad.campaign_id === campaignAds[1]));
      const object = this.all().find((entry) => entry.id === path);
      if (!object) return json(400, { error: { message: "Unsupported get request", type: "GraphMethodException", code: 100 } });
      if (params.fields === "account_id") return json(200, { id: object.id, account_id: this.foreign.has(object.id) ? "999" : this.accountId });
      return json(200, withEffective(object));
    }
    if (method === "POST") {
      const create = new RegExp(`^${act}/(campaigns|adsets|ads)$`).exec(path);
      if (create) {
        const id = String(900_000 + this.calls.length);
        const list = create[1] === "campaigns" ? this.campaigns : create[1] === "adsets" ? this.adsets : this.ads;
        list.push({ id, name: body.name, status: body.status ?? "ACTIVE" });
        return json(200, { id });
      }
      const object = this.all().find((entry) => entry.id === path);
      if (!object) return json(400, { error: { message: "Unsupported post request", type: "GraphMethodException", code: 100 } });
      if (body.status) {
        object.status = body.status;
        object.effective_status = body.status;
      }
      return json(200, { success: true });
    }
    return json(400, { error: { message: "unsupported", code: 100 } });
  };
}
