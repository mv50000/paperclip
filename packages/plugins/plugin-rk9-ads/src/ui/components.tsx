/**
 * Small building blocks of the operator UI. Host Tailwind token classes only
 * (border, muted-foreground, destructive, primary): no colour literals.
 */
import { useState, type ReactNode } from "react";
import { StatusBadge, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import { fmtEur, fmtPct } from "./format.js";
import { HOST_CONFIG_PATH, SETTINGS_PATH } from "./keys.js";

type ButtonVariant = "default" | "primary" | "destructive";

const BUTTON_BASE = "inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  default: "bg-background hover:bg-accent",
  primary: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
  destructive: "border-destructive text-destructive hover:bg-destructive/10",
};

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={`${BUTTON_BASE} ${BUTTON_VARIANT[props.variant ?? "default"]}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/** One page section: a heading and its content, separated by a rule, not a card. */
export function Section(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.actions ? <div className="flex flex-wrap gap-2">{props.actions}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

export function ErrorText(props: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {props.children}
    </p>
  );
}

export function Muted(props: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{props.children}</p>;
}

/** No config, an invalid one or nothing published yet: say so and link to the settings. */
export function EmptyState(props: { title: string; detail?: string; hostConfig?: boolean }) {
  const navigation = useHostNavigation();
  return (
    <div className="space-y-2 rounded-md border border-dashed p-4">
      <p className="text-sm font-medium">{props.title}</p>
      {props.detail ? <Muted>{props.detail}</Muted> : null}
      <a className="text-sm font-medium underline underline-offset-4" {...navigation.linkProps(props.hostConfig ? HOST_CONFIG_PATH : SETTINGS_PATH)}>
        {props.hostConfig ? "Avaa pluginin asetuslomake" : "Mainonnan asetukset"}
      </a>
    </div>
  );
}

/**
 * Typed confirmation for a money action: the button stays disabled until the
 * operator types `word`. The server still needs its own confirm flag.
 */
export function TypedConfirm(props: {
  word: string;
  prompt: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim() === props.word && !props.busy;
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 p-3">
      <p className="text-sm">{props.prompt}</p>
      <label className="block text-sm">
        <span className="text-muted-foreground">Kirjoita {props.word} vahvistaaksesi</span>
        <input
          aria-label={`Kirjoita ${props.word}`}
          className="mt-1 block w-full max-w-xs rounded-md border bg-background px-2 py-1 text-sm"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={!ready} onClick={props.onConfirm}>
          {props.busy ? "Odota…" : props.confirmLabel}
        </Button>
        <Button onClick={props.onCancel} disabled={props.busy}>
          Peruuta
        </Button>
      </div>
    </div>
  );
}

/** MTD against the monthly cap as a horizontal bar; past 90 % (the built-in cap pause) it turns destructive. */
export function CapGauge(props: { mtdEur: number | null; capEur: number | null; pctUsed: number | null }) {
  const pct = props.pctUsed ?? 0;
  const width = `${Math.min(100, Math.max(0, pct))}%`;
  const over = pct >= 90;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-lg font-semibold">{fmtEur(props.mtdEur)}</span>
        <span className="text-muted-foreground">/ {fmtEur(props.capEur)} kuukausikatosta</span>
        <span className={over ? "font-medium text-destructive" : "text-muted-foreground"}>({fmtPct(props.pctUsed)})</span>
      </div>
      <div
        role="meter"
        aria-label="Kulutus kuukausikatosta"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-2 w-full max-w-md overflow-hidden rounded-sm bg-muted"
      >
        <div className={`h-full ${over ? "bg-destructive" : "bg-primary"}`} style={{ width }} />
      </div>
    </div>
  );
}

const FATIGUE_LABEL: Record<string, { label: string; status: StatusBadgeVariant }> = {
  ok: { label: "Kunnossa", status: "ok" },
  watch: { label: "Seuraa", status: "warning" },
  fatigued: { label: "Väsynyt", status: "error" },
  "insufficient-data": { label: "Liian vähän dataa", status: "pending" },
};

export function FatigueBadge(props: { fatigue: string | null }) {
  if (!props.fatigue) return <span className="text-sm text-muted-foreground">–</span>;
  const entry = FATIGUE_LABEL[props.fatigue] ?? { label: props.fatigue, status: "info" as const };
  return <StatusBadge label={entry.label} status={entry.status} />;
}

export function AdStatusBadge(props: { status: string | null }) {
  if (!props.status) return <span className="text-sm text-muted-foreground">ei luettu</span>;
  const status: StatusBadgeVariant = props.status === "ACTIVE" ? "ok" : props.status === "PAUSED" ? "pending" : "info";
  return <StatusBadge label={props.status} status={status} />;
}
