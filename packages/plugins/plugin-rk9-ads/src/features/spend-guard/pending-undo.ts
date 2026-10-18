/**
 * Failed undos of an activation that lost the race to a pause (RK9-565).
 *
 * When activate_ad sees a pause's halt during or after its writes, it pauses
 * again what it set ACTIVE. When Meta refuses one of those PAUSED writes
 * (rate limit, 5xx), the object may stay ACTIVE: the kill switch and a
 * scheduled pause already marked done do not run again. So the handler
 * stores the object here and sends one Telegram alert, and the
 * scheduled-pause job (every 5 min) pauses it again on each tick until Meta
 * confirms, whether a halt is still in force or not: a scheduled halt that
 * ends at 06:00, or the cap halt at the month's end, must not leave the
 * object spending.
 *
 * An entry ends only when:
 * - Meta confirms the PAUSED write (one audit row);
 * - no halt is in force and a newer card of the same object or of the
 *   card's publication was approved after the failure and activated: the
 *   operator wants it running, so the retry stops (one audit row, one
 *   alert);
 * - a board user acknowledges it with `clear-halt` (`acknowledgeUndos`, the
 *   entries the preview listed; activity log).
 * Every doubt pauses: a halt or a newer-card lookup that cannot be read
 * pauses the object, which at worst stops an approved ad and never spends.
 * While a newer card's handler still runs (approved, no outcome yet), the
 * tick leaves the entry alone, so it neither pauses what that card is
 * activating nor drops the entry before the card's result is known. A card
 * still marked running after UNDO_IN_FLIGHT_WARN_MINUTES fails the run (its
 * worker may have died); after UNDO_IN_FLIGHT_MINUTES its result counts as
 * unknown and the tick pauses (RK9-567).
 *
 * A newer card can be approved between the tick's lookup and its PAUSED
 * write, and a card whose result is unknown may have activated. So after
 * every confirmed PAUSED write with no halt in force the tick looks for a
 * newer card again; a hit means the retry may have paused what that card
 * set ACTIVE, and one alert per object and card says so (RK9-567). The
 * entry ends all the same: Meta confirmed the pause.
 *
 * A PAUSED write that Meta refuses for good (meta/errors.ts
 * permanentErrorClass: the token, a permission, the object gone) keeps the
 * entry and is still retried on every tick, in case the operator fixes the
 * token, but it fails the run only once and sends one alert; then the entry
 * waits for a board user's acknowledgement without failing the job every 5
 * minutes (RK9-567). A transient error makes it a normal failure again.
 *
 * Alerts use alert_dedupe markers like the spend alerts (alerts.ts):
 * claimed before the send and given back when the send fails. The failed
 * alert of an activation undo has one per gate request
 * (`undo-failed:<brand>:<gateRequestId>`); the drop, overlap and permanent
 * alerts have one per object (`undo-dropped:<brand>:<gateRequestId>:<objectId>`,
 * `undo-overlap:<brand>:<newer card>:<objectId>`,
 * `undo-permanent:<brand>:<gateRequestId>:<objectId>`), so a second object of
 * the same card dropped on a later tick is alerted too (RK9-567). A failed
 * alert of an entry still open goes out on the next tick; a drop or overlap
 * alert is sent once, after the fact, and is not resent. A failed retry
 * writes no audit row (the job run fails instead); an audit row that could
 * not be written fails the run.
 *
 * A pause's own failed PAUSED writes use the same list (RK9-568): when Meta
 * refuses the PAUSED write of an ACTIVE object in a live kill switch,
 * scheduled pause, cap pause or their re-check, pauseAll (killswitch.ts)
 * stores the object with origin "pause" and sends one alert, with one
 * alert_dedupe marker per object (`pause-failed:<brand>:<ref>:<objectId>`).
 * Its `gateRequestId` is no gate request but `<rule>:<halt id>`, the pause
 * that failed. The tick retries it and ends it like an undo: Meta confirms,
 * a newer activation is approved after the halt ended, or a board user
 * acknowledges it. A failure of an object that already has an open entry
 * adds one attempt to that entry, which keeps its identity and so its alert
 * marker. Every entry counts its failed PAUSED writes and keeps the last
 * error (redacted), so the run's failure lines and the alerts tell how often
 * and why Meta refused.
 *
 * Stored in plugin_state (no migration, G11), one key per company. The gate
 * handlers and the job run in one worker process, so a per-company lock
 * there serializes every write of the list. Verified for RK9-567 against the
 * host: it forks one worker per plugin per server process
 * (server/src/services/plugin-worker-manager.ts, workers keyed by plugin id),
 * jobs and gate callbacks go to that worker over the same RPC handle, and a
 * restart stops the old worker (shutdown, SIGTERM, SIGKILL) before it starts
 * the new one. A worker exits when its stdin closes, i.e. when the server
 * dies, and paperclip.service runs with KillMode=control-group, so a server
 * restart kills the old workers too. Two servers on one database would each
 * run a worker and break this lock; Paperclip supports one node per database
 * (doc/plugins/PLUGIN_SPEC.md). The job removes only the
 * entries it handled (undoEntryKey: object, gate request and the merged
 * failure's time), so a newer failure of the same object that arrived
 * during its Meta calls stays, and only a removed entry gets the
 * superseded audit row and alert.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BrandConfig } from "../../config.js";
import type { Ledger } from "../../db.js";
import type { MetaGraphClient } from "../../meta/graph.js";
import { setObjectStatus } from "../../meta/methods.js";
import { permanentErrorClass, type PermanentErrorClass } from "../../meta/errors.js";
import { isDryRun } from "../../meta/types.js";
import type { NewerActivation, NewerActivationQuery } from "../../gate/gate-requests.js";
import { HALT_NAMESPACE, readHalt, type HaltRule } from "./halt.js";
import { brandClient, recordAction, safeError, type Initiator, type OnceStore, type SpendGuardNotifier } from "./support.js";

export const UNDO_FAILED_KIND = "undo_failed";
export const UNDO_DROPPED_KIND = "undo_dropped";
export const PAUSE_FAILED_KIND = "pause_failed";
export const PAUSE_DROPPED_KIND = "pause_dropped";
/** A newer card approved this recently whose handler has not finished is still activating (staging-card.ts ACTIVATION_IN_FLIGHT_MINUTES). */
export const UNDO_IN_FLIGHT_MINUTES = 30;
/** A newer card marked running for this long fails the run while the retry waits for it: its worker may have died (RK9-567). */
export const UNDO_IN_FLIGHT_WARN_MINUTES = 5;

