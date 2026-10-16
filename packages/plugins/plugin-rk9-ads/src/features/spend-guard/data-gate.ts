/**
 * Data gate (A6, RK9-511), the `--data-gate` mode of sunspot-pulse-off.sh.
 *
 * `schedule.dataGate` names a JSON feed, a JSON pointer into it, an operator
 * and a threshold. The predicate `value <operator> threshold` is the
 * condition under which the ads may keep running (Sunspot: "terraces in sun
 * now >= 8"). When it holds, nothing happens; when it no longer holds, the
 * caller runs pauseAll.
 *
 * The gate fails open: an unreachable feed, a non-2xx answer, a body that is
 * not JSON or a pointer that does not give a number pauses nothing and is
 * reported as a skip with a reason. The job logs a warning and fails its run
 * for such a skip, so a broken feed is seen (RK9-523). A pointer to an array
 * counts its items.
 */

import type { BrandConfig, RuleOperator } from "../../config.js";

export type DataGate = NonNullable<BrandConfig["schedule"]["dataGate"]>;

export type DataGateOutcome =
  | { action: "skip"; reason: "feed_unavailable" | "feed_unparseable" | "value_missing"; detail: string }
  | { action: "skip"; reason: "predicate_holds"; value: number }
  | { action: "pause"; value: number };

export type FeedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** RFC 6901 pointer lookup. Undefined when a segment is missing. */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let node: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      node = node[Number(segment)];
    } else if (node !== null && typeof node === "object" && Object.hasOwn(node, segment)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return node;
}

/** A number from the pointed value: a finite number, a numeric string, or an array's length. */
export function gateValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (Array.isArray(value)) return value.length;
  return null;
}

export function predicateHolds(value: number, operator: RuleOperator, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

export async function evaluateDataGate(fetch: FeedFetch, gate: DataGate): Promise<DataGateOutcome> {
  let body: string;
  try {
    const response = await fetch(gate.url, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) return { action: "skip", reason: "feed_unavailable", detail: `HTTP ${response.status}` };
    body = await response.text();
  } catch (error) {
    return { action: "skip", reason: "feed_unavailable", detail: error instanceof Error ? error.name : "fetch failed" };
  }
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { action: "skip", reason: "feed_unparseable", detail: "the feed is not JSON" };
  }
  const value = gateValue(resolveJsonPointer(document, gate.jsonPointer));
  if (value === null) return { action: "skip", reason: "value_missing", detail: `no number at ${gate.jsonPointer}` };
  if (predicateHolds(value, gate.operator, gate.threshold)) return { action: "skip", reason: "predicate_holds", value };
  return { action: "pause", value };
}
