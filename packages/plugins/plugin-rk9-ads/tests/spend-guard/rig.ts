import type { Company } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { BrandConfig } from "../../src/config.js";
import { createLedger } from "../../src/db.js";
import { registerSpendGuard, type SpendGuardOverrides } from "../../src/features/spend-guard/register.js";
import { memoryOnceStore, type NoticeResult, type SpendGuardNotifier } from "../../src/features/spend-guard/support.js";
import { gateRegistry, resetGateRegistry } from "../../src/features/telegram/gates.js";
import type { FeatureRuntime } from "../../src/features/types.js";
import { useCompanyConfigs, useCompanySecrets } from "../../src/kit/testing/harness.js";
import manifest from "../../src/manifest.js";
import { brandConfig, COMPANY_A, SECRET_A_BOT, SECRET_A_META, secretRef } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";

export const META_TOKEN = "EAAtest-meta-token-company-a-0000000000";
export const BOT_TOKEN = "123456:AAE-company-a-bot-token-xxxxxxxx";
export const CHAT_A = "-1001";
export const APPROVER = 4242;

export function telegramBlock() {
  return { botTokenRef: secretRef(SECRET_A_BOT), chatId: CHAT_A, allowedUserIds: [String(APPROVER)], mode: "poll" };
}

export class FakeNotifier implements SpendGuardNotifier {
  readonly messages: Array<{ companyId: string; text: string }> = [];
  readonly cards: Array<{ companyId: string; text: string; validUntil: Date }> = [];
  fail: Error | null = null;

  async sendMessage(companyId: string, config: BrandConfig, text: string): Promise<NoticeResult> {
    if (!config.telegram) return "not_configured";
    if (this.fail) throw this.fail;
    this.messages.push({ companyId, text });
    return "sent";
  }

  async sendPauseCard(companyId: string, config: BrandConfig, text: string, validUntil: Date): Promise<NoticeResult> {
    if (!config.telegram) return "not_configured";
    if (this.fail) throw this.fail;
    this.cards.push({ companyId, text, validUntil });
    return "sent";
  }
}

export interface Rig {
  harness: TestHarness;
  meta: FakeMeta;
  notifier: FakeNotifier;
  store: ReturnType<typeof memoryOnceStore>;
  /** Mutable clock. */
  clock: { now: Date };
  feeds: Map<string, () => Response | Promise<Response>>;
  /** rule_actions INSERTs as column -> value, in order. */
  ruleActions(): Array<Record<string, unknown>>;
}

export function rig(input: { config?: Record<string, unknown>; overrides?: SpendGuardOverrides; meta?: FakeMeta } = {}): Rig {
  const harness = createTestHarness({ manifest });
  harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
  useCompanyConfigs(harness, { [COMPANY_A]: input.config ?? brandConfig({ telegram: telegramBlock() }) });
  useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: META_TOKEN, [SECRET_A_BOT]: BOT_TOKEN } });
  const meta = input.meta ?? new FakeMeta();
  const feeds = new Map<string, () => Response | Promise<Response>>();
  harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
    const feed = feeds.get(url);
    if (!feed) throw new Error(`no route for ${url}`);
    return feed();
  };
  const notifier = new FakeNotifier();
  const store = memoryOnceStore();
  const clock = { now: new Date("2026-10-21T09:00:00Z") };
  const runtime: FeatureRuntime = {
    ctx: harness.ctx,
    ledger: createLedger(harness.ctx.db),
    handleWebhook() {},
    handleApiRoute() {},
    onConfigChanged() {},
    onShutdown() {},
  };
  resetGateRegistry();
  registerSpendGuard(runtime, { store, notifier, now: () => clock.now, ...input.overrides });
  return {
    harness,
    meta,
    notifier,
    store,
    clock,
    feeds,
    ruleActions: () =>
      harness.dbExecutes
        .filter((entry) => /INSERT INTO \S+\.rule_actions/.test(entry.sql))
        .map((entry) => {
          const columns = /\(([^)]*)\) VALUES/.exec(entry.sql)![1]!.split(",").map((column) => column.trim());
          const row = Object.fromEntries(columns.map((column, index) => [column, entry.params?.[index]]));
          if (typeof row.metrics === "string") row.metrics = JSON.parse(row.metrics);
          return row;
        }),
  };
}

export { gateRegistry };
