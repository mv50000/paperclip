/**
 * The pause retry's RK9-565 verifier Lows (RK9-567), on the scheduled-pause
 * job's tick (pending-undo.ts retryPendingUndos):
 * - L1: a newer card approved between the tick's lookup and its PAUSED write
 *   is looked for again after the write, and one alert says the retry may
 *   have paused it;
 * - L2: a newer card with no recorded end past the in-flight window has an
 *   unknown result: the tick pauses and alerts the same way;
 * - N1: a newer card marked running for long fails the run while the retry
 *   waits;
 * - L5: a PAUSED write that Meta refuses for good alerts once and then waits
 *   for the board without failing every run;
 * - N3: each object of a gate request gets its own drop alert;
 * - L7: the audit row of an unread halt names it, and a failed audit insert
 *   fails the run;
 * - L4: a config that cannot be loaded names the open retries.
 * Meta is a routing fake and Telegram a recording notifier.
 */

import { describe, expect, it } from "vitest";
import { parseBrandConfig, type BrandConfig } from "../../src/config.js";
import { createLedger } from "../../src/db.js";
import type { UiOverview } from "../../src/features/ui/dto.js";
import { OVERVIEW_DATA_KEY, registerUi } from "../../src/features/ui/register.js";
import { addPendingUndos, readPendingUndos, reportUndoFailure, type PendingUndo } from "../../src/features/spend-guard/pending-undo.js";
import type { NewerActivation, NewerActivationQuery } from "../../src/gate/gate-requests.js";
import { brandConfig, COMPANY_A } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { rig, telegramBlock, type Rig } from "./rig.js";

const AD = "301";
const CAMPAIGN = "100";
const CARD = "gate-old";

function activeMeta(): FakeMeta {
  const meta = new FakeMeta();
  meta.spend = () => "10.00";
  meta.account = { ...meta.account, amount_spent: "1000" };
  meta.campaigns = [{ id: CAMPAIGN, name: "OLL", status: "ACTIVE" }];
  meta.adsets = [{ id: "200", name: "set", status: "ACTIVE", campaign_id: CAMPAIGN, daily_budget: "300" }];
  meta.ads = [{ id: AD, name: "ad", status: "ACTIVE", campaign_id: CAMPAIGN }];
  return meta;
}

function config(): BrandConfig {
  const parsed = parseBrandConfig(brandConfig({ telegram: telegramBlock() }));
  if (parsed.state !== "enabled") throw new Error("test config invalid");
  return parsed.config;
}

/** Meta answers the PAUSED write of `objectId` with `error` while `refusing()`. */
function refusePause(meta: FakeMeta, objectId: string, error: Record<string, unknown>, refusing: () => boolean = () => true): void {
  const previous = meta.fail;
  meta.fail = (call) =>
    refusing() && call.method === "POST" && call.path === objectId && call.body.status === "PAUSED"
      ? new Response(JSON.stringify({ error }), { status: 400 })
      : (previous?.(call) ?? null);
}

const pauses = (meta: FakeMeta, id: string) => meta.writes.filter((call) => call.path === id && call.body.status === "PAUSED").length;
const alerts = (r: Rig, text: string) => r.notifier.messages.filter((message) => message.text.includes(text));