export type UndoObjectKind = "campaign" | "adset" | "ad";
/** "activation": an activation's undo (RK9-565); "pause": a pause's own PAUSED write (RK9-568). */
export type UndoOrigin = "activation" | "pause";

export interface PendingUndo {
  objectId: string;
  kind: UndoObjectKind;
  /** The activation's gate request; for origin "pause", `<rule>:<halt id>` of the pause. */
  gateRequestId: string;
  brandCode: string;
  /** The halt that won the race, or the pause's rule; null when the halt could not be read. */
  haltRule: HaltRule | null;
  /** ISO time the undo first failed. */
  since: string;
  /** The first error. */
  error: string;
  /** Absent in entries stored before RK9-568: an activation undo. */
  origin?: UndoOrigin;
  /** Failed PAUSED writes so far; absent counts as 1. */
  attempts?: number;
  /** The latest failed write's error (safeError). */
  lastError?: string;
  /** ISO time of the latest failed write. */
  lastAttemptAt?: string;
  /**
   * ISO time of the latest pause or undo whose PAUSED write failed on this
   * object; a retry is not. Only a newer activation approved after it ends
   * the entry. Absent: `since`.
   */
  failedAt?: string;
  /** Set while the latest retry failed for good (meta/errors.ts permanentErrorClass, RK9-567). */
  permanentError?: PermanentErrorClass;
  /** ISO time of the first retry of the current run of permanent failures. */
  permanentSince?: string;
}

export function undoOrigin(entry: Pick<PendingUndo, "origin">): UndoOrigin {
  return entry.origin === "pause" ? "pause" : "activation";
}

export function undoAttempts(entry: Pick<PendingUndo, "attempts">): number {
  return typeof entry.attempts === "number" && Number.isFinite(entry.attempts) && entry.attempts >= 1 ? Math.trunc(entry.attempts) : 1;
}

function lastErrorOf(entry: Pick<PendingUndo, "error" | "lastError">): string {
  return typeof entry.lastError === "string" ? entry.lastError : entry.error;
}

type StateCtx = Pick<PluginContext, "state">;

function undoKey(companyId: string) {
  return { scopeKind: "instance" as const, namespace: HALT_NAMESPACE, stateKey: `pending-undo:${companyId}` };
}

/**
 * An entry's identity for removal and acknowledgement. A merged pause
 * failure sets `failedAt`, which changes the key: a tick or a board
 * acknowledgement that read the entry before that failure no longer names
 * it, so the newer failure stays (RK9-568 verifier).
 */
export function undoEntryKey(entry: Pick<PendingUndo, "objectId" | "gateRequestId" | "failedAt">): string {
  return `${entry.objectId}|${entry.gateRequestId}${typeof entry.failedAt === "string" ? `|${entry.failedAt}` : ""}`;
}

