/**
 * Gate handlers per kind (A5, RK9-509). The plugin lists the kinds it allows
 * (the ads plugin: activate_ad, pause_all; scale_budget is not built, G9).
 * Registering any other kind throws, and the callback router refuses a card
 * whose kind has no handler, without changing its state.
 */

import type { GateDecision, GateRequestRecord } from "./state-machine.js";

export interface GateHandlerInput {
  decision: GateDecision;
  request: GateRequestRecord;
  /** Telegram user id of the approver. */
  tgUserId: number;
}

export interface GateHandlerResult {
  /** Status line for the card, e.g. "✅ Mainos aktivoitu". */
  statusText?: string;
  /** Stored in gate_requests.outcome. Keep it free of secrets. */
  outcome?: Record<string, unknown>;
}

/**
 * Runs after the state transition. A throw on an approved card moves it to
 * `failed` and shows the error line on the card.
 */
export type GateHandler = (input: GateHandlerInput) => Promise<GateHandlerResult | void>;

export interface GateRegistry<K extends string = string> {
  readonly kinds: readonly K[];
  register(kind: K, handler: GateHandler): void;
  get(kind: string): GateHandler | undefined;
  has(kind: string): boolean;
}

export function createGateRegistry<K extends string>(kinds: readonly K[]): GateRegistry<K> {
  const allowed = new Set<string>(kinds);
  const handlers = new Map<string, GateHandler>();
  return {
    kinds,
    register(kind, handler) {
      if (!allowed.has(kind)) throw new Error(`Gate kind ${String(kind)} is not allowed`);
      if (handlers.has(kind)) throw new Error(`Gate kind ${String(kind)} already has a handler`);
      if (typeof handler !== "function") throw new Error("Gate handler must be a function");
      handlers.set(kind, handler);
    },
    get(kind) {
      return allowed.has(kind) ? handlers.get(kind) : undefined;
    },
    has(kind) {
      return allowed.has(kind) && handlers.has(kind);
    },
  };
}
