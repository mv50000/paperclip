import { useState } from "react";
import { DataTable, KeyValueList, Spinner, usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { UiGateCard, UiHalt, UiOverview, UiPauseAdResult, UiPendingUndo, UiPublication, UiSpend } from "../features/ui/dto.js";
import type { HaltState } from "../features/spend-guard/halt.js";
import type { PauseAllResult } from "../features/spend-guard/killswitch.js";
import { AdStatusBadge, Button, CapGauge, EmptyState, ErrorText, FatigueBadge, Muted, Section, TypedConfirm } from "./components.js";
import { errorText, fmtDateTime, fmtEur, fmtNumber, fmtPct } from "./format.js";
import { ACTION, DATA } from "./keys.js";

/** The word the operator types before a pause or the kill switch. */
export const PAUSE_WORD = "PYSÄYTÄ";
/** The pause that set the halt, as the banner names it. */
const HALT_RULE_LABEL: Record<string, string> = {
  kill_switch: "hätäkatkaisin",
  scheduled_pause: "ajastettu pysäytys",
  pause_all_cap: "kulutuskatto 90 %",
};

/** The word the operator types before lifting the standing halt. */
export const CLEAR_HALT_WORD = "POISTA";
export const ACK_UNDO_WORD = "KUITTAA";

const UNDO_KIND_LABEL: Record<string, string> = { campaign: "kampanja", adset: "ad set", ad: "mainos" };

const SPEND_CAP_TEXT: Record<UiSpend["spendCapStatus"], string> = {
  set: "asetettu",
  missing: "puuttuu: Metan katto ei suojaa",
  above_cap: "korkeampi kuin pluginin kuukausikatto",
  unknown: "ei luettu",
};

function SpendHeader(props: { overview: UiOverview }) {
  const { overview } = props;
  const spend = overview.spend;
  const timeZone = overview.brand?.timeZone;
  return (
    <div className="space-y-3">
      {spend ? (
        <CapGauge mtdEur={spend.mtdEur} capEur={spend.monthlyCapEur} pctUsed={spend.pctUsed} />
      ) : (
        <Muted>Kuukauden kulutusta ei ole luettu{overview.brand?.monthlyCapEur === null ? ": kuukausikatto puuttuu, brändi on pois päältä." : "."}</Muted>
      )}
      {overview.spendError ? <ErrorText>Kulutuslukuja ei voitu lukea: {overview.spendError}</ErrorText> : null}
      <KeyValueList
        pairs={[
          {
            label: "Ennuste kuun lopussa",
            value: spend
              ? `${fmtEur(spend.projectedMonthEndEur)} (päiväbudjetit ${fmtEur(spend.dailyBudgetSumEur)}/pv, ${spend.remainingDays} pv jäljellä)`
              : "–",
          },
          {
            label: "Metan spend_cap",
            value: spend ? `${fmtEur(spend.spendCapEur)}: ${SPEND_CAP_TEXT[spend.spendCapStatus]}` : "–",
          },
          {
            label: "Spend guard",
            value: spend ? (spend.allow ? "sallii kulutuksen noston" : `estää kulutuksen noston (${spend.reason})`) : "–",
          },
          {
            label: "Julkaisuvalmis",
            value:
              overview.launchReady === null
                ? "preflightia ei ole ajettu"
                : `${overview.launchReady ? "kyllä" : "ei"} (tarkistettu ${fmtDateTime(overview.preflightCheckedAt, timeZone)}${overview.preflightFresh ? "" : ", vanhentunut"})`,
          },
        ]}
      />
    </div>
  );
}

function HaltBanner(props: {
  halt: UiHalt | null;
  haltError?: string;
  timeZone?: string;
  onChanged: () => void;
}) {
  const clearHalt = usePluginAction(ACTION.clearHalt);
  const toast = usePluginToast();
  const [preview, setPreview] = useState<HaltState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (props.haltError) {
    return <ErrorText>Pysäytystilaa ei voitu lukea: {props.haltError}. Aktivointi voi olla estetty.</ErrorText>;
  }
  if (!props.halt) return null;
  const halt = props.halt;
  const who = halt.userId ?? halt.agentId ?? (halt.tgUserId !== null ? `Telegram ${halt.tgUserId}` : null);
  const why = HALT_RULE_LABEL[halt.rule] ?? halt.rule;

  async function startClear() {
    setBusy(true);
    setError(null);
    try {
      const result = (await clearHalt({ dryRun: true })) as { halt: HaltState | null };
      if (!result.halt) {
        props.onChanged();
        return;
      }
      setPreview(result.halt);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmClear() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      // `since` from the preview: the worker refuses if a newer kill switch set the halt again.
      const result = (await clearHalt({ dryRun: false, confirm: true, since: preview.since })) as { cleared?: boolean; remaining?: HaltState };
      setPreview(null);
      // `cleared: false`: the halt ended between the preview and the clear, so nothing was cleared (RK9-565).
      // Another pause's halt may still be in force (e.g. the scheduled pause's under a cleared kill switch).
      toast(
        result.cleared === false
          ? { title: "Pysäytystila oli jo päättynyt, mitään ei poistettu", tone: "info" }
          : result.remaining
            ? { title: "Pysäytystila poistettu, mutta toinen pysäytystila on yhä päällä", tone: "warn" }
            : { title: "Pysäytystila poistettu", tone: "success" },
      );
      props.onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className="space-y-2 rounded-md border border-destructive p-3">
      <p className="text-sm font-semibold text-destructive">
        {halt.until
          ? `Pysäytystila päällä (${why}): mitään mainosta ei aktivoida ennen ${fmtDateTime(halt.until, props.timeZone)}, ellei board poista tilaa.`
          : `Pysäytystila päällä (${why}): mitään mainosta ei aktivoida ennen kuin board poistaa tilan.`}
      </p>
      <KeyValueList
        pairs={[
          { label: "Alkaen", value: fmtDateTime(halt.since, props.timeZone) },
          ...(halt.until ? [{ label: "Voimassa", value: fmtDateTime(halt.until, props.timeZone) }] : []),
          { label: "Kuka", value: who ? `${who} (${halt.source})` : halt.source },
          { label: "Syy", value: halt.reason || "–" },
        ]}
      />
      {preview ? (
        <TypedConfirm
          word={CLEAR_HALT_WORD}
          prompt={`Poistetaan ${fmtDateTime(preview.since, props.timeZone)} asetettu pysäytystila. Aktivointikortit toimivat taas.`}
          confirmLabel="Poista pysäytystila"
          busy={busy}
          onConfirm={confirmClear}
          onCancel={() => setPreview(null)}
        />
      ) : (
        <Button variant="destructive" onClick={startClear} disabled={busy}>
          Poista pysäytystila
        </Button>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

/**
 * The activation undos that Meta refused (RK9-565): the job retries PAUSED
 * every 5 minutes, with or without a halt. A board user can stop the retry
 * of the entries the preview lists, with a typed confirmation.
 */
function PendingUndoNotice(props: { pendingUndo?: UiPendingUndo[]; pendingUndoError?: string; onChanged: () => void }) {
  const clearHalt = usePluginAction(ACTION.clearHalt);
  const toast = usePluginToast();
  const [keys, setKeys] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = props.pendingUndo ?? [];
  if (undo.length === 0 && !props.pendingUndoError) return null;

  async function startAck() {
    setBusy(true);
    setError(null);
    try {
      const result = (await clearHalt({ dryRun: true })) as { pendingUndo?: Array<{ key: string }>; pendingUndoError?: string };
      if (result.pendingUndoError) throw new Error(result.pendingUndoError);
      const open = (result.pendingUndo ?? []).map((entry) => entry.key);
      if (open.length === 0) {
        props.onChanged();
        return;
      }
      setKeys(open);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAck() {
    if (!keys) return;
    setBusy(true);
    setError(null);
    try {
      // Only the keys from the preview: an undo that failed after it keeps its retry.
      const result = (await clearHalt({ dryRun: false, confirm: true, acknowledgeUndos: keys })) as { acknowledgedUndos?: number };
      setKeys(null);
      toast({ title: `Kuitattu ${result.acknowledgedUndos ?? 0} peruutusta`, tone: "success" });
      props.onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" className="space-y-2 rounded-md border border-destructive p-3">
      {undo.length > 0 ? (
        <ErrorText>
          Aktivoinnin peruutus epäonnistui, voi olla yhä ACTIVE:{" "}
          {undo.map((entry) => `${UNDO_KIND_LABEL[entry.kind] ?? entry.kind} ${entry.objectId}`).join(", ")}. Peruutusta yritetään uudelleen 5 minuutin
          välein, kunnes Meta vahvistaa pysäytyksen, uudempi aktivointi hyväksytään tai board kuittaa sen.
        </ErrorText>
      ) : null}
      {props.pendingUndoError ? <ErrorText>Keskeneräisiä peruutuksia ei voitu lukea: {props.pendingUndoError}</ErrorText> : null}
      {keys ? (
        <TypedConfirm
          word={ACK_UNDO_WORD}
          prompt={`Kuittaus lopettaa ${keys.length} peruutuksen uudelleenyrityksen. Kohteet voivat jäädä ACTIVE-tilaan kuluttamaan: tarkista ja pysäytä ne Metassa.`}
          confirmLabel="Kuittaa peruutukset"
          busy={busy}
          onConfirm={confirmAck}
          onCancel={() => setKeys(null)}
        />
      ) : undo.length > 0 ? (
        <Button variant="destructive" onClick={startAck} disabled={busy}>
          Kuittaa peruutukset
        </Button>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </div>
  );
}

/** The kill switch ("Pysäytä kaikki"): dry-run preview, typed confirmation, then the live pause with confirm: true. */
export function KillSwitchButton(props: { onDone: () => void }) {
  const pauseAll = usePluginAction(ACTION.pauseAll);
  const [preview, setPreview] = useState<KillSwitchOutcome | null>(null);
  const [result, setResult] = useState<KillSwitchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPreview() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview((await pauseAll({ dryRun: true })) as KillSwitchOutcome);
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
      const live = (await pauseAll({ dryRun: false, confirm: true })) as KillSwitchOutcome;
      setPreview(null);
      setResult(live);
      props.onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {preview ? <FallbackNote state={preview.fallbackConfig} /> : null}
      {preview && preview.errors.length > 0 ? (
        <ErrorText>
          Esikatselu ei saanut kaikkia kohteita: {preview.errors.map((entry) => `${entry.id} (${entry.error})`).join(", ")}
        </ErrorText>
      ) : null}
      {preview ? (
        <TypedConfirm
          word={PAUSE_WORD}
          prompt={`Hätäkatkaisin pysäyttää ${preview.pausedAds.length} mainosta ja ${preview.pausedCampaigns.length} kampanjaa koko mainostililtä ja jättää pysäytystilan päälle.`}
          confirmLabel="Pysäytä kaikki"
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPreview(null)}
        />
      ) : (
        <Button variant="destructive" onClick={startPreview} disabled={busy}>
          {busy ? "Haetaan…" : "Pysäytä kaikki"}
        </Button>
      )}
      {error ? <ErrorText>Hätäkatkaisin epäonnistui: {error}</ErrorText> : null}
      {result ? <KillSwitchResult result={result} /> : null}
    </div>
  );
}

/** pause-all adds `fallbackConfig` when it ran on the last valid config (spend-guard/register.ts). */
type KillSwitchOutcome = PauseAllResult & { fallbackConfig?: string };

function FallbackNote(props: { state?: string }) {
  if (!props.state) return null;
  const label = props.state === "invalid" ? "virheelliset" : props.state === "disabled" ? "pois päältä" : "lukukelvottomat";
  return <ErrorText>Nykyiset asetukset ovat {label}: hätäkatkaisin käyttää viimeisintä toimivaa konfiguraatiota.</ErrorText>;
}

/** The live result; every partial failure shows as an error, not as a footnote (RK9-561). */
export function KillSwitchResult(props: { result: KillSwitchOutcome }) {
  const { result } = props;
  return (
    <div className="space-y-1">
      <FallbackNote state={result.fallbackConfig} />
      <p className="text-sm">
        Pysäytetty {result.pausedAds.length} mainosta ja {result.pausedCampaigns.length} kampanjaa.
        {result.halt ? " Pysäytystila on päällä." : ""}
        {result.closedCardIds.length > 0 ? ` Suljettu ${result.closedCardIds.length} aktivointikorttia.` : ""}
      </p>
      {result.errors.length > 0 ? (
        <ErrorText>
          {result.errors.length} pysäytystä epäonnistui: {result.errors.map((entry) => `${entry.id} (${entry.error})`).join(", ")}
        </ErrorText>
      ) : null}
      {result.haltError ? <ErrorText>Pysäytystilaa EI tallennettu: {result.haltError}. Aktivointi ei ole estetty.</ErrorText> : null}
      {result.cardsError ? <ErrorText>Avoimia aktivointikortteja EI suljettu: {result.cardsError}</ErrorText> : null}
      {result.auditError ? <ErrorText>Kirjanpitoriviä ei tallennettu: {result.auditError}</ErrorText> : null}
      {result.telegram === "failed" ? <ErrorText>Telegram-ilmoitus epäonnistui: {result.telegramError ?? "tuntematon virhe"}</ErrorText> : null}
    </div>
  );
}

function PauseAdPanel(props: { publication: UiPublication; onCancel: () => void; onPaused: (result: UiPauseAdResult) => void }) {
  const pauseAd = usePluginAction(ACTION.pauseAd);
  const toast = usePluginToast();
  const [preview, setPreview] = useState<UiPauseAdResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adId = props.publication.metaAdId!;

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setPreview((await pauseAd({ adId, dryRun: true })) as UiPauseAdResult);
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
      const result = (await pauseAd({ adId, dryRun: false, confirm: true })) as UiPauseAdResult;
      const closed = result.closedCardIds?.length ?? 0;
      toast({ title: `Mainos ${result.name ?? adId} pysäytetty${closed > 0 ? `, ${closed} aktivointikorttia suljettu` : ""}`, tone: "success" });
      if (result.auditError) toast({ title: "Kirjanpitoriviä ei tallennettu", body: result.auditError, tone: "warn" });
      props.onPaused(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {preview ? (
        <TypedConfirm
          word={PAUSE_WORD}
          prompt={`Pysäytetään mainos ${preview.name ?? adId} (${adId}). Nykyinen tila: ${preview.previousStatus}.`}
          confirmLabel="Pysäytä mainos"
          busy={busy}
          onConfirm={confirm}
          onCancel={props.onCancel}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">Pysäytä mainos {props.publication.adName ?? adId}?</span>
          <Button variant="destructive" onClick={load} disabled={busy}>
            {busy ? "Tarkistetaan…" : "Tarkista ja jatka"}
          </Button>
          <Button onClick={props.onCancel} disabled={busy}>
            Peruuta
          </Button>
        </div>
      )}
      {error ? <ErrorText>Pysäytys epäonnistui: {error}</ErrorText> : null}
    </div>
  );
}

function GateCards(props: { cards: UiGateCard[]; error?: string; timeZone?: string }) {
  const resend = usePluginAction(ACTION.resendGateCard);
  const toast = usePluginToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function send(card: UiGateCard) {
    setBusyId(card.id);
    try {
      await resend({ gateRequestId: card.id });
      toast({ title: "Kortti lähetetty uudelleen Telegramiin", tone: "success" });
    } catch (cause) {
      toast({ title: "Kortin uudelleenlähetys epäonnistui", body: errorText(cause), tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section title="Odottavat aktivointikortit">
      {props.error ? <ErrorText>Kortteja ei voitu lukea: {props.error}</ErrorText> : null}
      <DataTable
        columns={[
          { key: "kind", header: "Tyyppi" },
          { key: "adId", header: "Mainos", render: (value) => String(value ?? "–") },
          { key: "validUntil", header: "Voimassa", render: (value) => fmtDateTime(String(value), props.timeZone) },
          {
            key: "id",
            header: "",
            render: (_value, row) =>
              row.kind === "activate_ad" ? (
                <Button onClick={() => send(row as unknown as UiGateCard)} disabled={busyId !== null}>
                  {busyId === row.id ? "Lähetetään…" : "Lähetä uudelleen"}
                </Button>
              ) : null,
          },
        ]}
        rows={props.cards as unknown as Record<string, unknown>[]}
        emptyMessage="Ei odottavia kortteja."
      />
    </Section>
  );
}

function DigestPreview() {
  const preview = usePluginAction(ACTION.digestPreview);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const result = (await preview({})) as { text?: string | null; error?: string };
      if (result.error) setError(result.error);
      else setText(result.text ?? "Digest on tänään tyhjä.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Digestin esikatselu"
      actions={
        <Button onClick={load} disabled={busy}>
          {busy ? "Haetaan…" : text === null ? "Näytä esikatselu" : "Päivitä"}
        </Button>
      }
    >
      {error ? <ErrorText>{error}</ErrorText> : null}
      {text !== null ? <pre className="whitespace-pre-wrap rounded-md border p-3 text-sm">{text}</pre> : <Muted>Esikatselu ei lähetä mitään.</Muted>}
    </Section>
  );
}

export function AdsPage(props: PluginPageProps) {
  const companyId = props.context.companyId;
  const overview = usePluginData<UiOverview>(DATA.overview, { companyId });
  const [pausing, setPausing] = useState<UiPublication | null>(null);
  // A pause whose card close failed: the error stays on the page after the panel closes (RK9-562).
  const [pauseCardsError, setPauseCardsError] = useState<{ adId: string; error: string } | null>(null);

  if (overview.loading && !overview.data) return <Spinner label="Ladataan mainontaa" />;
  if (overview.error) return <ErrorText>Mainonnan tietoja ei voitu ladata: {overview.error.message}</ErrorText>;
  const data = overview.data;
  if (!data || data.state === "error") return <ErrorText>Mainonnan tietoja ei voitu ladata: {data?.error ?? "tyhjä vastaus"}</ErrorText>;

  const title = data.brand ? `Mainonta: ${data.brand.displayName}` : "Mainonta";
  if (data.state === "absent" || data.state === "invalid" || data.state === "unavailable") {
    return (
      <main className="space-y-4">
        <h1 className="text-xl font-semibold">{title}</h1>
        {data.halt || data.haltError ? <HaltBanner halt={data.halt} haltError={data.haltError} onChanged={overview.refresh} /> : null}
        <PendingUndoNotice pendingUndo={data.pendingUndo} pendingUndoError={data.pendingUndoError} onChanged={overview.refresh} />
        {data.state !== "absent" ? (
          <Section title="Hätäkatkaisin">
            <Muted>Mainokset voivat olla yhä käynnissä. Hätäkatkaisin käyttää viimeisintä toimivaa konfiguraatiota, jos sellainen on tallessa.</Muted>
            <KillSwitchButton onDone={overview.refresh} />
          </Section>
        ) : null}
        <EmptyState
          title={data.state === "absent" ? "RK9 Ads ei ole käytössä tässä yrityksessä." : data.state === "invalid" ? "Brändin asetukset ovat virheelliset." : "Asetuksia ei voitu lukea."}
          detail={data.error}
        />
      </main>
    );
  }

  const timeZone = data.brand?.timeZone;
  return (
    <main className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-xl font-semibold">{title}</h1>
          <KillSwitchButton onDone={overview.refresh} />
        </div>
        <HaltBanner halt={data.halt} haltError={data.haltError} timeZone={timeZone} onChanged={overview.refresh} />
        <PendingUndoNotice pendingUndo={data.pendingUndo} pendingUndoError={data.pendingUndoError} onChanged={overview.refresh} />
        {data.state === "disabled" ? <EmptyState title="Brändi on pois päältä." detail={data.error} /> : null}
        <SpendHeader overview={data} />
      </header>

      <Section title="Julkaisut">
        {data.publicationsError ? <ErrorText>Julkaisuja ei voitu lukea: {data.publicationsError}</ErrorText> : null}
        {data.adsError ? <ErrorText>Mainosten tilaa ei voitu lukea Metasta: {data.adsError}</ErrorText> : null}
        {pausing ? (
          <PauseAdPanel
            publication={pausing}
            onCancel={() => setPausing(null)}
            onPaused={(result) => {
              setPausing(null);
              setPauseCardsError(result.cardsError ? { adId: result.adId, error: result.cardsError } : null);
              overview.refresh();
            }}
          />
        ) : null}
        {pauseCardsError ? (
          <ErrorText>
            Mainos {pauseCardsError.adId} pysäytettiin, mutta sen aktivointikortteja EI saatu varmasti suljettua: {pauseCardsError.error}. Mainos voi aktivoitua uudelleen: tarkista sen tila.
          </ErrorText>
        ) : null}
        {data.publications.length === 0 && !data.publicationsError ? (
          <EmptyState title="Ei vielä julkaisuja." detail="Julkaisut ilmestyvät tähän, kun ensimmäinen mainos on julkaistu." />
        ) : (
          <DataTable
            columns={[
              { key: "adName", header: "Mainos", render: (value, row) => String(value ?? row.metaAdId ?? row.id) },
              { key: "status", header: "Julkaisu" },
              { key: "adStatus", header: "Metassa", render: (value) => <AdStatusBadge status={(value as string | null) ?? null} /> },
              { key: "spendEur", header: "Kulutus 14 pv", render: (value) => fmtEur(value as number) },
              { key: "ctrPct", header: "CTR", render: (value) => fmtPct(value as number | null, 2) },
              { key: "cpcEur", header: "CPC", render: (value) => fmtEur(value as number | null) },
              { key: "fatigue", header: "Väsymys", render: (value) => <FatigueBadge fatigue={(value as string | null) ?? null} /> },
              {
                key: "id",
                header: "",
                render: (_value, row) => {
                  const publication = row as unknown as UiPublication;
                  if (!publication.metaAdId || publication.adStatus === "PAUSED") return null;
                  return (
                    <Button variant="destructive" onClick={() => setPausing(publication)} disabled={pausing !== null}>
                      Pysäytä
                    </Button>
                  );
                },
              },
            ]}
            rows={data.publications as unknown as Record<string, unknown>[]}
          />
        )}
      </Section>

      <GateCards cards={data.pendingGates} error={data.gatesError} timeZone={timeZone} />

      <Section title="Sääntöjen toimet (7 pv)">
        {data.ruleLogError ? <ErrorText>Sääntölokia ei voitu lukea: {data.ruleLogError}</ErrorText> : null}
        <DataTable
          columns={[
            { key: "decidedAt", header: "Aika", render: (value) => fmtDateTime(String(value), timeZone) },
            { key: "ruleId", header: "Sääntö" },
            { key: "action", header: "Toimi" },
            { key: "objectId", header: "Kohde", render: (value, row) => `${String(row.objectType)} ${String(value)}` },
            { key: "mode", header: "Tila" },
            { key: "applied", header: "Tehty", render: (value) => (value ? "kyllä" : "ei") },
          ]}
          rows={data.ruleLog.map((entry, index) => ({ ...entry, id: `${entry.decidedAt}-${index}` }))}
          emptyMessage="Ei sääntöjen toimia."
        />
      </Section>

      <Section title="Kulutus ja CPC, 14 päivää">
        {data.insightsError ? <ErrorText>Insighteja ei voitu lukea: {data.insightsError}</ErrorText> : null}
        <DataTable
          columns={[
            { key: "date", header: "Päivä" },
            { key: "spendEur", header: "Kulutus", render: (value) => fmtEur(value as number) },
            { key: "impressions", header: "Näytöt", render: (value) => fmtNumber(value as number) },
            { key: "linkClicks", header: "Linkkiklikit", render: (value) => fmtNumber(value as number) },
            { key: "cpcEur", header: "CPC", render: (value) => fmtEur(value as number | null) },
          ]}
          rows={data.spend14d.map((day) => ({ ...day, id: day.date }))}
          emptyMessage="Ei insighteja."
        />
      </Section>

      <DigestPreview />
    </main>
  );
}
