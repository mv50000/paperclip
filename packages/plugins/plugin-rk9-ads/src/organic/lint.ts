/**
 * The brand-lint result an organic request carries (RK9-832).
 *
 * brand-lint runs in the rk9-motion repo (scripts/brand-lint.mjs, RK9-830,
 * RK9-841) on the finished video and its source, in the agent's sandbox. The
 * plugin never runs it: it validates the JSON, keeps a bounded copy on the
 * post and shows it on the card. A failed or draft result refuses the card.
 * The verdict is recomputed from the rows, so `ok: true` with a `fail` row is
 * still a failure.
 */

import { z } from "zod";
import type { OrganicLint } from "./types.js";

const MAX_ROWS = 200;

const rowSchema = z.object({
  id: z.string().min(1).max(120),
  rule: z.string().max(400).default(""),
  status: z.enum(["pass", "partial", "fail", "skip", "human"]),
  detail: z.string().max(4_000).optional(),
});

const lintSchema = z.object({
  brand: z.string().max(80).nullable().optional(),
  mode: z.enum(["strict", "draft"]).default("strict"),
  ok: z.boolean(),
  needsHumanReview: z.boolean().optional(),
  results: z.array(rowSchema).min(1).max(MAX_ROWS),
});

export type LintCheck = { ok: true; lint: OrganicLint } | { ok: false; code: "invalid_lint" | "lint_failed" | "lint_draft"; message: string };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function checkLint(input: unknown): LintCheck {
  const parsed = lintSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, code: "invalid_lint", message: `brandLint is not a brand-lint JSON result${first ? ` (${first.path.join(".")}: ${first.message})` : ""}` };
  }
  const raw = parsed.data;
  const results = raw.results.map((row) => ({
    id: row.id,
    rule: clip(row.rule, 200),
    status: row.status,
    ...(row.detail ? { detail: clip(row.detail, 300) } : {}),
  }));
  const count = (status: OrganicLint["results"][number]["status"]) => results.filter((row) => row.status === status).length;
  const summary = { pass: count("pass"), partial: count("partial"), fail: count("fail"), skip: count("skip"), human: count("human") };
  const lint: OrganicLint = {
    brand: raw.brand ?? null,
    mode: raw.mode,
    ok: raw.ok && summary.fail === 0,
    needsHumanReview: (raw.needsHumanReview ?? false) || summary.partial > 0,
    summary,
    results,
  };
  if (lint.mode === "draft") return { ok: false, code: "lint_draft", message: "brand-lint ran with --draft; a draft result cannot be approved" };
  if (!lint.ok) {
    const failed = results.filter((row) => row.status === "fail").map((row) => row.id);
    return { ok: false, code: "lint_failed", message: `brand-lint failed${failed.length > 0 ? `: ${failed.slice(0, 10).join(", ")}` : ""}` };
  }
  return { ok: true, lint };
}
