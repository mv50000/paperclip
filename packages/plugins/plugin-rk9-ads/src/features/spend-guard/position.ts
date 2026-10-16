/**
 * Month position (RK9-526): MTD against the monthly cap and Meta's spend_cap
 * headroom. The one computation both the spend guard (./guard.ts) and the
 * morning digest (../../digest/run.ts) use, so the two never show different
 * figures for the same reads.
 *
 * Canonical MTD is the guard's Graph read (account-level insights of the local
 * calendar month, re-read on every check). The digest takes it from a guard
 * snapshot and uses insights_daily only to cross-check it, or as a labelled
 * fallback when the guard cannot read Meta.
 */

export interface MonthPositionInput {
  monthlyCapEur: number;
  mtdCents: number;
  /** Meta account spend_cap; null when the account has none. */
  spendCapCents: number | null;
  /** Meta account amount_spent (spend since the last spend_cap reset). */
  amountSpentCents: number;
}

export interface MonthPosition {
  capCents: number;
  mtdCents: number;
  spendCapCents: number | null;
  amountSpentCents: number;
  /** spend_cap - amount_spent: what Meta still lets the account spend. Null without a spend_cap. */
  headroomCents: number | null;
  /** What is left of the monthly cap: cap - MTD (negative when MTD is over the cap). */
  remainingCents: number;
  /** MTD as a share of the monthly cap, 0-100+ with one decimal, floored; null when the cap is 0. */
  pctUsed: number | null;
  /**
   * Meta's headroom is above what is left of the monthly cap, so Meta's own
   * cap does not stop spend in time (guard rule 4). False when the headroom is
   * used up: Meta then delivers nothing more.
   */
  headroomExceedsRemaining: boolean;
}

export function capCents(monthlyCapEur: number): number {
  return Math.round(monthlyCapEur * 100);
}

export function monthPosition(input: MonthPositionInput): MonthPosition {
  const cap = capCents(input.monthlyCapEur);
  const headroomCents = input.spendCapCents === null ? null : input.spendCapCents - input.amountSpentCents;
  const remainingCents = cap - input.mtdCents;
  return {
    capCents: cap,
    mtdCents: input.mtdCents,
    spendCapCents: input.spendCapCents,
    amountSpentCents: input.amountSpentCents,
    headroomCents,
    remainingCents,
    pctUsed: cap > 0 ? Math.floor((input.mtdCents * 1000) / cap) / 10 : null,
    headroomExceedsRemaining: headroomCents !== null && headroomCents > 0 && headroomCents > remainingCents,
  };
}
