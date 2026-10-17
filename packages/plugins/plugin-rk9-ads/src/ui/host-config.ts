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
 * The host route has no compare-and-swap: a config change saved between the
 * GET and the POST is lost (RK9-563). These checks guard against an
 * operator's mistake, not against an instance admin, who can save any
 * schema-valid config on the host's own form.
 */
import { PLUGIN_KEY } from "./keys.js";
import { liveModeTurnedOn, savedRulesBlock, weakeningChanges } from "./rule-fields.js";

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

export async function saveRulesBlock(
  companyId: string,
  rules: { liveMode: boolean; list: Array<Record<string, unknown>> },
  fetcher: typeof fetch = fetch,
  /** The weakening changes the operator confirmed with the typed word (rule-fields.ts weakeningChanges). */
  confirmedWeakening: readonly string[] = [],
  /** The operator typed LIVE for this save. */
  confirmedLive = false,
): Promise<void> {
  const current = await fetcher(`${BASE}?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" });
  if (!current.ok) throw new Error(`The saved config could not be read: ${await readError(current)}`);
  const record = (await current.json()) as { configJson?: unknown } | null;
  const configJson = record && typeof record.configJson === "object" && record.configJson !== null && !Array.isArray(record.configJson)
    ? (record.configJson as Record<string, unknown>)
    : null;
  if (!configJson || Object.keys(configJson).length === 0) throw new Error("This company has no saved RK9 Ads config to add rules to");
  const savedNow = savedRulesBlock(configJson);
  const unconfirmed = weakeningChanges(savedNow, rules).filter((change) => !confirmedWeakening.includes(change));
  if (liveModeTurnedOn(savedNow, rules) && !confirmedLive) unconfirmed.push("Live-tila päälle.");
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