async function tick(r: Rig, iso: string): Promise<string | null> {
  r.clock.now = new Date(iso);
  try {
    await r.harness.runJob("scheduled-pause");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A rig with one failed undo of the ad (no halt in force) and a scripted newer-card lookup. */
async function openUndo(lookup: (query: NewerActivationQuery, call: number) => NewerActivation | null, objects: PendingUndo["kind"][] = ["ad"]) {
  const queries: NewerActivationQuery[] = [];
  const r = rig({
    meta: activeMeta(),
    overrides: {
      newerActivation: async (_companyId, query) => {
        queries.push(query);
        return lookup(query, queries.length);
      },
    },
  });
  const ids: Record<PendingUndo["kind"], string> = { ad: AD, campaign: CAMPAIGN, adset: "200" };
  await reportUndoFailure(
    { ctx: r.harness.ctx, store: r.store, notifier: r.notifier },
    COMPANY_A,
    config(),
    { gateRequestId: CARD, haltRule: "kill_switch", failed: objects.map((kind) => ({ kind, objectId: ids[kind], error: "rate limited" })) },
    new Date("2026-10-21T10:00:00Z"),
  );
  return { r, queries };
}

describe("a newer card approved during the retry's reads (L1, L2)", () => {
  it("looks again after the PAUSED write; a hit alerts once that the retry may have paused it, and the entry ends", async () => {
    const { r, queries } = await openUndo((_query, call) => (call === 1 ? null : { id: "gate-late", inFlight: false, ageMinutes: 0 }));
    expect(await tick(r, "2026-10-21T10:05:00Z")).toBeNull();
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual(queries[0]);
    expect(pauses(r.meta, AD)).toBe(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const overlap = alerts(r, "uudelleenyritys pysäytti kohteen");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.text).toContain("uudempi kortti gate-late hyväksyttiin sen aikana");
    expect(overlap[0]!.text).toContain(`mainos ${AD}`);
    expect(r.ruleActions().at(-1)).toMatchObject({ applied: true, metrics: { newerActivation: "gate-late", newerActivationResult: "activated" } });
    expect(r.harness.logs.some((log) => log.level === "warn" && /may have paused a newer activation/.test(log.message))).toBe(true);
  });

  it("no second lookup hit, no alert", async () => {
    const { r } = await openUndo(() => null);
    expect(await tick(r, "2026-10-21T10:05:00Z")).toBeNull();
    expect(alerts(r, "uudelleenyritys pysäytti kohteen")).toHaveLength(0);
    expect(r.ruleActions().at(-1)!.metrics).not.toHaveProperty("newerActivation");
  });

  it("a newer card with an unknown result does not end the retry: the tick pauses and alerts that it may have succeeded", async () => {
    const unknown = { id: "gate-lost", inFlight: false, unknown: true, ageMinutes: 45 };
    const { r } = await openUndo(() => unknown);
    expect(await tick(r, "2026-10-21T10:05:00Z")).toBeNull();
    expect(pauses(r.meta, AD)).toBe(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
    const overlap = alerts(r, "kortin tulosta ei tallennettu");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.text).toContain("gate-lost");
    expect(alerts(r, "uudelleenyritys lopetettiin")).toHaveLength(0);
    expect(r.ruleActions().at(-1)).toMatchObject({ metrics: { newerActivation: "gate-lost", newerActivationResult: "unknown" } });
  });

  it("a second lookup that fails is reported, and the pause stands", async () => {
    const { r } = await openUndo((_query, call) => {
      if (call === 2) throw new Error("db down");
      return null;
    });
    const message = await tick(r, "2026-10-21T10:05:00Z");
    expect(message).toMatch(/not read again after the pause \((Error: )?db down\)/);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });
});

describe("a newer card marked running (N1)", () => {
  it("waits quietly at first, and fails the run once the card has been running for long", async () => {
    let age = 1;
    const { r } = await openUndo(() => ({ id: "gate-running", inFlight: true, ageMinutes: age }));
    expect(await tick(r, "2026-10-21T10:05:00Z")).toBeNull();
    age = 7;
    expect(await tick(r, "2026-10-21T10:10:00Z")).toMatch(/newer card gate-running of ad 301 was approved 7 min ago and has recorded no end/);
    expect(pauses(r.meta, AD)).toBe(0);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toHaveLength(1);
  });
});

describe("a PAUSED write that Meta refuses for good (L5)", () => {
  it("fails the run and alerts once, then retries quietly until Meta confirms; a transient error is loud again", async () => {
    const { r } = await openUndo(() => null);
    let mode: "token" | "rate" | "ok" = "token";
    refusePause(r.meta, AD, { message: "Error validating access token", code: 190, type: "OAuthException" }, () => mode === "token");
    refusePause(r.meta, AD, { message: "rate limited", code: 17 }, () => mode === "rate");

    expect(await tick(r, "2026-10-21T10:05:00Z")).toMatch(/activation undo: Meta refuses pausing ad 301 for good \(token_invalid/);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD, permanentError: "token_invalid", permanentSince: "2026-10-21T10:05:00.000Z", attempts: 2 }]);
    const permanent = () => alerts(r, "Meta hylkää pysäytyksen pysyvästi");
    expect(permanent()).toHaveLength(1);
    expect(permanent()[0]!.text).toContain("access token on vanhentunut");
    expect(permanent()[0]!.text).toContain(`mainos ${AD}`);

    // Quiet: the write is still tried, the run passes, no second alert.
    expect(await tick(r, "2026-10-21T10:10:00Z")).toBeNull();
    expect(await tick(r, "2026-10-21T10:15:00Z")).toBeNull();
    expect(pauses(r.meta, AD)).toBe(3);
    expect(permanent()).toHaveLength(1);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ permanentError: "token_invalid", permanentSince: "2026-10-21T10:05:00.000Z", attempts: 4 }]);

    mode = "rate";
    expect(await tick(r, "2026-10-21T10:20:00Z")).toMatch(/pausing ad 301 failed again/);
    const [entry] = await readPendingUndos(r.harness.ctx, COMPANY_A);
    expect(entry).not.toHaveProperty("permanentError");
    expect(entry).not.toHaveProperty("permanentSince");

    mode = "ok";
    expect(await tick(r, "2026-10-21T10:25:00Z")).toBeNull();
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });

  it("a deleted object (code 100, subcode 33) counts as permanent, and the UI's overview names it", async () => {
    const { r } = await openUndo(() => null);
    refusePause(r.meta, AD, { message: "Unsupported post request. Object with ID '301' does not exist", code: 100, error_subcode: 33 });
    expect(await tick(r, "2026-10-21T10:05:00Z")).toMatch(/for good \(object_missing/);
    expect(alerts(r, "kohdetta ei ole enää Metassa")).toHaveLength(1);
    registerUi({ ctx: r.harness.ctx, ledger: createLedger(r.harness.ctx.db), handleWebhook() {}, handleApiRoute() {}, onConfigChanged() {}, onShutdown() {} });
    const overview = (await r.harness.getData(OVERVIEW_DATA_KEY, { companyId: COMPANY_A })) as UiOverview;
    expect(overview.pendingUndo).toMatchObject([{ objectId: AD, permanentError: "object_missing", attempts: 2 }]);
  });
});

