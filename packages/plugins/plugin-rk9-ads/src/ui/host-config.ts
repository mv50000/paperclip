/**
 * Saves the rule editor's `rules` block through the host's config route.
 *
 * The worker has no config write API, so the browser saves it with the
 * operator's own session: GET the company's saved config, replace only
 * `rules` with the block `rules.prepareSave` returned, POST it back. The host
 * checks instance-admin rights and the manifest schema on the POST. Nothing
 * else in the config is read or changed here.
 *
 * The weakening check runs again on the config read right before the POST
 * (RK9-562): a change that weakens the spend protection against what is
 * saved now, and that the operator did not confirm, refuses the save. So a
 * rule added elsewhere after the page loaded is not removed unconfirmed.
 * Live mode on is checked the same way (RK9-566): a session that turned it
 * off after this page loaded is not overridden without the word LIVE.
 *
 * A rule that becomes live while live mode is on needs LIVE too (RK9-563).
 *
 * Version check (RK9-563): the editor reads the saved config's `updatedAt`
 * when it loads (`readConfigVersion`) and passes it here. The GET right
 * before the POST must show the same `updatedAt`; a config saved since, on
 * the host's form or in another tab, refuses the save instead of being
 * overwritten. The host route has no compare-and-swap, so a save between
 * that GET and the POST is still lost. These checks guard against an
 * operator's mistake, not against an instance admin, who can save any
 * schema-valid config on the host's own form.
 */
import { PLUGIN_KEY } from "./keys.js";
import { liveChanges, savedRulesBlock, weakeningChanges } from "./rule-fields.js";

const BASE = `/api/plugins/${PLUGIN_KEY}/config`;

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error.slice(0, 300);
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `HTTP ${response.status}`;
}

interface ConfigRecord {
  configJson: Record<string, unknown> | null;
  updatedAt: string | null;
}

function recordOf(body: unknown): ConfigRecord {
  const record = typeof body === "object" && body !== null ? (body as { configJson?: unknown; updatedAt?: unknown }) : {};
  const configJson = typeof record.configJson === "object" && record.configJson !== null && !Array.isArray(record.configJson)
    ? (record.configJson as Record<string, unknown>)
    : null;
  return { configJson, updatedAt: typeof record.updatedAt === "string" && record.updatedAt !== "" ? record.updatedAt : null };
}

async function readRecord(companyId: string, fetcher: typeof fetch): Promise<ConfigRecord> {
  const current = await fetcher(`${BASE}?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" });
  if (!current.ok) throw new Error(`The saved config could not be read: ${await readError(current)}`);
  return recordOf(await current.json());
}

/** The saved config's `updatedAt`, read when the editor loads; null when there is none or it cannot be read. */
export async function readConfigVersion(companyId: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    return (await readRecord(companyId, fetcher)).updatedAt;
  } catch {
    // The save reads the config again and reports its own error.
    return null;
  }
}

/** Saves the block; returns the saved config's new `updatedAt` (null when the host did not return one). */
export async function saveRulesBlock(
  companyId: string,
  rules: { liveMode: boolean; list?: Array<Record<string, unknown>> },
  fetcher: typeof fetch = fetch,
  /** The weakening changes the operator confirmed with the typed word (rule-fields.ts weakeningChanges). */
  confirmedWeakening: readonly string[] = [],
  /** The operator typed LIVE for this save. */
  confirmedLive = false,
  /** `updatedAt` of the config the editor loaded (readConfigVersion); null skips the version check. */
  expectedUpdatedAt: string | null = null,
): Promise<string | null> {
  const { configJson, updatedAt } = await readRecord(companyId, fetcher);
  if (!configJson || Object.keys(configJson).length === 0) throw new Error("This company has no saved RK9 Ads config to add rules to");
  if (expectedUpdatedAt !== null && updatedAt !== expectedUpdatedAt) {
    throw new Error("The plugin config was saved elsewhere after this page loaded (the host's form or another tab); reload the page and save again");
  }
  const savedNow = savedRulesBlock(configJson);
  // A block without `list` keeps the default rules (features/rules/editor.ts).
  const next = savedRulesBlock({ rules });
  const unconfirmed = weakeningChanges(savedNow, next).filter((change) => !confirmedWeakening.includes(change));
  if (!confirmedLive) unconfirmed.push(...liveChanges(savedNow, next));
  if (unconfirmed.length > 0) {
    throw new Error(`The saved rules changed after this page loaded; reload and confirm again. Unconfirmed: ${unconfirmed.join(" ")}`.slice(0, 600));
  }
  const saved = await fetcher(BASE, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyId, configJson: { ...configJson, rules } }),
  });
  if (!saved.ok) {
    if (saved.status === 403) throw new Error("Only an instance admin can save the plugin config");
    throw new Error(`The rules were not saved: ${await readError(saved)}`);
  }
  try {
    return recordOf(await saved.json()).updatedAt;
  } catch {
    return null;
  }
}
