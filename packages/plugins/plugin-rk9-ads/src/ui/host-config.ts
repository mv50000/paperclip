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
 */
import { PLUGIN_KEY } from "./keys.js";
import { weakeningChanges, type RulesBlock } from "./rule-fields.js";

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

/** The saved config's `rules` block as the weakening check reads it (schema defaults: liveMode false, no rules). */
function savedRules(configJson: Record<string, unknown>): RulesBlock {
  const rules = configJson.rules;
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) return { liveMode: false, list: [] };
  const block = rules as { liveMode?: unknown; list?: unknown };
  const list = Array.isArray(block.list)
    ? block.list.filter((rule): rule is Record<string, unknown> => typeof rule === "object" && rule !== null && !Array.isArray(rule))
    : [];
  return { liveMode: block.liveMode === true, list };
}

export async function saveRulesBlock(
  companyId: string,
  rules: { liveMode: boolean; list: Array<Record<string, unknown>> },
  fetcher: typeof fetch = fetch,
  /** The weakening changes the operator confirmed with the typed word (rule-fields.ts weakeningChanges). */
  confirmedWeakening: readonly string[] = [],
): Promise<void> {
  const current = await fetcher(`${BASE}?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" });
  if (!current.ok) throw new Error(`The saved config could not be read: ${await readError(current)}`);
  const record = (await current.json()) as { configJson?: unknown } | null;
  const configJson = record && typeof record.configJson === "object" && record.configJson !== null && !Array.isArray(record.configJson)
    ? (record.configJson as Record<string, unknown>)
    : null;
  if (!configJson || Object.keys(configJson).length === 0) throw new Error("This company has no saved RK9 Ads config to add rules to");
  const unconfirmed = weakeningChanges(savedRules(configJson), rules).filter((change) => !confirmedWeakening.includes(change));
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
}