/**
 * "failed": the first failure; "dropped": a newer activation ended the retry;
 * "overlap": the retry may have paused a newer activation; "permanent": Meta
 * refuses the PAUSED write for good (RK9-567).
 */
export type UndoAlertKind = "failed" | "dropped" | "overlap" | "permanent";

/** An activation undo's marker: one per gate request for "failed", one per object for the rest (RK9-567). */
export function undoAlertKey(kind: UndoAlertKind, brandCode: string, gateRequestId: string, objectId?: string): string {
  return `undo-${kind}:${brandCode}:${gateRequestId}${kind !== "failed" && objectId !== undefined ? `:${objectId}` : ""}`;
}

/** A pause failure's marker: one per object (RK9-568). */
export function pauseAlertKey(kind: UndoAlertKind, brandCode: string, ref: string, objectId: string): string {
  return `pause-${kind}:${brandCode}:${ref}:${objectId}`;
}

function isPendingUndo(value: unknown): value is PendingUndo {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<PendingUndo>;
  return typeof entry.objectId === "string" && typeof entry.gateRequestId === "string" && typeof entry.kind === "string";
}

/** The company's open undos. Throws when the state cannot be read or the record is damaged. */
export async function readPendingUndos(ctx: StateCtx, companyId: string): Promise<PendingUndo[]> {
  const value = await ctx.state.get(undoKey(companyId));
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPendingUndo)) throw new Error("the pending undo record is damaged");
  return value;
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier write of the company's list has finished. */
async function withLock<T>(companyId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(companyId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  locks.set(companyId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(companyId) === tail) locks.delete(companyId);
  }
}

/** Adds (or replaces, by object id) open undos. */
export async function addPendingUndos(ctx: StateCtx, companyId: string, entries: readonly PendingUndo[]): Promise<void> {
  await withLock(companyId, async () => {
    const ids = new Set(entries.map((entry) => entry.objectId));
    const current = (await readPendingUndos(ctx, companyId)).filter((entry) => !ids.has(entry.objectId));
    await ctx.state.set(undoKey(companyId), [...current, ...entries]);
  });
}

/**
 * A pause's failed PAUSED writes (RK9-568): a new entry per object, or one
 * more attempt on the object's open entry, which keeps its identity (and so
 * its alert marker) and its first error. Returns each object's entry as
 * stored.
 */
async function addPauseFailures(ctx: StateCtx, companyId: string, entries: readonly PendingUndo[]): Promise<PendingUndo[]> {
  return withLock(companyId, async () => {
    const next = [...(await readPendingUndos(ctx, companyId))];
    const out: PendingUndo[] = [];
    for (const entry of entries) {
      const index = next.findIndex((open) => open.objectId === entry.objectId);
      if (index === -1) {
        next.push(entry);
        out.push(entry);
        continue;
      }
      const open = next[index]!;
      const merged: PendingUndo = {
        ...open,
        attempts: undoAttempts(open) + 1,
        lastError: entry.error,
        lastAttemptAt: entry.since,
        failedAt: entry.since,
      };
      next[index] = merged;
      out.push(merged);
    }
    await ctx.state.set(undoKey(companyId), next);
    return out;
  });
}

interface RetryFailure {
  entry: PendingUndo;
  error: string;
  permanent: PermanentErrorClass | null;
}

/** One more failed attempt on each entry still open (by object and gate request), and whether it failed for good. */
async function noteRetryFailures(ctx: StateCtx, companyId: string, failed: readonly RetryFailure[], now: Date): Promise<void> {
  if (failed.length === 0) return;
  await withLock(companyId, async () => {
    const byKey = new Map(failed.map((item) => [undoEntryKey(item.entry), item]));
    let changed = false;
    const next = (await readPendingUndos(ctx, companyId)).map((open): PendingUndo => {
      const item = byKey.get(undoEntryKey(open));
      if (item === undefined) return open;
      changed = true;
      const { permanentError: _class, permanentSince, ...rest } = open;
      return {
        ...rest,
        attempts: undoAttempts(open) + 1,
        lastError: item.error,
        lastAttemptAt: now.toISOString(),
        ...(item.permanent ? { permanentError: item.permanent, permanentSince: permanentSince ?? now.toISOString() } : {}),
      };
    });
    if (changed) await ctx.state.set(undoKey(companyId), next);
  });
}

/**
 * Removes the entries with these keys and returns those it removed. A newer
 * failure of the same object that replaced one (another gate request) or
 * was merged into it (a new `failedAt`) has another key and stays.
 */
