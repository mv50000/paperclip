import { describe, expect, it, vi } from "vitest";
import {
  readTelegramAlertConfig,
  redactToken,
  sendTelegramAlert,
} from "./ops-telegram-alert.js";

const TOKEN = "123456:AAH-secret_token-value";
const CONFIG = { token: TOKEN, chatId: "440715827" };

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function collect() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) };
}

describe("readTelegramAlertConfig", () => {
  it("returns null when the token or chat id is missing", () => {
    expect(readTelegramAlertConfig({})).toBeNull();
    expect(readTelegramAlertConfig({ TG_BOT_TOKEN: TOKEN })).toBeNull();
    expect(readTelegramAlertConfig({ TG_CHAT_ID: "1" })).toBeNull();
  });

  it("rejects malformed values instead of building a URL from them", () => {
    expect(readTelegramAlertConfig({ TG_BOT_TOKEN: "123:abc/../x", TG_CHAT_ID: "1" })).toBeNull();
    expect(readTelegramAlertConfig({ TG_BOT_TOKEN: TOKEN, TG_CHAT_ID: "@channel" })).toBeNull();
  });

  it("trims and accepts well-formed values", () => {
    expect(
      readTelegramAlertConfig({ TG_BOT_TOKEN: ` ${TOKEN} `, TG_CHAT_ID: "-100123 " }),
    ).toEqual({ token: TOKEN, chatId: "-100123" });
  });
});

describe("sendTelegramAlert", () => {
  it("is a no-op without config", async () => {
    const fetchImpl = vi.fn();
    const out = collect();
    expect(await sendTelegramAlert(null, "x", { fetchImpl, ...out })).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.lines).toEqual([]);
  });

  it("posts chat id and text as JSON and never logs the token", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const out = collect();
    const res = await sendTelegramAlert(CONFIG, "🔴 vika", { fetchImpl, ...out });
    expect(res).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ chat_id: "440715827", text: "🔴 vika" });
    expect(String(init.body)).not.toContain(TOKEN);
    expect(out.lines.join("\n")).not.toContain(TOKEN);
  });

  it("reports an API rejection without throwing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), {
          status: 401,
        }),
    );
    const out = collect();
    expect(await sendTelegramAlert(CONFIG, "x", { fetchImpl, ...out })).toBe("failed");
    expect(out.lines).toEqual(["WARN: Telegram-lähetys epäonnistui: HTTP 401 (Unauthorized)"]);
  });

  it("redacts the token from a network error that echoes the URL", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const out = collect();
    expect(await sendTelegramAlert(CONFIG, "x", { fetchImpl, ...out })).toBe("failed");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("WARN: Telegram-lähetys epäonnistui");
    expect(out.lines[0]).toContain("<redacted>");
    expect(out.lines[0]).not.toContain(TOKEN);
  });

  it("truncates texts that exceed the Telegram limit", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await sendTelegramAlert(CONFIG, "x".repeat(5000), { fetchImpl, ...collect() });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text.length).toBeLessThan(4096);
  });
});

describe("redactToken", () => {
  it("replaces every occurrence", () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a <redacted> b <redacted>");
  });
});
