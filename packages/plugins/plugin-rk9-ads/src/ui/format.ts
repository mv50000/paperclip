/** Display formatting for the operator UI. Finnish locale; times in the brand's zone. */

const eurFormat = new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat("fi-FI");

export function fmtEur(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? eurFormat.format(value) : "–";
}

export function fmtNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "–";
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits).replace(".", ",")} %` : "–";
}

export function fmtDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("fi-FI", { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
