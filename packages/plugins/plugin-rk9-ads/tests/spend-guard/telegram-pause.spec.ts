/**
 * The Telegram trigger of the kill switch (A6, RK9-511): a pause_all card
 * from the plugin's own bot (G1, no core listener). One tap from an
 * allowlisted user in the brand chat pauses everything; any other tap is
 * refused and audited, and nothing is paused.
 */

import type { PluginLogger } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createCallbackRouter, type GateAuditEvent, type GateBrand } from "../../src/kit/gate/callback-router.js";
import { createGateCard } from "../../src/kit/gate/state-machine.js";
import { createBotApi } from "../../src/kit/telegram/bot-api.js";
import { createMemoryGateStore } from "../../src/kit/testing/memory-gate-store.js";
import { COMPANY_A } from "../fixtures.js";
import { FakeTelegram } from "../helpers/fake-telegram.js";
import { FakeMeta } from "./fake-meta.js";
import { APPROVER, BOT_TOKEN, CHAT_A, gateRegistry, rig } from "./rig.js";

const silent: PluginLogger = { info() {}, warn() {}, error() {}, debug() {} };
let updateId = 70_000;

async function setup() {
  const meta = new FakeMeta();
  meta.campaigns = [{ id: "100", name: "OLL", status: "ACTIVE" }];
  meta.ads = [{ id: "301", name: "ad", status: "ACTIVE", campaign_id: "100" }];
  const r = rig({ meta });
  const fake = new FakeTelegram();
  const api = createBotApi({ token: BOT_TOKEN, fetch: fake.fetch });
  const store = createMemoryGateStore();
  const audits: GateAuditEvent[] = [];
  const brand: GateBrand = { companyId: COMPANY_A, chatId: CHAT_A, allowedUserIds: [String(APPROVER)] };
  const router = createCallbackRouter({
    api,
    store,
    registry: gateRegistry(),
    brandFor: (id) => (id === COMPANY_A ? brand : null),
    logger: silent,
    audit: async (event) => void audits.push(event),
  });
  const card = await createGateCard({
    store,
    api,
    registry: gateRegistry(),
    companyId: COMPANY_A,
    brandCode: "OLL",
    kind: "pause_all",
    chatId: CHAT_A,
    validUntil: new Date(Date.now() + 60_000),
    card: { media: "text", text: "⚠️ OLL: kulutus 81 %" },
    labels: { approve: "⏸ Pysäytä kaikki", deny: "Ohita" },
  });
  const tap = async (fromId: number, chatId?: number) => {
    const data = fake.buttons(card.messageId)[0]!;
    await router.handleUpdate({ ...fake.callbackUpdate({ messageId: card.messageId, data, fromId, chatId }), update_id: updateId++ });
    await router.idle();
  };
  return { r, meta, fake, card, audits, tap };
}

describe("Telegram pause_all button", () => {
  it("shows the pause button on the card", async () => {
    const { fake, card } = await setup();
    const keyboard = fake.messages.get(card.messageId)?.reply_markup?.inline_keyboard?.flat() ?? [];
    expect(keyboard.map((button) => button.text)).toEqual(["⏸ Pysäytä kaikki", "Ohita"]);
  });

  it("refuses and audits a tap from a user outside the allowlist, and pauses nothing", async () => {
    const { meta, audits, tap } = await setup();
    await tap(999);
    expect(meta.writes).toHaveLength(0);
    expect(audits).toContainEqual(expect.objectContaining({ type: "unauthorized", tgUserId: 999, reason: "user" }));
  });

  it("refuses a tap from the right user in another chat", async () => {
    const { meta, audits, tap } = await setup();
    await tap(APPROVER, -999);
    expect(meta.writes).toHaveLength(0);
    expect(audits).toContainEqual(expect.objectContaining({ type: "unauthorized", reason: "chat" }));
  });

  it("pauses everything on one allowlisted tap, with no further approval step", async () => {
    const { r, meta, fake, card, tap } = await setup();
    await tap(APPROVER);
    expect(meta.writes.map((call) => [call.path, call.body.status])).toEqual([
      ["301", "PAUSED"],
      ["100", "PAUSED"],
    ]);
    expect(fake.messages.get(card.messageId)?.text).toContain("⏸ Pysäytetty: 1 mainosta, 1 kampanjaa");
    expect(r.ruleActions()[0]).toMatchObject({ rule_type: "kill_switch", source: "telegram", applied: true });
  });
});
