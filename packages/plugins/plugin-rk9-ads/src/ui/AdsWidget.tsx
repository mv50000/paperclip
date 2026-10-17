import { MetricCard, Spinner, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { UiWidget } from "../features/ui/dto.js";
import { EmptyState, ErrorText } from "./components.js";
import { fmtEur, fmtPct } from "./format.js";
import { DATA } from "./keys.js";

/** Dashboard widget: MTD against the monthly cap and the pending activation cards. */
export function AdsWidget(props: PluginWidgetProps) {
  const widget = usePluginData<UiWidget>(DATA.widget, { companyId: props.context.companyId });
  const navigation = useHostNavigation();

  if (widget.loading && !widget.data) return <Spinner label="Ladataan mainontaa" />;
  if (widget.error) return <ErrorText>Mainonta: {widget.error.message}</ErrorText>;
  const data = widget.data;
  if (!data || data.state === "error") return <ErrorText>Mainonta: {data?.error ?? "tyhjä vastaus"}</ErrorText>;
  if (data.state === "absent" || data.state === "invalid" || data.state === "unavailable") {
    return <EmptyState title="Mainonta ei ole käytössä." detail={data.state === "absent" ? undefined : data.error} />;
  }

  return (
    <div className="space-y-2">
      {data.halted ? <ErrorText>Pysäytystila päällä: aktivointi estetty.</ErrorText> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <MetricCard
          label={`Kulutus ${data.brandCode ?? ""}`.trim()}
          value={data.mtdEur === null ? "–" : `${fmtEur(data.mtdEur)} / ${fmtEur(data.monthlyCapEur)} (${fmtPct(data.pctUsed)})`}
        />
        <MetricCard label="Odottavat kortit" value={data.pendingGates === null ? "–" : data.pendingGates} />
      </div>
      {data.state === "disabled" ? <ErrorText>Brändi on pois päältä: kuukausikatto puuttuu.</ErrorText> : null}
      {data.spendError ? <ErrorText>Kulutusta ei voitu lukea: {data.spendError}</ErrorText> : null}
      {data.gatesError ? <ErrorText>Kortteja ei voitu lukea: {data.gatesError}</ErrorText> : null}
      <a className="text-sm font-medium underline underline-offset-4" {...navigation.linkProps("/ads")}>
        Avaa mainonta
      </a>
    </div>
  );
}
