/**
 * Gate handlers per kind (A5, RK9-509). The plugin lists the kinds it allows
 * (the ads plugin: activate_ad, pause_all; scale_budget is not built, G9).
 * Registering any other kind throws, and the callback router refuses a card
 * whose kind has no handler, without changing its state.
 */

import type { GateRequestRecord } from "./state-machine.js";

/** Runs only for an approval; a denial is final without a handler. */
export interface GateHandlerInput {
  request: GateRequestRecord;
  /** Telegram user id of the approver. */
  tgUserId: number;
}

export interface GateHandlerResult {
  /** Status line for the card, e.g. "✅ Mainos aktivoitu". */
  statusText?: string;
  /** Stored in gate_requests.outcome. Keep it free of secrets. */
  outcome?: Record<string, unknown>;
  /**
   * Final status when it is not `approved`: `denied` when the handler refused
   * before it acted (e.g. a fresh check failed), `failed` when it stopped part
   * way. Default `approved`.
   */
  status?: "denied" | "failed";
  /** Stored in gate_requests.error with a `denied` or `failed` status. Redacted by the handler. */
  error?: string;
}

/**
 * Runs once after pending -> approved. A throw moves the card to `failed`.
 * The handler should be idempotent at the remote side (see callback-router).
 */
export type GateHandler = (input: GateHandlerInput) => Promise<GateHandlerResult | void>;

/** A preset reason button. `code` is stored; `label` is shown. */
export interface GateDenyReasonOption {
  code: string;
  label: string;
}

export interface GateDenyReasonInput {
  request: GateRequestRecord;
  /** Telegram user id of the approver who gave the reason. */
  tgUserId: number;
  /** A preset code, or `freeTextCode` for a typed reply. */
  code: string;
  /** The typed reply (trimmed, clipped), or null for a preset. */
  text: string | null;
}

/**
 * Asks for the reason of a denial (RK9-832). After a deny tap the router
 * swaps the card's buttons for the preset reasons, and a reply to the card
 * message is taken as a free-text reason. The first reason wins
 * (`GateStore.claimDenyReason`); later taps and replies change nothing.
 * Nothing here sends a new Telegram message: the card itself is edited.
 */
export interface GateDenyReasons {
  /** 1-8 presets. Codes match /^[a-z0-9_]{1,24}$/. */
  options: readonly GateDenyReasonOption[];
  /** Accept a reply to the card message as the reason. */
  freeText: boolean;
  /** Code stored with a typed reply. Default "other". */
  freeTextCode?: string;
  /** Status line under the denial while the reason is missing. */
  prompt: string;
  /** Runs once after pending -> denied (before any reason). A throw is logged. */
  onDenied?(input: { request: GateRequestRecord; tgUserId: number }): Promise<void>;
  /** Runs once after the kit has stored the first reason. A throw is logged. */
  onReason(input: GateDenyReasonInput): Promise<void>;
}

export interface GateRegisterOptions {
  denyReasons?: GateDenyReasons;
}

export const DENY_REASON_CODE_RE = /^[a-z0-9_]{1,24}$/;
export const MAX_DENY_REASON_OPTIONS = 8;

export interface GateRegistry<K extends string = string> {
  readonly kinds: readonly K[];
  register(kind: K, handler: GateHandler, options?: GateRegisterOptions): void;
  get(kind: string): GateHandler | undefined;
  has(kind: string): boolean;
  /** The reason prompt of a kind, when it asks for one. */
  denyReasons(kind: string): GateDenyReasons | undefined;
}

function checkDenyReasons(kind: string, reasons: GateDenyReasons): void {
  const { options } = reasons;
  if (!Array.isArray(options) || options.length === 0 || options.length > MAX_DENY_REASON_OPTIONS) {
    throw new Error(`Gate kind ${kind}: denyReasons needs 1-${MAX_DENY_REASON_OPTIONS} options`);
  }
  const codes = new Set<string>();
  for (const option of [...options.map((entry) => entry.code), ...(reasons.freeText ? [reasons.freeTextCode ?? "other"] : [])]) {
    if (!DENY_REASON_CODE_RE.test(option) || codes.has(option)) throw new Error(`Gate kind ${kind}: invalid or repeated reason code ${option}`);
    codes.add(option);
  }
  if (options.some((entry) => typeof entry.label !== "string" || entry.label.trim().length === 0)) {
    throw new Error(`Gate kind ${kind}: every reason needs a label`);
  }
  if (typeof reasons.onReason !== "function") throw new Error(`Gate kind ${kind}: denyReasons.onReason must be a function`);
}

export function createGateRegistry<K extends string>(kinds: readonly K[]): GateRegistry<K> {
  const allowed = new Set<string>(kinds);
  const handlers = new Map<string, GateHandler>();
  const reasons = new Map<string, GateDenyReasons>();
  return {
    kinds,
    register(kind, handler, options = {}) {
      if (!allowed.has(kind)) throw new Error(`Gate kind ${String(kind)} is not allowed`);
      if (handlers.has(kind)) throw new Error(`Gate kind ${String(kind)} already has a handler`);
      if (typeof handler !== "function") throw new Error("Gate handler must be a function");
      if (options.denyReasons) checkDenyReasons(String(kind), options.denyReasons);
      handlers.set(kind, handler);
      if (options.denyReasons) reasons.set(kind, options.denyReasons);
    },
    denyReasons(kind) {
      return allowed.has(kind) && handlers.has(kind) ? reasons.get(kind) : undefined;
    },
    get(kind) {
      return allowed.has(kind) ? handlers.get(kind) : undefined;
    },
    has(kind) {
      return allowed.has(kind) && handlers.has(kind);
    },
  };
}
