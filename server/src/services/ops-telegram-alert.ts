// Operator alert delivery to Telegram for host monitors (RK9-710).
//
// Slack posting was removed in RK9-697. scripts/check-github-webhook-health.ts
// now sends its throttled alerts here. server/scripts/io-watch.sh has its own
// curl-based sender with the same rules.
//
// Rules:
//   - TG_BOT_TOKEN and TG_CHAT_ID come from the environment (the systemd unit
//     loads /etc/paperclip/approval-telegram.env). Missing or malformed values
//     disable sending; the caller logs one WARN line and carries on.
//   - The token is part of the request URL, so the URL is never logged. Every
//     error text that reaches a log is redacted.
//   - A delivery failure never throws. The monitor's own exit code is unchanged.

const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;
const CHAT_RE = /^-?[0-9]+$/;
// Telegram rejects texts over 4096 characters.
const MAX_TEXT = 3500;
const SEND_TIMEOUT_MS = 10_000;

export interface TelegramAlertConfig {
  token: string;
  chatId: string;
}

type Env = Record<string, string | undefined>;

/** Validated config, or null when sending must be skipped. */
export function readTelegramAlertConfig(env: Env): TelegramAlertConfig | null {
  const token = (env.TG_BOT_TOKEN ?? "").trim();
  const chatId = (env.TG_CHAT_ID ?? "").trim();
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) return null;
  return { token, chatId };
}

export const TELEGRAM_CONFIG_MISSING_WARNING =
  "WARN: TG_BOT_TOKEN tai TG_CHAT_ID puuttuu tai on virheellinen, joten Telegram-hälytystä ei lähetetä.";

export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}

export type TelegramSendResult = "sent" | "skipped" | "failed";

export interface TelegramSendDeps {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Send one alert text. Returns "skipped" without a request when config is null.
 * Never throws and never writes the token or the request URL to a log.
 */
export async function sendTelegramAlert(
  config: TelegramAlertConfig | null,
  text: string,
  deps: TelegramSendDeps = {},
): Promise<TelegramSendResult> {
  if (!config) return "skipped";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const body = JSON.stringify({
    chat_id: config.chatId,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text,
    disable_web_page_preview: true,
  });
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    let payload: { ok?: boolean; description?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // non-JSON body: the HTTP status is all we report
    }
    if (res.ok && payload.ok === true) {
      log("Telegram: hälytys lähetetty.");
      return "sent";
    }
    const detail = payload.description ? ` (${payload.description})` : "";
    warn(
      redactToken(
        `WARN: Telegram-lähetys epäonnistui: HTTP ${res.status}${detail}`,
        config.token,
      ),
    );
    return "failed";
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    warn(
      redactToken(`WARN: Telegram-lähetys epäonnistui: ${message}`, config.token),
    );
    return "failed";
  }
}
