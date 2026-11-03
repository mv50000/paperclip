// RK9-710: io-watch.sh sends its ALERT lines to Telegram. The script runs with
// fake iostat and curl binaries on PATH, so no request leaves the test.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/io-watch.sh", import.meta.url));
const TOKEN = "123456:AAH-secret_token-value";

// iostat -x device row: field 6 = r_await, field 12 = w_await, NF-1 = aqu, NF = util.
const FAKE_IOSTAT = `#!/bin/bash
n=$(cat "$FAKE_DIR/iostat.count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$FAKE_DIR/iostat.count"
v=$(sed -n "\${n}p" "$FAKE_DIR/awaits"); v=\${v:-1}
echo "nvme0n1 1 2 3 4 $v 6 7 8 9 10 $v 12 13 14 15 16 17 18 0.5 42"
`;

const FAKE_CURL = `#!/bin/bash
{ printf '%s\\n' "$@"; echo '---'; } >>"$FAKE_DIR/curl.argv"
{ cat; echo '---'; } >>"$FAKE_DIR/curl.stdin"
env >>"$FAKE_DIR/curl.env"
printf '%s' "\${FAKE_CURL_RESPONSE:-{\\"ok\\":true}}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(awaits: number[], env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "io-watch-tg-"));
  dirs.push(dir);
  for (const [name, body] of [["iostat", FAKE_IOSTAT], ["curl", FAKE_CURL]]) {
    writeFileSync(path.join(dir, name), body);
    chmodSync(path.join(dir, name), 0o755);
  }
  writeFileSync(path.join(dir, "awaits"), `${awaits.join("\n")}\n`);
  const log = path.join(dir, "io-watch.log");
  const res = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_DIR: dir,
      IO_WATCH_LOG: log,
      IO_WATCH_WARN_AWAIT: "200",
      IO_WATCH_WARN_CONSEC: "2",
      IO_WATCH_OK_CONSEC: "2",
      IO_WATCH_REMIND: "1800",
      IO_WATCH_MAX_SAMPLES: String(awaits.length),
      ...env,
    },
  });
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : "");
  const calls = read("curl.argv").split("---\n").filter(Boolean);
  return { res, log: readFileSync(log, "utf8"), calls, stdin: read("curl.stdin"), curlEnv: read("curl.env") };
}

// 5 pressure samples, then 3 OK samples: one WARN alert and one recovery.
const EPISODE = [500, 500, 500, 500, 500, 1, 1, 1];

describe("io-watch.sh Telegram delivery", () => {
  it("sends one message per ALERT line and keeps the token out of argv, env and log", () => {
    const r = run(EPISODE, { TG_BOT_TOKEN: TOKEN, TG_CHAT_ID: "440715827" });
    expect(r.res.status).toBe(0);
    expect(r.log.match(/ALERT:/g)).toHaveLength(2);
    // The throttle holds: three more pressure samples inside REMIND send nothing.
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toContain("text=🔴");
    expect(r.calls[0]).toContain("levy-IO-paine");
    expect(r.calls[0]).toContain("Loki: ");
    expect(r.calls[1]).toContain("palautui normaaliksi");
    expect(r.calls.join("")).toContain("chat_id=440715827");
    expect(r.stdin).toContain(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"`);
    expect(r.calls.join("")).not.toContain(TOKEN);
    expect(r.curlEnv).not.toContain(TOKEN);
    expect(r.log).not.toContain(TOKEN);
    expect(r.log).not.toContain("WARN:");
  });

  it("logs one WARN line and sends nothing when the token is missing", () => {
    const r = run(EPISODE, { TG_CHAT_ID: "440715827" });
    expect(r.res.status).toBe(0);
    expect(r.log.match(/WARN: TG_BOT_TOKEN tai TG_CHAT_ID puuttuu/g)).toHaveLength(1);
    expect(r.log.match(/ALERT:/g)).toHaveLength(2);
    expect(r.calls).toHaveLength(0);
  });

  it("treats a malformed token as missing", () => {
    const r = run(EPISODE, { TG_BOT_TOKEN: 'x"\nurl = "http://evil', TG_CHAT_ID: "1" });
    expect(r.calls).toHaveLength(0);
    expect(r.log).toContain("WARN: TG_BOT_TOKEN tai TG_CHAT_ID puuttuu");
  });

  it("logs a send failure without the token and keeps sampling", () => {
    const r = run(EPISODE, {
      TG_BOT_TOKEN: TOKEN,
      TG_CHAT_ID: "440715827",
      FAKE_CURL_EXIT: "0",
      FAKE_CURL_RESPONSE: `{"ok":false,"description":"Unauthorized bot${TOKEN}"}`,
    });
    expect(r.res.status).toBe(0);
    const warns = r.log.match(/WARN: Telegram-lähetys epäonnistui[^\n]*/g) ?? [];
    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain("Unauthorized");
    expect(r.log).not.toContain(TOKEN);
    // Every sample still produced its log row after the failed sends.
    expect(r.log.match(/^\S+ \S+  r_await=/gm)).toHaveLength(EPISODE.length);
  });

  it("logs the curl exit code on a network failure", () => {
    const r = run(EPISODE.slice(0, 3), {
      TG_BOT_TOKEN: TOKEN,
      TG_CHAT_ID: "440715827",
      FAKE_CURL_EXIT: "7",
      FAKE_CURL_RESPONSE: "",
    });
    expect(r.res.status).toBe(0);
    expect(r.log).toContain("WARN: Telegram-lähetys epäonnistui (curl exit 7)");
  });
});
