import { createSqlGateStore } from "../../kit/gate/state-machine.js";
import type { FeatureRuntime } from "../types.js";
import { setTelegramController, TelegramController } from "./controller.js";
import { resetGateRegistry } from "./gates.js";

const CONFIG_PLAN_DELAY_MS = 500;

/**
 * Telegram transport and the gate state machine (A5, RK9-509). Planning makes
 * network calls, so it runs in the background: setup and onConfigChanged
 * return at once. Features registered after this one add gate handlers with
 * `registerGateHandler()` (./gates.ts).
 */

export function register(runtime: FeatureRuntime): void {
  const { ctx } = runtime;
  const registry = resetGateRegistry();
  const controller = new TelegramController(ctx, { store: createSqlGateStore(ctx.db), registry });
  setTelegramController(controller);

  runtime.handleWebhook("telegram", (input) => controller.handleWebhook(input));
  // The saved config may revoke an approver: hold spend decisions until the
  // plan has read it. Plan after the onConfigChanged call has returned: while
  // it is open, the host refuses the proactive companies.list that planning needs.
  runtime.onConfigChanged(async () => {
    controller.holdAll("config_changed");
    setTimeout(() => void controller.replan("config"), CONFIG_PLAN_DELAY_MS).unref?.();
  });
  runtime.onShutdown(async () => {
    await controller.stop();
    setTelegramController(null);
  });
  void controller.replan("setup");
}
