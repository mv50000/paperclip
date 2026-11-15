import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAlertmanagerPayload,
  readRk9AlertChannels,
  readRk9AlertMode,
  readRk9claudeWebhookConfig,
  type Rk9AlertChannels,
  sendRk9Alert,
  shouldRecordAlert,
  truncateUtf8,
} from "./rk9-notify-alert.js";

// Every request in this file goes to a vi.fn() stand-in. No test reaches the
// real rk9claude webhook or Telegram.
const WEBHOOK_URL = "http://rk9claude.test:8080/alertmanager/webhook";
const WEBHOOK_TOKEN = "wh-Secret_token.123";
const TG_TOKEN = "123456:AAH-secret_token-value";
const TELEGRAM = { token: TG_TOKEN, chatId: "440715827" };
const WEBHOOK = { url: WEBHOOK_URL, token: WEBHOOK_TOKEN };
const KEY = "PaperclipWebhookMonitor:delivery";
const MESSAGE = "🔴 GitHub-webhook-valvonta (paperclip-01)\nToimitusvirheitä 24 h: rk9-ai/bk 3/10";

function channels(partial: Partial<Rk9AlertChannels> = {}): Rk9AlertChannels {
  return {
    telegram: TELEGRAM,
    webhook: WEBHOOK,
    mode: "both",
    legacy: false,
    host: "rk9-notify-paperclip-01",
    severity: "warning",
    ...partial,
  };
}

type FetchCall = [string, RequestInit];

/** Routes by URL: Telegram gets `telegram()`, everything else gets `webhook()`. */
function fakeFetch(webhook: () => Response | Promise<Response>, telegram?: () => Response) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      return (telegram ?? (() => new Response(JSON.stringify({ ok: true }), { status: 200 })))();
    }
    return webhook();
  });
}

function split(fetchImpl: ReturnType<typeof fakeFetch>) {
  const calls = fetchImpl.mock.calls as unknown as FetchCall[];
  return {
    webhook: calls.filter(([url]) => !String(url).startsWith("https://api.telegram.org/")),
    telegram: calls.filter(([url]) => String(url).startsWith("https://api.telegram.org/")),
  };
}

function telegramText(call: FetchCall): string {
  return JSON.parse(String(call[1].body)).text;
}

function collect() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) };
}

