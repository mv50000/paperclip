/**
 * Gate kinds of the ads plugin and the handler registry API (A5, RK9-509).
 *
 * The kinds mirror the CHECK constraint of gate_requests in migration 001:
 * activate_ad (A9, RK9-517) and pause_all (the kill switch, RK9-511).
 * scale_budget is not a kind (G9), so registering it throws.
 *
 * The telegram feature registers first and creates a fresh registry on every
 * worker setup; features after it call `registerGateHandler()` from their own
 * `register()`.
 */

import { GATE_REQUEST_KINDS } from "../../db.js";
import { createGateRegistry, type GateHandler, type GateRegistry } from "../../kit/gate/registry.js";

export type GateKind = (typeof GATE_REQUEST_KINDS)[number];

let current: GateRegistry<GateKind> = createGateRegistry(GATE_REQUEST_KINDS);

/** Called by the telegram feature on setup. */
export function resetGateRegistry(): GateRegistry<GateKind> {
  current = createGateRegistry(GATE_REQUEST_KINDS);
  return current;
}

export function gateRegistry(): GateRegistry<GateKind> {
  return current;
}

export function registerGateHandler(kind: GateKind, handler: GateHandler): void {
  current.register(kind, handler);
}
