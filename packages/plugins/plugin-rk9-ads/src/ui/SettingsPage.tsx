import { useEffect, useState } from "react";
import { DataTable, KeyValueList, Spinner, StatusBadge, useHostNavigation, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import type { PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import type { PreflightResult } from "../brand/preflight.js";
import type { ProvisionResult } from "../brand/provision.js";
import type { UiSettings } from "../features/ui/dto.js";
import { Button, EmptyState, ErrorText, Muted, Section, TypedConfirm } from "./components.js";
import { errorText, fmtDateTime, fmtEur } from "./format.js";
import { readConfigVersion, saveRulesBlock } from "./host-config.js";
import { ACTION, DATA, HOST_CONFIG_PATH } from "./keys.js";
import {
  BUILTIN_CAP_RULE_ID,
  EDITOR_AGGREGATES,
  EDITOR_METRICS,
  EDITOR_MODES,
  EDITOR_OPERATORS,
  EDITOR_RULE_TYPES,
  fromEditor,
  newRule,
  NUMBER_FIELDS,
  RULE_TYPE_LABEL,
  toEditor,
  type EditorRule,
} from "./rule-fields.js";

export const PROVISION_WORD = "PROVISOI";
export const LIVE_WORD = "LIVE";
/** The typed word for a save that weakens the automatic spend protection (RK9-562). */
export const WEAKEN_WORD = "HEIKENNÄ";

interface PreflightStatus {
  state: string;
  error?: string;
  fresh?: boolean;
  result?: PreflightResult | null;
}

interface RulesData {
  state: string;
  liveMode?: boolean;
  rules?: Array<Record<string, unknown>>;
}

interface PreparedRules {
  ok: boolean;
  errors?: string[];
  /** `list` is left out when the save keeps the default rules (features/rules/editor.ts). */
  rules?: { liveMode: boolean; list?: Array<Record<string, unknown>> };
  /** What the save must confirm, against the config saved now (RK9-566); `live` lists what starts pausing ads (RK9-563). */
  confirm?: { weakening: string[]; liveOn: boolean; live?: string[] };
}

/**
 * A save that waits for the typed words: HEIKENNÄ for the weakening changes,
 * then LIVE when it also turns live mode on (RK9-566).
 */
interface PendingSave {
  list: Array<Record<string, unknown>>;
  liveMode: boolean;
  /** Weakening changes the word confirms; empty for a plain shadow -> live switch. */
  weakening: string[];
  liveOn: boolean;
  /** What the word LIVE confirms: live mode on, or a rule becoming live (RK9-563). */
  live: string[];
  words: string[];
  /** The index of the word asked now. */
  step: number;
}

function pendingFor(list: PendingSave["list"], liveMode: boolean, confirm: NonNullable<PreparedRules["confirm"]>): PendingSave {
  const words = [...(confirm.weakening.length > 0 ? [WEAKEN_WORD] : []), ...(confirm.liveOn ? [LIVE_WORD] : [])];
  return { list, liveMode, weakening: confirm.weakening, liveOn: confirm.liveOn, live: confirm.live ?? [], words, step: 0 };
}

const LIVE_PROMPT = "Live-tilassa säännöt pysäyttävät mainoksia Metassa ilman erillistä hyväksyntää.";

interface DryRunResult {
  error?: string;
  liveMode?: boolean;
  decisions?: Array<{ ruleId: string; action: string; objectType: string; objectId: string; mode: string; reason: string }>;
  warnings?: string[];
}

const CHECK_STATUS = { pass: "ok", fail: "error", skipped: "pending" } as const;

function ConfigSummary(props: { settings: UiSettings }) {
  const { settings } = props;
  const navigation = useHostNavigation();
  const pairs = [
    { label: "Brändi", value: settings.brand ? `${settings.brand.displayName} (${settings.brand.brandCode})` : "–" },
    { label: "Kuukausikatto", value: settings.brand?.monthlyCapEur ? fmtEur(settings.brand.monthlyCapEur) : "ei asetettu: brändi pois päältä" },
    { label: "Aikavyöhyke", value: settings.brand?.timeZone ?? "–" },
    { label: "Mainostili", value: settings.meta ? `act_${settings.meta.adAccountId}` : "–" },
    { label: "Sivu", value: settings.meta?.pageId ?? "–" },
    { label: "Kampanja / mainosjoukko", value: settings.meta ? `${settings.meta.campaignId ?? "–"} / ${settings.meta.adSetId ?? "–"}` : "–" },
    { label: "Meta-token", value: settings.meta?.accessTokenConfigured ? "asetettu (secret)" : "puuttuu" },
    {
      label: "Telegram",
      value: settings.telegram?.configured
        ? `${settings.telegram.mode}, chat ${settings.telegram.chatId}, ${settings.telegram.approverCount} hyväksyjää`
        : "ei käytössä",
    },
    { label: "Laskeutumissivut", value: settings.landing ? settings.landing.urlKeys.join(", ") : "–" },
    {
      label: "Ajastettu pysäytys",
      value: settings.schedule ? (settings.schedule.scheduledPauseEnabled ? `klo ${settings.schedule.scheduledPauseAt}` : "pois") : "–",
    },
    { label: "Digest", value: settings.digest ? (settings.digest.enabled ? `klo ${settings.digest.time}` : "pois") : "–" },
  ];
  return (
    <Section
      title="Asetukset"
      actions={
        <a className="text-sm font-medium underline underline-offset-4" {...navigation.linkProps(HOST_CONFIG_PATH)}>
          Muokkaa asetuslomakkeella
        </a>
      }
    >
      {settings.reason ? <Muted>{settings.reason}</Muted> : null}
      <KeyValueList pairs={pairs} />
    </Section>
  );
}

function PreflightSection(props: { companyId: string | null }) {
  const status = usePluginData<PreflightStatus>(DATA.preflight, { companyId: props.companyId });
  const verify = usePluginAction(ACTION.verifyConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rerun() {
    setBusy(true);
    setError(null);
    try {
      await verify({});
      status.refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const result = status.data?.result ?? null;
  return (
    <Section
      title="Preflight"
      actions={
        <Button onClick={rerun} disabled={busy}>
          {busy ? "Ajetaan…" : "Aja preflight uudelleen"}
        </Button>
      }
    >
      {status.error ? <ErrorText>Preflightin tilaa ei voitu lukea: {status.error.message}</ErrorText> : null}
      {error ? <ErrorText>Preflight epäonnistui: {error}</ErrorText> : null}
      {result ? (
        <>
          <Muted>
            {result.launchReady ? "Julkaisuvalmis." : "Ei julkaisuvalmis."} Tarkistettu {fmtDateTime(result.checkedAt)}
            {status.data?.fresh ? "." : " (vanhentunut, aja uudelleen)."}
          </Muted>
          <DataTable
            columns={[
              { key: "check", header: "Tarkistus" },
              {
                key: "status",
                header: "Tulos",
                render: (value) => <StatusBadge label={String(value)} status={CHECK_STATUS[value as keyof typeof CHECK_STATUS] ?? "info"} />,
              },
              { key: "required", header: "Pakollinen", render: (value) => (value ? "kyllä" : "ei") },
              { key: "detail", header: "Tieto" },
            ]}
            rows={result.checks.map((check) => ({ ...check, id: check.check }))}
          />
        </>
      ) : status.loading ? (
        <Spinner label="Ladataan preflightia" />
      ) : (
        <Muted>Preflightia ei ole ajettu.</Muted>
      )}
    </Section>
  );
}

function ProvisionSection(props: { onDone: () => void }) {
  const provision = usePluginAction(ACTION.provision);
  const toast = usePluginToast();
  const [preview, setPreview] = useState<ProvisionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setPreview((await provision({ dryRun: true })) as ProvisionResult);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = (await provision({ dryRun: false, confirm: true })) as ProvisionResult;
      setPreview(null);
      toast({ title: `Provisioitu: kampanja ${result.campaign.id ?? "–"}, mainosjoukko ${result.adSet.id ?? "–"} (PAUSED)`, tone: "success" });
      props.onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Provisiointi">
      <Muted>Luo brändille PAUSED-tilaisen kampanjan ja mainosjoukon, jos niitä ei ole. Esikatselu ei kirjoita Metaan.</Muted>
      {preview ? (
        <>
          <Muted>
            Esikatselu: {preview.creates} uutta objektia, päiväbudjetti {fmtEur(preview.dailyBudgetCents / 100)}.
            {preview.adSetBudgetAboveCap ? " Mainosjoukon budjetti on yli katon; provisiointi ei muuta sitä." : ""}
          </Muted>
          {preview.creates > 0 ? (
            <TypedConfirm
              word={PROVISION_WORD}
              prompt={`Luodaan ${preview.creates} objektia Metaan PAUSED-tilaan.`}
              confirmLabel="Provisioi"
              busy={busy}
              onConfirm={confirm}
              onCancel={() => setPreview(null)}
            />
          ) : (
            <Muted>Kaikki objektit ovat jo olemassa.</Muted>
          )}
        </>
      ) : (
        <Button onClick={start} disabled={busy}>
          {busy ? "Haetaan…" : "Esikatsele provisiointi"}
        </Button>
      )}
      {error ? <ErrorText>Provisiointi epäonnistui: {error}</ErrorText> : null}
    </Section>
  );
}

function RuleRow(props: { rule: EditorRule; onChange: (rule: EditorRule) => void; onRemove?: () => void }) {
  const { rule } = props;
  const type = String(rule.type);
  const set = (key: string, value: string | boolean) => props.onChange({ ...rule, [key]: value });
  const select = (key: string, label: string, options: readonly string[]) => (
    <label className="text-sm">
      <span className="block text-muted-foreground">{label}</span>
      <select aria-label={label} className="rounded-md border bg-background px-2 py-1 text-sm" value={String(rule[key] ?? "")} onChange={(event) => set(key, event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{RULE_TYPE_LABEL[type] ?? type}</legend>
      <div className="flex flex-wrap items-end gap-3">
        {type !== "pause_all_cap" ? (
          <>
            <label className="text-sm">
              <span className="block text-muted-foreground">Tunniste</span>
              <input aria-label="Tunniste" className="rounded-md border bg-background px-2 py-1 text-sm" value={String(rule.ruleId ?? "")} onChange={(event) => set("ruleId", event.target.value)} />
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={rule.enabled !== false} onChange={(event) => set("enabled", event.target.checked)} />
              Käytössä
            </label>
          </>
        ) : null}
        {select("mode", "Tila", EDITOR_MODES)}
        {type === "threshold_pause" ? (
          <>
            {select("metric", "Mittari", EDITOR_METRICS)}
            {select("operator", "Vertailu", EDITOR_OPERATORS)}
            {select("aggregate", "Laskenta", EDITOR_AGGREGATES)}
          </>
        ) : null}
        {(NUMBER_FIELDS[type] ?? []).map((field) => (
          <label key={field.key} className="text-sm">
            <span className="block text-muted-foreground">{field.label}</span>
            <input
              aria-label={field.label}
              inputMode="decimal"
              className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
              value={String(rule[field.key] ?? "")}
              onChange={(event) => set(field.key, event.target.value)}
            />
          </label>
        ))}
        {props.onRemove ? (
          <Button onClick={props.onRemove} variant="destructive">
            Poista
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

function RuleEditor(props: { companyId: string | null }) {
  const rules = usePluginData<RulesData>(DATA.rules, { companyId: props.companyId });
  const prepare = usePluginAction(ACTION.rulesPrepareSave);
  const dryRun = usePluginAction(ACTION.rulesDryRun);
  const toast = usePluginToast();
  const [draft, setDraft] = useState<EditorRule[] | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  /** `updatedAt` of the saved config this draft started from; the save refuses a newer one (RK9-563). Null until it was read. */
  const [version, setVersion] = useState<{ updatedAt: string | null } | null>(null);

  useEffect(() => {
    if (!rules.data || rules.data.state !== "enabled") return;
    // propose_scale stays off and is not edited here; the worker keeps the saved entries (G9).
    setDraft((rules.data.rules ?? []).filter((rule) => rule.type !== "propose_scale").map(toEditor));
    setLiveMode(rules.data.liveMode === true);
    if (!props.companyId) return;
    let current = true;
    setVersion(null);
    readConfigVersion(props.companyId).then(
      (updatedAt) => {
        if (current) setVersion({ updatedAt });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [rules.data, props.companyId]);

  // A confirmation covers the draft it listed; an edit after it asks again.
  useEffect(() => setPending(null), [draft, liveMode]);

  if (rules.error) return <Section title="Säännöt"><ErrorText>Sääntöjä ei voitu lukea: {rules.error.message}</ErrorText></Section>;
  if (!rules.data || !draft) {
    return (
      <Section title="Säännöt">
        {rules.loading ? <Spinner label="Ladataan sääntöjä" /> : <Muted>Säännöt ovat käytössä vain, kun brändi on päällä.</Muted>}
      </Section>
    );
  }
  async function write(prepared: NonNullable<PreparedRules["rules"]>, confirmedWeakening: string[], confirmedLive: boolean) {
    // Without the loaded version a newer config could be overwritten: no save (RK9-563).
    if (!version) throw new Error("Tallennetun configin versiota ei ole luettu. Lataa sivu uudelleen ja tallenna sitten.");
    setVersion({ updatedAt: await saveRulesBlock(props.companyId!, prepared, fetch, confirmedWeakening, confirmedLive, version.updatedAt) });
    setPending(null);
    toast({ title: "Säännöt tallennettu", tone: "success" });
    rules.refresh();
  }

  /**
   * Prepares the draft. The worker compares it with the config saved now: a
   * save that weakens the protection or turns live mode on comes back with
   * the changes to confirm and waits for the typed words.
   */
  async function save() {
    if (!props.companyId) return;
    setBusy(true);
    setErrors([]);
    try {
      const list = draft!.map(fromEditor);
      const prepared = (await prepare({ liveMode, list })) as PreparedRules;
      if (prepared.ok && prepared.rules) {
        await write(prepared.rules, [], false);
        return;
      }
      if (prepared.confirm && (prepared.confirm.weakening.length > 0 || prepared.confirm.liveOn)) {
        setPending(pendingFor(list, liveMode, prepared.confirm));
        return;
      }
      setErrors(prepared.errors ?? ["Säännöt eivät kelpaa"]);
    } catch (cause) {
      setErrors([errorText(cause)]);
    } finally {
      setBusy(false);
    }
  }

  /** One typed word; after the last one the worker checks the confirmed changes again and the save goes out. */
  async function confirmPending() {
    if (!pending) return;
    if (pending.step < pending.words.length - 1) {
      setPending({ ...pending, step: pending.step + 1 });
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      const prepared = (await prepare({ liveMode: pending.liveMode, list: pending.list, confirmedWeakening: pending.weakening, confirmLive: pending.liveOn })) as PreparedRules;
      if (prepared.ok && prepared.rules) {
        await write(prepared.rules, pending.weakening, pending.liveOn);
        return;
      }
      if (prepared.confirm && (prepared.confirm.weakening.length > 0 || prepared.confirm.liveOn)) {
        // The saved rules changed after the list was shown: confirm the new list.
        setPending(pendingFor(pending.list, pending.liveMode, prepared.confirm));
        setErrors(["Tallennetut säännöt muuttuivat vahvistuksen aikana. Tarkista muutokset ja vahvista uudelleen."]);
        return;
      }
      setErrors(prepared.errors ?? ["Säännöt eivät kelpaa"]);
    } catch (cause) {
      setErrors([errorText(cause)]);
    } finally {
      setBusy(false);
    }
  }

  async function runDry() {
    setBusy(true);
    try {
      setDry((await dryRun({})) as DryRunResult);
    } catch (cause) {
      setDry({ error: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  const update = (index: number, rule: EditorRule) => setDraft(draft.map((entry, at) => (at === index ? rule : entry)));
  const remove = (index: number) => setDraft(draft.filter((_entry, at) => at !== index));
  const add = (type: string) => {
    const capIndex = draft.findIndex((rule) => rule.type === "pause_all_cap");
    const next = [...draft];
    next.splice(capIndex === -1 ? next.length : capIndex, 0, newRule(type, draft.length));
    setDraft(next);
  };

  return (
    <Section
      title="Säännöt"
      actions={
        <Button onClick={runDry} disabled={busy}>
          Kuivaharjoitus
        </Button>
      }
    >
      <Muted>Tallennetut säännöt näkyvät ajossa vasta tallennuksen jälkeen. Kuivaharjoitus käyttää tallennettuja sääntöjä eikä kirjoita Metaan.</Muted>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={liveMode} onChange={(event) => setLiveMode(event.target.checked)} />
        Live-tila: säännöt saavat pysäyttää mainoksia (muuten kaikki ajetaan varjotilassa)
      </label>
      {draft.map((rule, index) => (
        <RuleRow
          key={index}
          rule={rule}
          onChange={(next) => update(index, next)}
          onRemove={rule.type === "pause_all_cap" || rule.ruleId === BUILTIN_CAP_RULE_ID ? undefined : () => remove(index)}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        {EDITOR_RULE_TYPES.filter((type) => type !== "pause_all_cap").map((type) => (
          <Button key={type} onClick={() => add(type)}>
            Lisää: {RULE_TYPE_LABEL[type]}
          </Button>
        ))}
      </div>
      {pending ? (
        <div className="space-y-2">
          {pending.weakening.length + pending.live.length > 0 ? (
            <ul aria-label="Vahvistettavat muutokset" className="list-disc space-y-1 pl-5 text-sm">
              {[...pending.weakening, ...pending.live].map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : null}
          {pending.words.length > 1 ? <Muted>Vahvistus {pending.step + 1}/{pending.words.length}</Muted> : null}
          <TypedConfirm
            key={`${pending.step}-${pending.words[pending.step]}`}
            word={pending.words[pending.step]!}
            prompt={pending.words[pending.step] === WEAKEN_WORD ? "Tallennus heikentää automaattista kulusuojaa:" : LIVE_PROMPT}
            confirmLabel={
              pending.step < pending.words.length - 1 ? "Jatka" : pending.weakening.length > 0 ? "Tallenna heikennetyt säännöt" : "Tallenna live-tilassa"
            }
            busy={busy}
            onConfirm={() => void confirmPending()}
            onCancel={() => setPending(null)}
          />
        </div>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Tallennetaan…" : "Tallenna säännöt"}
        </Button>
      )}
      {errors.length > 0 ? (
        <div role="alert" className="space-y-1">
          {errors.map((error) => (
            <ErrorText key={error}>{error}</ErrorText>
          ))}
        </div>
      ) : null}
      {dry ? (
        dry.error ? (
          <ErrorText>Kuivaharjoitus epäonnistui: {dry.error}</ErrorText>
        ) : (
          <div className="space-y-2">
            <DataTable
              columns={[
                { key: "ruleId", header: "Sääntö" },
                { key: "action", header: "Toimi" },
                { key: "objectId", header: "Kohde", render: (value, row) => `${String(row.objectType)} ${String(value)}` },
                { key: "mode", header: "Tila" },
                { key: "reason", header: "Syy" },
              ]}
              rows={(dry.decisions ?? []).map((decision, index) => ({ ...decision, id: `${decision.ruleId}-${decision.objectId}-${index}` }))}
              emptyMessage="Säännöt eivät tekisi nyt mitään."
            />
            {(dry.warnings ?? []).map((warning) => (
              <ErrorText key={warning}>{warning}</ErrorText>
            ))}
          </div>
        )
      ) : null}
    </Section>
  );
}

export function SettingsPage(props: PluginCompanySettingsPageProps) {
  const companyId = props.context.companyId;
  const settings = usePluginData<UiSettings>(DATA.settings, { companyId });

  if (settings.loading && !settings.data) return <Spinner label="Ladataan asetuksia" />;
  if (settings.error) return <ErrorText>Asetuksia ei voitu ladata: {settings.error.message}</ErrorText>;
  const data = settings.data;
  if (!data || data.state === "error") return <ErrorText>Asetuksia ei voitu ladata: {data?.error ?? "tyhjä vastaus"}</ErrorText>;

  if (data.state === "absent" || data.state === "unavailable" || data.state === "invalid") {
    return (
      <main className="space-y-4">
        <h1 className="text-xl font-semibold">Mainonta</h1>
        <EmptyState
          hostConfig
          title={data.state === "absent" ? "RK9 Ads ei ole käytössä tässä yrityksessä. Tyhjä asetus pitää pluginin pois päältä." : data.state === "invalid" ? "Brändin asetukset ovat virheelliset." : "Asetuksia ei voitu lukea."}
          detail={data.error}
        />
        {data.errors.length > 0 ? (
          <div role="alert" className="space-y-1">
            {data.errors.map((error) => (
              <ErrorText key={error}>{error}</ErrorText>
            ))}
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">Mainonta</h1>
      <ConfigSummary settings={data} />
      <PreflightSection companyId={companyId} />
      {data.state === "enabled" ? <ProvisionSection onDone={settings.refresh} /> : null}
      <RuleEditor companyId={companyId} />
    </main>
  );
}