const ack = () => new Response(null, { status: 200 });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rk9-notify-alert-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readRk9claudeWebhookConfig", () => {
  it("reads the environment first", () => {
    expect(
      readRk9claudeWebhookConfig({
        RK9CLAUDE_WEBHOOK_URL: ` ${WEBHOOK_URL} `,
        RK9CLAUDE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      }),
    ).toEqual(WEBHOOK);
  });

  it("is unconfigured without the environment and without the file", () => {
    expect(readRk9claudeWebhookConfig({})).toBeNull();
    expect(readRk9claudeWebhookConfig({ HOME: dir })).toBeNull();
  });

  it("rejects a malformed URL or token", () => {
    const bad: Array<[string, string]> = [
      ["ftp://host/x", WEBHOOK_TOKEN],
      ["http://host/a b", WEBHOOK_TOKEN],
      ['http://host/"x', WEBHOOK_TOKEN],
      ["http://user:pass@host/x", WEBHOOK_TOKEN],
      [WEBHOOK_URL, "two words"],
      [WEBHOOK_URL, "rivi\nvaihto"],
      [WEBHOOK_URL, ""],
    ];
    for (const [url, token] of bad) {
      expect(
        readRk9claudeWebhookConfig({ RK9CLAUDE_WEBHOOK_URL: url, RK9CLAUDE_WEBHOOK_TOKEN: token }),
      ).toBeNull();
    }
  });

  it("reads the contract file under HOME when the environment is empty", () => {
    mkdirSync(path.join(dir, ".config/rk9"), { recursive: true });
    writeFileSync(
      path.join(dir, ".config/rk9/rk9claude-webhook.env"),
      `# kommentti\nRK9CLAUDE_WEBHOOK_URL=${WEBHOOK_URL}\nexport RK9CLAUDE_WEBHOOK_TOKEN="${WEBHOOK_TOKEN}"\r\nOTHER=x\n`,
    );
    expect(readRk9claudeWebhookConfig({ HOME: dir })).toEqual(WEBHOOK);
  });

  it("reads the file named by RK9_NOTIFY_WEBHOOK_ENV and never executes it", () => {
    const file = path.join(dir, "webhook.env");
    const marker = path.join(dir, "executed");
    writeFileSync(
      file,
      `touch ${marker}\nRK9CLAUDE_WEBHOOK_URL=${WEBHOOK_URL}\nRK9CLAUDE_WEBHOOK_TOKEN='${WEBHOOK_TOKEN}'\n`,
    );
    expect(readRk9claudeWebhookConfig({ RK9_NOTIFY_WEBHOOK_ENV: file, HOME: "/nonexistent" })).toEqual(
      WEBHOOK,
    );
    expect(() => chmodSync(marker, 0o600)).toThrow();
  });

  it("does not expand shell syntax in a file value", () => {
    const file = path.join(dir, "webhook.env");
    writeFileSync(file, `RK9CLAUDE_WEBHOOK_URL=${WEBHOOK_URL}\nRK9CLAUDE_WEBHOOK_TOKEN=$(id)\n`);
    expect(readRk9claudeWebhookConfig({ RK9_NOTIFY_WEBHOOK_ENV: file })?.token).toBe("$(id)");
  });

  it("does not fall through to the file when the environment holds a broken value", () => {
    const file = path.join(dir, "webhook.env");
    writeFileSync(file, `RK9CLAUDE_WEBHOOK_URL=${WEBHOOK_URL}\nRK9CLAUDE_WEBHOOK_TOKEN=${WEBHOOK_TOKEN}\n`);
    expect(
      readRk9claudeWebhookConfig({
        RK9CLAUDE_WEBHOOK_URL: "not a url",
        RK9_NOTIFY_WEBHOOK_ENV: file,
      }),
    ).toBeNull();
  });

  it("ignores a relative path, a directory and a missing file", () => {
    expect(readRk9claudeWebhookConfig({ RK9_NOTIFY_WEBHOOK_ENV: "webhook.env" })).toBeNull();
    expect(readRk9claudeWebhookConfig({ RK9_NOTIFY_WEBHOOK_ENV: dir })).toBeNull();
    expect(readRk9claudeWebhookConfig({ RK9_NOTIFY_WEBHOOK_ENV: path.join(dir, "none") })).toBeNull();
  });
});

describe("readRk9AlertMode", () => {
  const modeFile = () => path.join(dir, "notify-alert-mode");

  it("defaults to both", () => {
    expect(readRk9AlertMode({})).toBe("both");
    expect(readRk9AlertMode({ HOME: dir })).toBe("both");
  });

  it("lets the environment variable win, and only the word webhook switches", () => {
    writeFileSync(modeFile(), "webhook\n");
    const file = { RK9_NOTIFY_ALERT_MODE_FILE: modeFile() };
    expect(readRk9AlertMode({ ...file, RK9_NOTIFY_ALERT_MODE: "webhook" })).toBe("webhook");
    expect(readRk9AlertMode({ ...file, RK9_NOTIFY_ALERT_MODE: "both" })).toBe("both");
    expect(readRk9AlertMode({ ...file, RK9_NOTIFY_ALERT_MODE: "" })).toBe("both");
    expect(readRk9AlertMode({ ...file, RK9_NOTIFY_ALERT_MODE: "Webhook" })).toBe("both");
  });

  it("reads the first word of the switch file", () => {
    writeFileSync(modeFile(), "webhook # käännetty 15.11.\r\nboth\n");
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() })).toBe("webhook");
  });

  it("reads the switch file under HOME", () => {
    mkdirSync(path.join(dir, ".config/rk9"), { recursive: true });
    writeFileSync(path.join(dir, ".config/rk9/notify-alert-mode"), "webhook\n");
    expect(readRk9AlertMode({ HOME: dir })).toBe("webhook");
  });

  it("treats an empty file as both without a warning", () => {
    writeFileSync(modeFile(), "");
    const out = collect();
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
    expect(out.lines).toEqual([]);
  });

  it("warns about an unknown word and does not print the file content", () => {
    writeFileSync(modeFile(), "Webhook salainen-arvo\n");
    const out = collect();
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("tuntematon arvo");
    expect(out.lines[0]).not.toContain("salainen-arvo");
    expect(out.lines[0]).not.toContain("Webhook");
  });

  it("refuses a symlink, even one that points to a valid switch file", () => {
    const target = path.join(dir, "target");
    writeFileSync(target, "webhook\n");
    symlinkSync(target, modeFile());
    const out = collect();
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("ei ole ajajan oma tavallinen tiedosto");
  });

  it("refuses a directory", () => {
    const out = collect();
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: dir }, out.warn)).toBe("both");
    expect(out.lines).toHaveLength(1);
  });

  it("refuses a FIFO without waiting for a writer", () => {
    execFileSync("mkfifo", [modeFile()]);
    const out = collect();
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("ei ole ajajan oma tavallinen tiedosto");
  });

  it("refuses a file that another user owns", () => {
    writeFileSync(modeFile(), "webhook\n");
    const euid = process.geteuid?.() ?? 0;
    const spy = vi.spyOn(process, "geteuid").mockReturnValue(euid + 1);
    try {
      const out = collect();
      expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toContain("ei ole ajajan oma tavallinen tiedosto");
    } finally {
      spy.mockRestore();
    }
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() })).toBe("webhook");
  });

  it("strips only space and tab before the word, like the bash library", () => {
    writeFileSync(modeFile(), " \twebhook\n");
    expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() })).toBe("webhook");
    for (const prefix of ["\ufeff", "\f", "\u00a0"]) {
      writeFileSync(modeFile(), `${prefix}webhook\n`);
      const out = collect();
      expect(readRk9AlertMode({ RK9_NOTIFY_ALERT_MODE_FILE: modeFile() }, out.warn)).toBe("both");
      expect(out.lines).toHaveLength(1);
    }
  });
});