describe("drop alerts per object (N3)", () => {
  it("a second object of the same gate request dropped on a later tick gets its own alert", async () => {
    let adSuperseded = false;
    const { r } = await openUndo(
      (query) => (query.objectId === CAMPAIGN || adSuperseded ? { id: "gate-new", inFlight: false, ageMinutes: 0 } : null),
      ["campaign", "ad"],
    );
    refusePause(r.meta, AD, { message: "rate limited", code: 17 });
    await tick(r, "2026-10-21T10:05:00Z");
    const dropped = () => alerts(r, "aktivoinnin peruutuksen uudelleenyritys lopetettiin");
    expect(dropped()).toHaveLength(1);
    expect(dropped()[0]!.text).toContain(`kampanja ${CAMPAIGN}`);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toMatchObject([{ objectId: AD }]);

    adSuperseded = true;
    expect(await tick(r, "2026-10-21T10:10:00Z")).toBeNull();
    expect(dropped()).toHaveLength(2);
    expect(dropped()[1]!.text).toContain(`mainos ${AD}`);
    expect(dropped()[1]!.text).not.toContain(`kampanja ${CAMPAIGN}`);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });
});

describe("the retry's audit rows (L7)", () => {
  it("an undo whose halt could not be read files as kill_switch with metrics.haltRule null", async () => {
    const r = rig({ meta: activeMeta(), overrides: { newerActivation: async () => null } });
    await addPendingUndos(r.harness.ctx, COMPANY_A, [
      { objectId: AD, kind: "ad", gateRequestId: CARD, brandCode: "OLL", haltRule: null, since: "2026-10-21T10:00:00.000Z", error: "rate limited" },
    ]);
    expect(await tick(r, "2026-10-21T10:05:00Z")).toBeNull();
    expect(r.ruleActions().at(-1)).toMatchObject({ rule_type: "kill_switch", object_id: AD, applied: true, metrics: { haltRule: null } });
  });

  it("an audit row that cannot be written fails the run", async () => {
    const { r } = await openUndo(() => null);
    const execute = r.harness.ctx.db.execute.bind(r.harness.ctx.db);
    r.harness.ctx.db.execute = async (sql, params) => {
      if (/INSERT INTO \S+\.rule_actions/.test(sql)) throw new Error("ledger down");
      return execute(sql, params);
    };
    expect(await tick(r, "2026-10-21T10:05:00Z")).toMatch(/activation undo: the audit row of ad 301 was not written \((Error: )?ledger down\)/);
    expect(await readPendingUndos(r.harness.ctx, COMPANY_A)).toEqual([]);
  });
});

describe("a config that cannot be loaded (L4)", () => {
  it("fails the run and names the open retries it cannot run", async () => {
    const r = rig({ meta: activeMeta(), config: { ...brandConfig({ telegram: telegramBlock() }), timeZone: "Not/AZone" } });
    await addPendingUndos(r.harness.ctx, COMPANY_A, [
      { objectId: AD, kind: "ad", gateRequestId: CARD, brandCode: "OLL", haltRule: "kill_switch", since: "2026-10-21T10:00:00.000Z", error: "rate limited" },
    ]);
    const message = await tick(r, "2026-10-21T10:05:00Z");
    expect(message).toMatch(/nothing paused/);
    expect(message).toMatch(new RegExp(`1 activation undo\\(s\\) or pause retry\\(ies\\) open \\(ad ${AD}\\) but no brand config to retry them`));
  });
});