async function removePendingUndos(ctx: StateCtx, companyId: string, keys: readonly string[]): Promise<PendingUndo[]> {
  if (keys.length === 0) return [];
  return withLock(companyId, async () => {
    const ids = new Set(keys);
    const current = await readPendingUndos(ctx, companyId);
    const removed = current.filter((entry) => ids.has(undoEntryKey(entry)));
    if (removed.length === 0) return [];
    const rest = current.filter((entry) => !ids.has(undoEntryKey(entry)));
    if (rest.length === 0) await ctx.state.delete(undoKey(companyId));
    else await ctx.state.set(undoKey(companyId), rest);
    return removed;
  });
}

/**
 * A board user's acknowledgement (clear-halt): removes the entries named by
 * `keys` (undoEntryKey of the entries the preview listed) and returns them.
 * An entry added after the preview is not named and stays.
 */
export async function acknowledgePendingUndos(ctx: StateCtx, companyId: string, keys: readonly string[]): Promise<PendingUndo[]> {
  return removePendingUndos(ctx, companyId, keys);
}

const KIND_TEXT: Record<UndoObjectKind, string> = { campaign: "kampanja", adset: "ad set", ad: "mainos" };
const RULE_TEXT: Record<HaltRule, string> = { kill_switch: "hätäkatkaisin", scheduled_pause: "ajastettu pysäytys", pause_all_cap: "kulutuskatto 90 %" };

function objectList(entries: readonly Pick<PendingUndo, "kind" | "objectId">[]): string {
  return entries.map((entry) => `${KIND_TEXT[entry.kind] ?? entry.kind} ${entry.objectId}`).join(", ");
}

type AlertEntry = Pick<PendingUndo, "kind" | "objectId"> &
  Partial<Pick<PendingUndo, "gateRequestId" | "origin" | "haltRule" | "attempts" | "error" | "lastError" | "permanentError">>;

const PERMANENT_TEXT: Record<PermanentErrorClass, string> = {
  token_invalid: "Metan access token on vanhentunut tai peruttu",
  token_unresolved: "Metan access tokenia ei voitu lukea",
  permission: "tokenilla ei ole oikeutta kohteeseen (tili tai oikeudet vaihtuneet)",
  object_missing: "kohdetta ei ole enää Metassa",
  write_refused: "Meta-asiakas esti kirjoituksen",
};

/** The newer card an overlap alert names (RK9-567). */
type OverlapCard = Pick<NewerActivation, "id" | "unknown">;

function errorLine(entry: AlertEntry): string {
  const error = entry.lastError ?? entry.error;
  return `• ${KIND_TEXT[entry.kind] ?? entry.kind} ${entry.objectId}: PAUSED epäonnistui ${undoAttempts(entry)} kertaa${error ? `, viimeisin virhe: ${error.slice(0, 200)}` : ""}`;
}

/** The overlap and permanent alerts (RK9-567), the same for both origins. */
function retryAlertText(name: string, kind: "overlap" | "permanent", entries: readonly AlertEntry[], newer?: OverlapCard): string[] {
  if (kind === "overlap") {
    return [
      newer?.unknown
        ? `⚠️ ${name}: uudelleenyritys pysäytti kohteen, vaikka uudempi kortti ${newer.id} hyväksyttiin; kortin tulosta ei tallennettu, joten aktivointi on voinut onnistua`
        : `⚠️ ${name}: uudelleenyritys pysäytti kohteen, jonka uudempi kortti ${newer?.id ?? "?"} hyväksyttiin sen aikana`,
      `Nyt PAUSED: ${objectList(entries)}. Kortti voi näyttää "aktivoitu", vaikka kohde on pysäytetty.`,
      "Jos mainoksen pitää olla käynnissä, lähetä uusi kortti ja hyväksy se. Tarkista tila Metassa.",
    ];
  }
  const reason = entries[0]?.permanentError;
  return [
    `⚠️ ${name}: Meta hylkää pysäytyksen pysyvästi${reason ? ` (${PERMANENT_TEXT[reason] ?? reason})` : ""}`,
    `Voi olla yhä ACTIVE: ${objectList(entries)}`,
    ...entries.map(errorLine),
    "Uudelleenyritys jatkuu 5 minuutin välein ilman uusia hälytyksiä, mutta onnistuu vasta korjauksen jälkeen. Pysäytä kohde käsin Metassa tai korjaa token ja oikeudet, ja kuittaa merkintä boardissa.",
  ];
}