describe("readRk9AlertChannels", () => {
  it("collects mode, kill switch, host label and severity", () => {
    const base = { RK9_NOTIFY_ALERT_MODE_FILE: path.join(dir, "none") };
    const plain = readRk9AlertChannels({ ...base, HOME: dir }, TELEGRAM);
    expect(plain).toMatchObject({ telegram: TELEGRAM, webhook: null, mode: "both", legacy: false });
    expect(plain.host).toMatch(/^rk9-notify-[^.]+$/);
    expect(plain.severity).toBe("warning");

    const tuned = readRk9AlertChannels(
      {
        ...base,
        HOME: dir,
        RK9_NOTIFY_LEGACY: "1",
        RK9_NOTIFY_HOST: "rk9-notify-test",
        RK9_NOTIFY_SEVERITY: "critical",
        RK9CLAUDE_WEBHOOK_URL: WEBHOOK_URL,
        RK9CLAUDE_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      },
      null,
    );
    expect(tuned).toMatchObject({
      telegram: null,
      webhook: WEBHOOK,
      legacy: true,
      host: "rk9-notify-test",
      severity: "critical",
    });
  });

  it("honours the kill switch file", () => {
    const file = path.join(dir, "notify-legacy");
    const env = { RK9_NOTIFY_LEGACY_FILE: file, RK9_NOTIFY_ALERT_MODE: "both" };
    expect(readRk9AlertChannels(env, null).legacy).toBe(false);
    writeFileSync(file, "");
    expect(readRk9AlertChannels(env, null).legacy).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("never cuts a multi-byte character in half", () => {
    const text = "ä".repeat(10); // 20 bytes
    const cut = truncateUtf8(text, 7);
    expect(cut).toBe("äää");
    expect(Buffer.from(cut, "utf8").length).toBeLessThanOrEqual(7);
    expect(truncateUtf8("🔴🔴", 5)).toBe("🔴");
  });

  it("keeps a short text and repairs a lone surrogate", () => {
    expect(truncateUtf8("lyhyt", 100)).toBe("lyhyt");
    expect(truncateUtf8("a\ud83db", 100)).toBe("a�b");
  });
});

describe("buildAlertmanagerPayload", () => {
  const input = {
    key: KEY,
    message: MESSAGE,
    host: "rk9-notify-paperclip-01",
    severity: "warning",
    now: new Date("2026-11-15T10:00:00.123Z"),
  };

  it("builds the Alertmanager v4 shape that rk9claude accepts", () => {
    const payload = buildAlertmanagerPayload(input);
    const alert = payload.alerts[0];
    expect(payload).toMatchObject({
      version: "4",
      status: "firing",
      receiver: "rk9_notify",
      externalURL: "rk9_notify",
      groupLabels: { alertname: "PaperclipWebhookMonitor", host: "rk9-notify-paperclip-01" },
    });
    expect(alert.labels).toMatchObject({
      alertname: "PaperclipWebhookMonitor",
      host: "rk9-notify-paperclip-01",
      severity: "warning",
      source: "rk9_notify",
    });
    expect(alert.labels.instance).toMatch(/^delivery#[0-9a-f]{8}$/);
    expect(alert.fingerprint).toMatch(/^rk9n-[0-9a-f]{8}$/);
    expect(alert.annotations).toEqual({ summary: MESSAGE, description: MESSAGE });
    expect(alert.startsAt).toBe("2026-11-15T10:00:00Z");
    expect(alert.endsAt).toBe("0001-01-01T00:00:00Z");
    expect(payload.commonLabels).toEqual(alert.labels);
    expect(payload.groupKey).toBe(
      `rk9_notify:rk9-notify-paperclip-01:PaperclipWebhookMonitor:${alert.labels.instance}`,
    );
  });

  it("keeps instance and fingerprint for the same message and changes them for another", () => {
    const a = buildAlertmanagerPayload(input).alerts[0];
    const b = buildAlertmanagerPayload({ ...input, now: new Date("2026-11-15T11:00:00Z") }).alerts[0];
    const c = buildAlertmanagerPayload({ ...input, message: `${MESSAGE}!` }).alerts[0];
    expect(b.labels.instance).toBe(a.labels.instance);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.labels.instance).not.toBe(a.labels.instance);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it("uses the name as the instance when the key has no qualifier", () => {
    const alert = buildAlertmanagerPayload({ ...input, key: "PaperclipWebhookMonitor" }).alerts[0];
    expect(alert.labels.alertname).toBe("PaperclipWebhookMonitor");
    expect(alert.labels.instance).toMatch(/^PaperclipWebhookMonitor#[0-9a-f]{8}$/);
  });

  it("caps summary and description in bytes", () => {
    const alert = buildAlertmanagerPayload({ ...input, message: "ä".repeat(10_000) }).alerts[0];
    expect(Buffer.from(alert.annotations.summary, "utf8").length).toBe(3000);
    expect(Buffer.from(alert.annotations.description, "utf8").length).toBe(12_000);
  });
});

describe("sendRk9Alert", () => {
  const input = { key: KEY, message: MESSAGE };

  it("sends to the webhook and to Telegram in both mode", async () => {
    const fetchImpl = fakeFetch(ack);
    const out = collect();
    const res = await sendRk9Alert(input, channels(), { fetchImpl, ...out });
    expect(res).toMatchObject({ delivered: true, configured: true, webhook: "acked", telegram: "sent" });
    const calls = split(fetchImpl);
    expect(calls.webhook).toHaveLength(1);
    expect(calls.telegram).toHaveLength(1);
    expect(telegramText(calls.telegram[0])).toBe(MESSAGE);
  });

  it("puts the token in the Authorization header only", async () => {
    const fetchImpl = fakeFetch(ack);
    const out = collect();
    await sendRk9Alert(input, channels(), { fetchImpl, ...out });
    const [url, init] = split(fetchImpl).webhook[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${WEBHOOK_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(String(url)).not.toContain(WEBHOOK_TOKEN);
    expect(String(init.body)).not.toContain(WEBHOOK_TOKEN);
    const body = JSON.parse(String(init.body));
    expect(body.alerts[0].labels.alertname).toBe("PaperclipWebhookMonitor");
    expect(body.alerts[0].annotations.summary).toBe(MESSAGE);
    const logged = out.lines.join("\n");
    expect(logged).not.toContain(WEBHOOK_TOKEN);
    expect(logged).not.toContain(TG_TOKEN);
    expect(logged).not.toContain(WEBHOOK_URL);
  });

  it("skips Telegram in webhook mode when rk9claude acknowledges", async () => {
    const fetchImpl = fakeFetch(ack);
    const res = await sendRk9Alert(input, channels({ mode: "webhook" }), { fetchImpl, ...collect() });
    expect(res).toMatchObject({ delivered: true, webhook: "acked", telegram: "not_needed" });
    expect(split(fetchImpl).telegram).toHaveLength(0);
  });

  it("accepts a 200 with an empty body string as an acknowledgement", async () => {
    const fetchImpl = fakeFetch(() => new Response("", { status: 200 }));
    const res = await sendRk9Alert(input, channels({ mode: "webhook" }), { fetchImpl, ...collect() });
    expect(res).toMatchObject({ delivered: true, webhook: "acked" });
  });

  const rejections: Array<[string, () => Response | Promise<Response>, string]> = [
    ["503", () => new Response(null, { status: 503 }), "HTTP 503"],
    ["204 with no body", () => new Response(null, { status: 204 }), "HTTP 204"],
    ["201 with no body", () => new Response(null, { status: 201 }), "HTTP 201"],
    ["200 with a space", () => new Response(" ", { status: 200 }), "HTTP 200, odottamaton runko"],
    ["200 with a newline", () => new Response("\n", { status: 200 }), "HTTP 200, odottamaton runko"],
    ["401", () => new Response("unauthorized", { status: 401 }), "HTTP 401"],
    ["a redirect", () => new Response(null, { status: 302, headers: { Location: "http://x/" } }), "HTTP 302"],
    ["200 with a body", () => new Response("<html>proxy</html>", { status: 200 }), "HTTP 200, odottamaton runko"],
    [
      "a network error",
      () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
      "HTTP 000",
    ],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      "HTTP 000",
    ],
  ];
  for (const [name, webhook, reason] of rejections) {
    for (const mode of ["both", "webhook"] as const) {
      it(`falls back to Telegram on ${name} (${mode} mode)`, async () => {
        const fetchImpl = fakeFetch(webhook);
        const out = collect();
        const res = await sendRk9Alert(input, channels({ mode }), { fetchImpl, ...out });
        expect(res).toMatchObject({
          delivered: true,
          webhook: "failed",
          webhookReason: reason,
          telegram: "sent",
        });
        const calls = split(fetchImpl);
        expect(calls.telegram).toHaveLength(1);
        expect(telegramText(calls.telegram[0])).toBe(
          `${MESSAGE}\n\nVarareitti: rk9claude-webhook ei vastannut (${reason})`,
        );
        expect(out.lines.join("\n")).toContain("Varareitti: Telegram");
      });
    }
  }

  it("treats a body that breaks after the 200 headers as not acknowledged", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const fetchImpl = fakeFetch(() => new Response(broken, { status: 200 }));
    const res = await sendRk9Alert(input, channels({ mode: "webhook" }), { fetchImpl, ...collect() });
    expect(res).toMatchObject({
      delivered: true,
      webhook: "failed",
      webhookReason: "HTTP 200, vastaus katkesi",
      telegram: "sent",
    });
  });

  it("never logs the token when the network error echoes it", async () => {
    const fetchImpl = fakeFetch(() => {
      throw Object.assign(new TypeError(`fetch failed: Bearer ${WEBHOOK_TOKEN} ${WEBHOOK_URL}`), {
        cause: { code: WEBHOOK_TOKEN },
      });
    });
    const out = collect();
    await sendRk9Alert(input, channels(), { fetchImpl, ...out });
    const logged = out.lines.join("\n");
    expect(logged).toContain("WARN: rk9claude-webhook: pyyntö epäonnistui");
    expect(logged).not.toContain(WEBHOOK_TOKEN);
    expect(logged).not.toContain(WEBHOOK_URL);
    expect(telegramText(split(fetchImpl).telegram[0])).not.toContain(WEBHOOK_TOKEN);
  });

  it("sends to Telegram without a fallback line when the webhook is not configured", async () => {
    const fetchImpl = fakeFetch(ack);
    const res = await sendRk9Alert(input, channels({ webhook: null }), { fetchImpl, ...collect() });
    expect(res).toMatchObject({ delivered: true, webhook: "unconfigured", telegram: "sent" });
    const calls = split(fetchImpl);
    expect(calls.webhook).toHaveLength(0);
    expect(telegramText(calls.telegram[0])).toBe(MESSAGE);
  });

  it("reports an undelivered alert when the webhook and Telegram both fail", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(null, { status: 503 }),
      () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    const out = collect();
    const res = await sendRk9Alert(input, channels(), { fetchImpl, ...out });
    expect(res).toMatchObject({ delivered: false, configured: true, webhook: "failed", telegram: "failed" });
    expect(out.lines.join("\n")).toContain("webhook ja Telegram epäonnistuivat");
  });

  // An hourly retry would post the same alert to rk9claude every hour while
  // Telegram is down, so the acknowledgement starts the caller's throttle.
  it("counts a webhook acknowledgement as a delivery in both mode when Telegram fails", async () => {
    const fetchImpl = fakeFetch(ack, () => new Response(JSON.stringify({ ok: false }), { status: 500 }));
    const out = collect();
    const res = await sendRk9Alert(input, channels(), { fetchImpl, ...out });
    expect(res).toMatchObject({ delivered: true, webhook: "acked", telegram: "failed" });
    expect(out.lines.join("\n")).toContain("Telegram epäonnistui, mutta rk9claude kuittasi");
    expect(shouldRecordAlert(res)).toBe(true);
  });

  it("counts the acknowledgement when Telegram is not configured at all", async () => {
    const fetchImpl = fakeFetch(ack);
    const res = await sendRk9Alert(input, channels({ telegram: null }), { fetchImpl, ...collect() });
    expect(res).toMatchObject({ delivered: true, configured: true, webhook: "acked", telegram: "skipped" });
  });

  it("is undelivered but configured when only a failing webhook exists", async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 503 }));
    const out = collect();
    const res = await sendRk9Alert(input, channels({ telegram: null, mode: "webhook" }), {
      fetchImpl,
      ...out,
    });
    expect(res).toMatchObject({ delivered: false, configured: true, webhook: "failed", telegram: "skipped" });
    expect(out.lines.join("\n")).toContain("eikä Telegramia ole määritetty");
  });

  it("is log-only when no channel is configured", async () => {
    const fetchImpl = fakeFetch(ack);
    const res = await sendRk9Alert(input, channels({ telegram: null, webhook: null }), {
      fetchImpl,
      ...collect(),
    });
    expect(res).toMatchObject({ delivered: false, configured: false, webhook: "unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends straight to Telegram when the kill switch is on", async () => {
    const fetchImpl = fakeFetch(ack);
    const res = await sendRk9Alert(input, channels({ legacy: true, mode: "webhook" }), {
      fetchImpl,
      ...collect(),
    });
    expect(res).toMatchObject({ delivered: true, webhook: "skipped", telegram: "sent" });
    const calls = split(fetchImpl);
    expect(calls.webhook).toHaveLength(0);
    expect(telegramText(calls.telegram[0])).toBe(MESSAGE);
  });

  it("sends an alert with an invalid key to Telegram instead of dropping it", async () => {
    const fetchImpl = fakeFetch(ack);
    const out = collect();
    const res = await sendRk9Alert({ key: "bad key!", message: MESSAGE }, channels({ mode: "webhook" }), {
      fetchImpl,
      ...out,
    });
    expect(res).toMatchObject({ delivered: true, webhook: "skipped", telegram: "sent" });
    expect(split(fetchImpl).webhook).toHaveLength(0);
    expect(out.lines.join("\n")).toContain("virheellinen avain");
  });

  it("keeps the fallback line when the message is longer than the Telegram limit", async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 503 }));
    await sendRk9Alert({ key: KEY, message: "x".repeat(5000) }, channels(), {
      fetchImpl,
      ...collect(),
    });
    const text = telegramText(split(fetchImpl).telegram[0]);
    expect(text.length).toBeLessThan(3500);
    expect(text.endsWith("Varareitti: rk9claude-webhook ei vastannut (HTTP 503)")).toBe(true);
  });
});

describe("shouldRecordAlert", () => {
  it("marks a delivered alert", () => {
    expect(shouldRecordAlert({ delivered: true, configured: true })).toBe(true);
  });

  it("does not mark an alert that reached no configured channel", () => {
    expect(shouldRecordAlert({ delivered: false, configured: true })).toBe(false);
  });

  it("keeps the log-only monitor on its throttle when no channel is configured", () => {
    expect(shouldRecordAlert({ delivered: false, configured: false })).toBe(true);
  });

  it("follows the send result end to end", async () => {
    const down = fakeFetch(
      () => new Response(null, { status: 503 }),
      () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
    );
    const input = { key: KEY, message: MESSAGE };
    expect(shouldRecordAlert(await sendRk9Alert(input, channels(), { fetchImpl: down, ...collect() }))).toBe(false);
    const none = await sendRk9Alert(input, channels({ telegram: null, webhook: null }), {
      fetchImpl: down,
      ...collect(),
    });
    expect(shouldRecordAlert(none)).toBe(true);
  });
});
