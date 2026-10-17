/**
 * The running worker's activation cards (A9, RK9-517). The publish feature
 * calls them through its hand-off and swap hooks; the gate feature registers
 * before it, and a missing gate fails both hooks closed.
 */

import type { StagingCards } from "../../gate/staging-card.js";

let current: StagingCards | null = null;

export function setActivationCards(cards: StagingCards | null): void {
  current = cards;
}

export function getActivationCards(): StagingCards | null {
  return current;
}