/** A pause failure's alert (RK9-568): the objects, how often Meta refused and its last error. */
function pauseAlertText(name: string, kind: "failed" | "dropped", entries: readonly AlertEntry[], stored: boolean): string[] {
  if (kind === "dropped") {
    return [
      `ℹ️ ${name}: pysäytyksen uudelleenyritys lopetettiin, koska pysäytystilan päätyttyä uudempi aktivointi hyväksyttiin`,
      `Ei enää pysäytetä: ${objectList(entries)}. Tarkista tila Metassa.`,
    ];
  }
  const rule = entries[0]?.haltRule;
  return [
    `⚠️ ${name}: pysäytys epäonnistui pysäytystilan aikana${rule ? ` (${RULE_TEXT[rule] ?? rule})` : ""}`,
    `Voi olla yhä ACTIVE: ${objectList(entries)}`,
    ...entries.map(errorLine),
    stored
      ? "Pysäytystä yritetään uudelleen 5 minuutin välein, kunnes Meta vahvistaa sen, board kuittaa sen tai pysäytystilan päätyttyä uudempi aktivointi hyväksytään. Tarkista tila Metassa."
      : "Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.",
  ];
}

export function undoAlertText(config: BrandConfig, kind: UndoAlertKind, entries: readonly AlertEntry[], stored = true, newer?: OverlapCard): string {
  const name = config.displayName || config.brandCode;
  if (kind === "overlap" || kind === "permanent") return retryAlertText(name, kind, entries, newer).join("\n").slice(0, 3900);
  if (entries[0] && undoOrigin(entries[0]) === "pause") return pauseAlertText(name, kind, entries, stored).join("\n").slice(0, 3900);
  const lines =
    kind === "failed"
      ? [
          `⚠️ ${name}: aktivoinnin peruutus epäonnistui pysäytyksen aikana`,
          `Voi olla yhä ACTIVE-tilassa: ${objectList(entries)}`,
          stored
            ? "Peruutusta yritetään uudelleen 5 minuutin välein, kunnes Meta vahvistaa pysäytyksen, uudempi aktivointi hyväksytään tai board kuittaa sen. Tarkista tila Metassa."
            : "Uudelleenyritystä ei voitu tallentaa: pysäytä nämä käsin Metassa.",
        ]
      : [
          `ℹ️ ${name}: aktivoinnin peruutuksen uudelleenyritys lopetettiin, koska uudempi aktivointi hyväksyttiin`,
          `Ei enää pysäytetä: ${objectList(entries)}. Tarkista tila Metassa.`,
        ];
  return lines.join("\n").slice(0, 3900);
}

interface AlertDeps {
  store: OnceStore;
  notifier: SpendGuardNotifier;
}

/**
 * The first failure's alert: one per gate request for an activation undo,
 * one per object for a pause failure (RK9-568). Every other alert: one per
 * object (RK9-567). `gateRequestId` names the entries' gate request or
 * pause, or for "overlap" the newer card. The message lists the objects
 * whose marker this call claimed. A failed send gives the markers back.
 */
async function sendUndoAlert(
  deps: AlertDeps,
  companyId: string,
  config: BrandConfig,
  kind: UndoAlertKind,
  gateRequestId: string,
  entries: readonly AlertEntry[],
  stored = true,
  newer?: OverlapCard,
): Promise<{ telegram: "sent" | "not_configured" | "skipped" | "failed"; error?: string }> {
  // Without Telegram there is no marker, so the alert goes out once Telegram is set up.
  if (!config.telegram) return { telegram: "not_configured" };
  if (entries.length === 0) return { telegram: "skipped" };
  const pause = undoOrigin(entries[0]!) === "pause";
  const perObject = pause || kind !== "failed";
  const markers: Array<{ key: string; entries: readonly AlertEntry[]; objectId?: string }> = perObject
    ? entries.map((entry) => ({
        key: pause ? pauseAlertKey(kind, config.brandCode, gateRequestId, entry.objectId) : undoAlertKey(kind, config.brandCode, gateRequestId, entry.objectId),
        entries: [entry],
        objectId: entry.objectId,
      }))
    : [{ key: undoAlertKey(kind, config.brandCode, gateRequestId), entries }];
  const markerKind = `${pause ? "pause" : "undo"}_${kind}`;
  const claimed: typeof markers = [];
  const release = async () => {
    for (const marker of claimed) await deps.store.release(companyId, marker.key).catch(() => undefined);
  };
  try {
    for (const marker of markers) {
      if (await deps.store.claim(companyId, marker.key, markerKind, { gateRequestId, ...(marker.objectId ? { objectId: marker.objectId } : {}) })) claimed.push(marker);
    }
  } catch (error) {
    await release();
    return { telegram: "failed", error: `alert marker not claimed (${safeError(error)})` };
  }
  if (claimed.length === 0) return { telegram: "skipped" };
  try {
    return { telegram: await deps.notifier.sendMessage(companyId, config, undoAlertText(config, kind, claimed.flatMap((marker) => marker.entries), stored, newer)) };
  } catch (error) {
    await release();
    return { telegram: "failed", error: safeError(error) };
  }
}

export interface UndoFailure {
  kind: UndoObjectKind;
  objectId: string;
  error: string;
}

export interface UndoReport {
  /** The objects are stored for the retry. */
  stored: boolean;
  telegram: "sent" | "not_configured" | "skipped" | "failed";
  /** What failed: the store, the alert, or both. */
  error?: string;
}

/** activate_ad: an undo PAUSED write failed. Stores the objects for the retry and sends the alert. Never throws. */
export async function reportUndoFailure(
  deps: AlertDeps & { ctx: StateCtx },
  companyId: string,
  config: BrandConfig,
  input: { gateRequestId: string; haltRule: HaltRule | null; failed: readonly UndoFailure[] },
  now: Date,
): Promise<UndoReport> {
  const errors: string[] = [];
  let stored = false;
  try {
    await addPendingUndos(
      deps.ctx,
      companyId,
      input.failed.map((entry) => ({
        ...entry,
        gateRequestId: input.gateRequestId,
        brandCode: config.brandCode,
        haltRule: input.haltRule,
        since: now.toISOString(),
      })),
    );
    stored = true;
  } catch (error) {
    errors.push(`not stored for the retry (${safeError(error)})`);
  }
  const alert = await sendUndoAlert(deps, companyId, config, "failed", input.gateRequestId, input.failed, stored);
  if (alert.error) errors.push(`alert: ${alert.error}`);
  return { stored, telegram: alert.telegram, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

/** The Telegram outcome of several alerts: a failure first, then a sent one. */
function worstTelegram(outcomes: readonly UndoReport["telegram"][]): UndoReport["telegram"] {
  for (const telegram of ["failed", "sent", "not_configured"] as const) if (outcomes.includes(telegram)) return telegram;
  return "skipped";
}

/**
 * pauseAll: a live kill switch, scheduled pause, cap pause or re-check could
 * not pause these ACTIVE objects (RK9-568). Stores them for the retry and
 * sends the alert of the objects not alerted yet. `ref` names the pause
 * (`<rule>:<halt id>`). Without a marker store the alert waits for the
 * scheduled-pause job's next tick, which alerts every entry that still
 * fails. Never throws.
 */
export async function reportPauseFailure(
  deps: Omit<AlertDeps, "store"> & { ctx: StateCtx; store?: OnceStore },
  companyId: string,
  config: BrandConfig,
  input: { rule: HaltRule; ref: string; failed: readonly UndoFailure[] },
  now: Date,
): Promise<UndoReport> {
  const fresh: PendingUndo[] = input.failed.map((entry) => ({
    ...entry,
    origin: "pause",
    gateRequestId: input.ref,
    brandCode: config.brandCode,
    haltRule: input.rule,
    since: now.toISOString(),
    attempts: 1,
    lastError: entry.error,
    lastAttemptAt: now.toISOString(),
  }));
  const errors: string[] = [];
  let entries = fresh;
  let stored = false;
  try {
    entries = await addPauseFailures(deps.ctx, companyId, fresh);
    stored = true;
  } catch (error) {
    errors.push(`not stored for the retry (${safeError(error)})`);
  }
  const { store } = deps;
  if (!store) return { stored, telegram: "skipped", ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
  const outcomes: UndoReport["telegram"][] = [];
  for (const [gateRequestId, group] of byRequest(entries)) {
    const alert = await sendUndoAlert({ store, notifier: deps.notifier }, companyId, config, "failed", gateRequestId, group, stored);
    outcomes.push(alert.telegram);
    if (alert.error) errors.push(`alert: ${alert.error}`);
  }
  return { stored, telegram: worstTelegram(outcomes), ...(errors.length > 0 ? { error: errors.join("; ") } : {}) };
}

export interface UndoRetryDeps extends AlertDeps {
  ctx: PluginContext;
  ledger: Ledger;
  clientFor?: (companyId: string, config: BrandConfig, mode: "live" | "dryRun", initiator: Initiator) => MetaGraphClient;
  /** The newer card that ends or delays an entry's retry once no halt is in force (gate-requests.ts newerActivation); none when not wired. */
  newerActivation?: (companyId: string, input: NewerActivationQuery) => Promise<NewerActivation | null>;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

function byRequest<T extends PendingUndo>(entries: readonly T[]): Map<string, T[]> {
  return groupBy(entries, (entry) => entry.gateRequestId);
}

/**
 * The scheduled-pause job's tick: ends each open undo or pause failure that
 * a newer activation superseded and pauses every other one again. Returns
 * the failure lines of the run; throws only when the record cannot be read.
 */
export async function retryPendingUndos(
  deps: UndoRetryDeps,
  companyId: string,
  config: BrandConfig,
  initiator: Initiator,
  now: Date,
): Promise<string[]> {
  const entries = await readPendingUndos(deps.ctx, companyId);
  if (entries.length === 0) return [];
  const brand = config.brandCode;
  const failures: string[] = [];
  const label = (entry: PendingUndo) => (undoOrigin(entry) === "pause" ? `${entry.haltRule ?? "pause"} pause retry` : "activation undo");
  const audit = async (entry: PendingUndo, applied: boolean, reason: string, error: string | null, message: string, extra: Record<string, unknown> = {}) => {
    const insertError = await recordAction(deps, {
      companyId,
      config,
      ruleId: `${undoOrigin(entry) === "pause" ? "retry" : "undo"}-${entry.gateRequestId}`,
      // rule_type is a CHECK list (migration 001) without an "unknown" value, and G11 allows no
      // migration: a halt that could not be read files as kill_switch, and metrics.haltRule is null.
      ruleType: entry.haltRule ?? "kill_switch",
      objectType: entry.kind,
      objectId: entry.objectId,
      action: "pause",
      dryRun: false,
      applied,
      reason,
      metrics: {
        gateRequestId: entry.gateRequestId,
        origin: undoOrigin(entry),
        haltRule: entry.haltRule,
        failedSince: entry.since,
        firstError: entry.error,
        failedAttempts: undoAttempts(entry),
        lastError: lastErrorOf(entry),
        ...extra,
      },
      initiator,
      error,
      message,
    });
    if (insertError) failures.push(`${brand} ${label(entry)}: the audit row of ${entry.kind} ${entry.objectId} was not written (${insertError})`);
  };

  const client = deps.clientFor ? deps.clientFor(companyId, config, "live", initiator) : brandClient(deps, companyId, config, "live", { initiator });
  const done: PendingUndo[] = [];
  const superseded: Array<{ entry: PendingUndo; by: string }> = [];
  const overlaps: Array<{ entry: PendingUndo; newer: NewerActivation }> = [];
  const stillFailing: RetryFailure[] = [];
  // A newer activation ends the retry only when no halt is in force; a halt that cannot be read counts as one.
  let haltInForce = true;
  try {
    haltInForce = (await readHalt(deps.ctx, companyId, now)) !== null;
  } catch (error) {
    failures.push(`${brand} pause retry: halt not read (${safeError(error)}), pausing anyway`);
  }
  for (const entry of entries) {
    let newer: NewerActivation | null = null;
    // Only an activation approved after the latest failed pause or undo of the object ends it (RK9-568).
    const since = new Date(entry.failedAt ?? entry.since);
    const query: NewerActivationQuery = { objectId: entry.objectId, objectKind: entry.kind, gateRequestId: entry.gateRequestId, since, inFlightMinutes: UNDO_IN_FLIGHT_MINUTES };
    const lookup = !haltInForce && deps.newerActivation !== undefined && Number.isFinite(since.getTime()) ? deps.newerActivation : null;
    if (lookup) {
      try {
        newer = await lookup(companyId, query);
      } catch (error) {
        failures.push(`${brand} ${label(entry)}: newer activations of ${entry.kind} ${entry.objectId} not read (${safeError(error)}), pausing anyway`);
      }
    }
    if (newer?.inFlight) {
      // Its result decides: activated ends this retry, failed leaves it for the next tick.
      if (newer.ageMinutes >= UNDO_IN_FLIGHT_WARN_MINUTES) {
        // A handler takes seconds: one still marked running this long may have died with its worker (RK9-567).
        deps.ctx.logger.warn("rk9-ads pause retry: a newer card is marked running for long; its worker may have died", { companyId, objectId: entry.objectId, gateRequestId: newer.id, ageMinutes: newer.ageMinutes });
        failures.push(
          `${brand} ${label(entry)}: newer card ${newer.id} of ${entry.kind} ${entry.objectId} was approved ${newer.ageMinutes} min ago and has recorded no end (its worker may have died); the retry waits for it up to ${UNDO_IN_FLIGHT_MINUTES} min, then pauses`,
        );
      } else {
        deps.ctx.logger.info("rk9-ads pause retry: a newer card is still activating; retry left for the next tick", { companyId, objectId: entry.objectId, gateRequestId: newer.id });
      }
      continue;
    }
    // A card whose result is unknown may or may not have activated: the doubt pauses (RK9-567).
    if (newer && !newer.unknown) {
      superseded.push({ entry, by: newer.id });
      continue;
    }
    let paused = false;
    try {
      const result = await setObjectStatus(client, entry.objectId, "PAUSED");
      if (isDryRun(result) || !result.success) throw new Error(`Meta did not confirm status PAUSED on ${entry.objectId}`);
      paused = true;
    } catch (error) {
      const detail = safeError(error);
      const permanent = permanentErrorClass(error);
      stillFailing.push({ entry, error: detail, permanent });
      // Without Telegram the run's failure is the only signal: it stays loud.
      if (permanent && entry.permanentError && config.telegram) {
        // Alerted and reported already: the entry waits for a board user without failing every run (RK9-567).
        deps.ctx.logger.info("rk9-ads pause retry: Meta still refuses the PAUSED write for good", { companyId, objectId: entry.objectId, class: permanent });
        continue;
      }
      failures.push(
        permanent
          ? `${brand} ${label(entry)}: Meta refuses pausing ${entry.kind} ${entry.objectId} for good (${permanent}: ${detail}); one alert, then it is retried quietly until Meta confirms or a board user acknowledges it`
          : `${brand} ${label(entry)}: pausing ${entry.kind} ${entry.objectId} failed again (${undoAttempts(entry) + 1} failed PAUSED writes since ${entry.since}, last error: ${detail}), retrying next tick`,
      );
    }
    if (!paused) continue;
    done.push(entry);
    // A newer card approved after the lookup, or one whose result is unknown, may have just been paused (RK9-567).
    let after: NewerActivation | null = newer;
    if (lookup) {
      try {
        after = (await lookup(companyId, query)) ?? newer;
      } catch (error) {
        failures.push(`${brand} ${label(entry)}: newer activations of ${entry.kind} ${entry.objectId} not read again after the pause (${safeError(error)}); check in Meta that no approved ad was stopped`);
      }
    }
    if (after) {
      overlaps.push({ entry, newer: after });
      deps.ctx.logger.warn("rk9-ads pause retry: the retry may have paused a newer activation", { companyId, objectId: entry.objectId, gateRequestId: after.id, unknown: after.unknown === true });
    }
    await audit(
      entry,
      true,
      `${undoOrigin(entry) === "pause" ? "pause" : "activation undo"} retried after a failed pause`,
      null,
      `${label(entry)} paused ${entry.kind} ${entry.objectId} on retry`,
      after ? { newerActivation: after.id, newerActivationResult: after.unknown ? "unknown" : after.inFlight ? "running" : "activated" } : {},
    );
  }
  const removed = new Set((await removePendingUndos(deps.ctx, companyId, [...done, ...superseded.map((item) => item.entry)].map(undoEntryKey))).map(undoEntryKey));
  // Only what this tick removed ended: a pause that failed on the object meanwhile changed its key, and its retry goes on.
  const ended = superseded.filter((item) => removed.has(undoEntryKey(item.entry)));
  for (const { entry, by } of ended) {
    await audit(entry, false, "a newer activation was approved after the failed pause", null, `${label(entry)} of ${entry.kind} ${entry.objectId} ended: superseded by ${by}`, { supersededBy: by });
  }
  try {
    await noteRetryFailures(deps.ctx, companyId, stillFailing, now);
  } catch (error) {
    failures.push(`${brand} pause retry: failed attempts not counted (${safeError(error)})`);
  }
  const alert = async (kind: UndoAlertKind, gateRequestId: string, group: readonly PendingUndo[], newerCard?: OverlapCard) => {
    const outcome = await sendUndoAlert(deps, companyId, config, kind, gateRequestId, group, true, newerCard);
    if (outcome.error) failures.push(`${brand} ${label(group[0]!)}: ${kind} alert failed (${outcome.error})`);
  };
  for (const [gateRequestId, group] of byRequest(ended.map((item) => item.entry))) await alert("dropped", gateRequestId, group);
  for (const [, group] of groupBy(overlaps, (item) => `${undoOrigin(item.entry)}|${item.newer.id}`)) {
    await alert("overlap", group[0]!.newer.id, group.map((item) => item.entry), group[0]!.newer);
  }
  // The first alert may not have gone out: the marker makes this a no-op once it has.
  const failing = stillFailing.map(({ entry, error, permanent }) => ({ ...entry, attempts: undoAttempts(entry) + 1, lastError: error, permanent }));
  for (const [gateRequestId, group] of byRequest(failing.filter((entry) => !entry.permanent))) await alert("failed", gateRequestId, group);
  for (const [gateRequestId, group] of byRequest(failing.filter((entry) => entry.permanent))) {
    await alert("permanent", gateRequestId, group.map((entry) => ({ ...entry, permanentError: entry.permanent! })));
  }
  return failures;
}
