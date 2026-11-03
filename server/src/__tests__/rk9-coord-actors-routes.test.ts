// RK9 Custom (RK9-625): coord presence API. Auth and company scope, 422
// validation, idempotent upsert, the TTL death rule with an injected clock,
// the read-only heartbeat_runs projection and phase redaction (RK9-549
// fixtures). Contract: docs/implementation-notes/coord-bus.md ("Presence API").
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  rk9CoordActors,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { isRk9CoordCredentialName, rk9CoordMetadataHasSecret } from "../routes/rk9-coord-actors.js";
import {
  RK9_COORD_SECRET_RX_DEFAULT,
  collapseRk9CoordText,
  redactRk9CoordText,
  rk9CoordMatchText,
  toRk9CoordLine,
} from "../services/rk9-coord-text.js";
import { rk9CoordPresenceService } from "../services/rk9-coord-presence.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * The RK9-673 client copy of the filter, derived from the server default step by step. With
 * `rk9678`, the long sk- value also stops before the RK9-678 keywords (claude-config#205).
 */
const RK9_673_SK_STOP = "(?!token|secret|passw|api[_-]?key|apikey)";
const RK9_678_SK_STOP =
  "(?!token|secret|passw|passphrase|private[_-]?key|credential|api[_-]?key|apikey|(?<![A-Za-z])pw[\"']?\\s*[=:]|(?<![A-Za-z])pass[\"']?\\s*=)";
function rk9673ClientVariant(rk9678 = false): string {
  const steps: Array<[string, string]> = [
    ["|qmk_|sk-|", "|qmk_|(?<![A-Za-z0-9_])sk-|"],
    ["[A-Za-z0-9_-]{6,}|AKIA", `[A-Za-z0-9_-]{6,}|sk-(?=[A-Za-z_-]{0,64}[0-9])(?:${rk9678 ? RK9_678_SK_STOP : RK9_673_SK_STOP}[A-Za-z0-9_-]){20,}|AKIA`],
    [
      "|(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}",
      "|(bearer|basic)\\s+(?=[A-Za-z]{0,19}[0-9._~+/=-]|[A-Za-z]{20})[A-Za-z0-9._~+/=-]{8,}" +
        "|authorization[\"']?\\s*(:|=>?)\\s*[\"']?(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{4,}",
    ],
  ];
  let rx = RK9_COORD_SECRET_RX_DEFAULT;
  for (const [from, to] of steps) {
    if (!rx.includes(from)) throw new Error(`RK9-673 step does not apply: ${from}`);
    rx = rx.replace(from, to);
  }
  return rx;
}

describe("coord redaction (RK9_SESSIONS_SECRET_RX port)", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("matches the bash default copied from rk9-sessions.sh", async () => {
    // RK9-678: RK9_SESSIONS_SH points the check at a claude-config checkout.
    const path = process.env.RK9_SESSIONS_SH || `${process.env.HOME}/.claude/bin/rk9-sessions.sh`;
    const script = await readFile(path, "utf8").catch(() => null);
    if (!script) return; // claude-config is not on CI; the fixtures below still pin the behaviour.
    const line = script.split("\n").find((l) => l.startsWith("export RK9_SESSIONS_SECRET_RX="));
    expect(line).toBeDefined();
    const quoted = line!.slice(line!.indexOf(":-'") + 3, line!.lastIndexOf("'}"));
    // RK9-673: claude-config loosened the client copy (sk- word boundary, bearer/basic value needs a
    // non-letter or 20+ letters, plus a 20+ sk- key with a digit that stops before a keyword, and quoted
    // Authorization forms). The server copy stays stricter on purpose. The old client copy or exactly one
    // of these variants (RK9-673, or RK9-673 with the RK9-678 sk- stop list) passes.
    expect([RK9_COORD_SECRET_RX_DEFAULT, rk9673ClientVariant(), rk9673ClientVariant(true)]).toContain(
      quoted.replaceAll(`'"'"'`, "'"),
    );
  });

  it("derives the RK9-673 client variant from the server default (every step applies)", () => {
    expect(rk9673ClientVariant()).not.toBe(RK9_COORD_SECRET_RX_DEFAULT);
    expect(rk9673ClientVariant(true)).not.toBe(rk9673ClientVariant());
  });

  it.each([
    // RK9-549 (rk9-sessions-test.sh)
    ["Korjaa login-bugi token=supersecret123", "Korjaa login-bugi [redacted]"],
    // pcp-headsup-test.sh B1-B1d
    ["Avain ghp_abc vuotaa", "Avain ghp_abc vuotaa"],
    ["Avain ghp_abcdefgh123 vuotaa", "Avain [redacted] vuotaa"],
    // Fake values are split so the repo secret scan does not flag the fixtures.
    [`Bearer abcdefghijk ja ${"sk_" + "live_"}51Habcdefgh`, "[redacted] ja [redacted]"],
    ["API_KEY ja token budget mainitaan vakiasti", "API_KEY ja token budget mainitaan vakiasti"],
    // case-insensitive, like re.I
    ["PASSWORD: hunter2hunter2 ok", "[redacted] ok"],
    ["clone https://user:pa55word@github.com/x", "clone https[redacted]github.com/x"],
    [`${"AKIA" + "ABCDEFGHIJ"}KLMNOP leaked`, "[redacted] leaked"],
    // the bus's own token is always redacted
    ["coord rk9_coord_AbCdEfGhIjKlMnOp", "coord [redacted]"],
    // plural keyword forms (verifier round 4)
    ["tokens=abcdefghijkl ok", "[redacted] ok"],
    ["passwords: hunter2hunter2", "[redacted]"],
  ])("redacts %j", (input, expected) => {
    expect(redactRk9CoordText(input, env)).toBe(expected);
  });

  it.each([
    // C0 controls that JS \s misses must not hide a secret (verifier round 1).
    ["Bearer\u0001abcdefghijklmnop", "[redacted]"],
    ["token\u0001=\u0001supersecret123", "[redacted]"],
    ["password\u0002:hunter2hunter2", "[redacted]"],
    ["Bearer\u001fabcdefghijk", "[redacted]"],
    // zero-width characters are removed before matching
    ["token\u200b=supersecret123", "[redacted]"],
    ["Bear\ufeffer abcdefghijkl", "[redacted]"],
  ])("collapses control characters before redacting %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it("collapses to one line, caps at 140 code points and redacts before the cap", () => {
    expect(toRk9CoordLine("  a\n\tb  ", 140, env)).toBe("a b");
    expect(toRk9CoordLine("   ", 140, env)).toBeNull();
    expect(toRk9CoordLine("x".repeat(500), 140, env)).toHaveLength(140);
    expect(Array.from(toRk9CoordLine("😀".repeat(200), 140, env)!)).toHaveLength(140);
    const secretAtCap = `${"y".repeat(130)} ghp_abcdefghijklmnop`;
    expect(toRk9CoordLine(secretAtCap, 140, env)).not.toContain("ghp_");
  });

  // RK9-642: the full invisible list; ZWJ stays in display text, goes for matching.
  it.each([
    ["token=\u00adsupersecret123", "[redacted]"],
    ["pass\u00adword=hunter2hunter2", "[redacted]"],
    ["pass\u2061word=hunter2hunter2", "[redacted]"],
    ["pass\u2064word=hunter2hunter2", "[redacted]"],
    ["pass\u180eword=hunter2hunter2", "[redacted]"],
    ["pass\u034fword=hunter2hunter2", "[redacted]"],
    // a secret only a matching reading finds: the whole field goes (fail closed)
    ["pass\u200dword=hunter2hunter2 ok", "[redacted]"],
    // verifier round 2: each reading finds a different secret
    ["pass\u200dword=hunter2hunter2 Bearer\u200bopaqueTokenValue123", "[redacted]"],
    ["Bearer\u202e abcdefghijkl", "[redacted]"],
    // verifier round 1 (RK9-642): an invisible character as the only separator, non-Cf fillers
    ["Bearer\u200babcdefgh12345", "[redacted]"],
    // RK9-641: a text with invisible characters and a secret fails closed as a whole
    ["ok\u200bfine token=\u00adsupersecret123", "[redacted]"],
    ["pass\u3164word=hunter2hunter2", "[redacted]"],
    ["pass\u0301word=hunter2hunter2", "[redacted]"],
    ["pass\u{E0100}word=hunter2hunter2", "[redacted]"],
  ])("redacts a keyword split by an invisible character %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  // RK9-665 M1: a decoy [redacted] must not balance a secret only a matching reading finds.
  it.each([
    ["[re\u200bdacted] Bearer\u200bopaqueTokenValue123", "[redacted]"],
    ["[redacted\u200c] Bearer\u200bopaqueTokenValue123", "[redacted]"],
    ["[re\u200bdacted] [re\u200bdacted] Bearer\u200bopaqueTokenValue123 Basic\u200bdXNlcjpwYXNzd29yZA", "[redacted]"],
    ["note [redacted] Bearer\u200bopaqueTokenValue123", "[redacted]"],
    // L3: a tab inside a URL credential only matches the raw text
    ["https://user:\thunter2@host", "https[redacted]host"],
    ["clone https://user:\thunter2@host now", "clone https[redacted]host now"],
  ])("redacts a secret behind a decoy or a raw-only match %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it.each([
    "working on RK9-665 tests",
    "coding \u{1F469}\u200d\u{1F4BB} now",
    "caf\u0065\u0301 break",
    "already [redacted] in the text",
  ])("keeps clean text unchanged %j", (input) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(input);
  });

  it("keeps ZWJ in display text and strips it only for matching", () => {
    const dev = "coding \u{1F469}\u200d\u{1F4BB} now";
    expect(toRk9CoordLine(dev, 140, env)).toBe(dev);
    expect(toRk9CoordLine("\u200d", 140, env)).toBeNull();
    expect(collapseRk9CoordText("a\u00adb\u2061c\u180ed\u034fe\u200df\u200bg")).toBe("abcde\u200dfg");
    expect(rk9CoordMatchText("a\u00adb\u2061c\u180ed\u034fe\u200df\u202eg")).toBe("abcdefg");
  });

  it("falls back to the default when the env pattern is not a valid JS RegExp", () => {
    expect(redactRk9CoordText("token=supersecret123", { RK9_SESSIONS_SECRET_RX: "(" } as NodeJS.ProcessEnv)).toBe(
      "[redacted]",
    );
  });
});

// RK9-642: the RK9-625 round-5 verifier cases. Fake values only, split so
// the gitleaks gate does not read them as real keys.
const FAKE_HEX = "6a174c20" + "f6dea53c";
const FAKE_LONG = FAKE_HEX + "74d26018" + "fcceff64" + "abcd1234";
const FAKE_UUID = "6a174c20" + "-f6de-a53c-74d2-" + "6018fcceff64";
const FAKE_TOK_ID = "tok_" + "abcdef123";
const FAKE_OPAQUE = "abcdef" + "123456";

describe("presence metadata secret check", () => {
  it.each([
    "password", "passwords", "PassWords", "secret", "secrets", "github_token", "githubToken", "DB_PASSWORD",
    "api_key", "api-keys", "apiKey", "myApiKey", "passwd", "secret_value", "aws.secret", "pass\u00adword",
    // compound names (verifier round 1): the keyword need not end the name
    "SECRET_KEY", "aws_secret_access_key", "secretAccessKey", "api_key_prod", "apiKeyProd", "GITHUB_TOKEN_RW",
    "token_prod", "password_new", "password1", "secrets_prod", "password_hash", "DBPassword", "GITHUBToken",
    "Password:", "secret_id", "VAULT_SECRET_ID", "secretId",
    // RK9-665: one-word compounds and private + key
    "secretkey", "SECRETKEY", "private_key", "privateKey", "passphrase", "password_id",
  ])("treats %j as a credential name", (name) => {
    expect(isRk9CoordCredentialName(name)).toBe(true);
  });

  it.each([
    "tokens_used", "token_count", "secret_scan", "tokenizer", "secretary", "password_policy", "tokensUsed", "note",
    "token_type", "secret_name", "access_token_expiry", "max_tokens_limit",
    // RK9-665 L2: the id of a token or an API key names it, it is not the credential
    "token_id", "last_token_id", "tokenId", "api_key_id", "private_key_path",
  ])("does not treat %j as a credential name", (name) => {
    expect(isRk9CoordCredentialName(name)).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    // round-4 repro
    ["array under a credential key", { password: ["hunter2hunter2"] }],
    ["nested object under secret", { secret: { db: "hunter2hunter2" } }],
    ["nested object under secrets", { secrets: { db: "hunter2hunter2" } }],
    ["nested object under passwords", { passwords: { prod: "hunter2hunter2" } }],
    ["array under api_key", { api_key: ["abcdef123456"] }],
    ["ZWSP inside a keyword in a value", { a: "pass\u200bword=hunter2hunter2" }],
    // zero-width list (LOW)
    ["ZWSP inside a key", { "pass\u200bword": ["hunter2hunter2"] }],
    ["soft hyphen inside a key", { "pass\u00adword": "hunter2hunter2" }],
    ["invisible separator inside a key", { "pass\u2063word": "hunter2hunter2" }],
    ["CGJ inside a key", { "pass\u034fword": "hunter2hunter2" }],
    ["ZWJ inside a key", { "pass\u200dword": "hunter2hunter2" }],
    // secret used as a key (LOW)
    ["secret as a key under a credential key", { password: { hunter2hunter2: true } }],
    ["secret as a key with an empty value", { secrets: { hunter2hunter2: {} } }],
    // keyword given as a value (MEDIUM)
    ["name/value pair object", { env: [{ name: "PASSWORD", value: "hunter2hunter2" }] }],
    ["key/val pair object", { headers: [{ key: "api_key", val: "abcdef123456" }] }],
    ["two-item tuple in a list", { env: [["DB_PASSWORD", "hunter2hunter2"]] }],
    ["two-item tuple", { env: ["DB_PASSWORD", "hunter2hunter2"] }],
    ["camelCase key", { githubToken: "abcdefghijkl" }],
    ["deep arrays under a mixed-case key", { PassWords: [[["hunter2hunter2"]]] }],
    ["leading space in the value", { password: " hunter2hunter2" }],
    ["ZWSP after Bearer", { note: "Bearer\u200b abcdefghijkl" }],
    ["numeric password sent as a string", { password: "12345678" }],
    // verifier round 1 (RK9-642)
    ["SECRET_KEY", { SECRET_KEY: "django-insecure-abc123xyz" }],
    ["aws_secret_access_key", { aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE" }],
    ["secrets_prod nested", { secrets_prod: { db: "hunter2hunter2" } }],
    ["acronym camelCase in a pair", { env: [{ name: "DBPassword", value: "hunter2hunter2" }] }],
    ["trailing punctuation in a pair name", { env: [{ name: "Password:", value: "hunter2hunter2" }] }],
    ["CloudFormation parameter", { params: [{ ParameterKey: "DbPassword", ParameterValue: "hunter2hunter2" }] }],
    ["k/v pair", { env: [{ k: "PASSWORD", v: "hunter2hunter2" }] }],
    ["name, separator, value", { env: [["DB_PASSWORD", "=", "hunter2hunter2"]] }],
    ["argv flag", { args: ["mysql", "--password", "hunter2hunter2"] }],
    ["invisible character as the only separator", { note: "Bearer\u200babcdefgh12345" }],
    ["Hangul filler inside a keyword", { note: "pass\u3164word=hunter2hunter2" }],
    // verifier round 2
    ["Vault AppRole secret_id", { vault: { role_id: "abc", secret_id: "6a174c20" + "-f6de-a53c-74d2-6018fcceff64" } }],
    ["SECRET_KEY given as a pair name", { env: [{ name: "SECRET_KEY", value: "django-insecure-abc123xyz" }] }],
    // RK9-665 M2: value-side names where the credential word is not last
    ["GITHUB_TOKEN_RW as a pair name", { env: [{ name: "GITHUB_TOKEN_RW", value: FAKE_HEX }] }],
    ["API_KEY_PROD as a pair name", { env: [{ name: "API_KEY_PROD", value: FAKE_HEX }] }],
    ["PASSWORD1 as a pair name", { env: [{ name: "PASSWORD1", value: FAKE_HEX }] }],
    ["PASSWORD_HASH as a pair name", { env: [{ name: "PASSWORD_HASH", value: FAKE_HEX }] }],
    ["VAULT_SECRET_ID as a pair name", { env: [{ name: "VAULT_SECRET_ID", value: FAKE_HEX }] }],
    ["DB PASSWORD as a pair name", { env: [{ name: "DB PASSWORD", value: FAKE_HEX }] }],
    ["SECRET_ID tuple", { a: [["SECRET_ID", FAKE_HEX]] }],
    ["--token-value flag", { argv: ["--token-value", FAKE_HEX] }],
    ["short value after a credential flag", { argv: ["claude", "--secret", "foo"] }],
    ["SECRETKEY as a pair name", { env: [{ name: "SECRETKEY", value: FAKE_HEX }] }],
    ["passphrase as a pair name", { env: [{ name: "PASSPHRASE", value: FAKE_HEX }] }],
    ["Authorization header pair", { h: { name: "Authorization", value: FAKE_HEX } }],
    ["private_key key", { private_key: FAKE_HEX }],
    // Each RK9-665 exemption keeps rejecting the real secret it sits next to.
    // L1 vocabulary exemption (bare lower-case name, lower-case word value):
    ["upper-case name in a two-item list", { env: ["PASSWORD", "hunter2hunter2"] }],
    ["bare name, value with digits", { tags: ["password", "hunter2hunter2"] }],
    ["bare name, hex value", { tags: ["secret", FAKE_HEX] }],
    ["bare name, mixed-case value", { tags: ["secret", "AbCdEfGhIjKlMn"] }],
    ["bare name, long lower-case passphrase", { tags: ["password", "correcthorsebatterystaple"] }],
    ["bare name in a pair object, value with digits", { env: [{ name: "password", value: "hunter2hunter2" }] }],
    ["plural name in a pair object, hex value", { name: "tokens", value: FAKE_HEX }],
    ["upper-case plural name in a pair object", { name: "TOKENS", value: "unlimited" }],
    // RK9-665 verifier round 1: the word mode is a known-word list, not a shape
    ["bare name, lower-case passphrase", { tags: ["password", "correct-horse-battery-staple"] }],
    ["bare name, dictionary password", { tags: ["password", "sunshine"] }],
    ["bare singular name in a pair object, lower-case value", { env: [{ name: "password", value: "hunterhunter" }] }],
    ["bare singular name in a pair object, known word", { field: { name: "password", value: "enabled" } }],
    ["bare name, separator, lower-case value", { argv: ["secret", "=", "hunterhunter"] }],
    ["bare plural name, separator", { argv: ["tokens", "=", "hunterhunter"] }],
    ["key/value pair with a bare singular name", { key: "secret", value: "abcdefghijkl" }],
    ["object under a bare name pair", { name: "password", value: { data: "trustnoone" } }],
    ["array under a bare name pair", { name: "password", value: ["trustnoone"] }],
    ["secret as a key under a bare name pair", { name: "password", value: { trustnoone: true } }],
    ["passphrase pair, lower-case value", { name: "passphrase", value: "correct-horse-battery-staple" }],
    ["plural pair name, unknown word", { name: "tokens", value: "hunterhunter" }],
    ["known word with a tag character", { tags: ["secret", "important\u{E0041}"] }],
    ["unknown word with a combining mark", { tags: ["secret", "hunter\u0332hunter"] }],
    // L2 id exemption (token_id: prefixed id, digits or UUID):
    ["mixed-case token_id", { token_id: "s3cr3tP4" + "ssw0rdXYZ12345" }],
    ["mixed-case api_key_id", { api_key_id: "AbC123xyz7" + "89QwE456rtY0" }],
    ["lower-case alphanumeric token_id", { last_token_id: "abc123def" }],
    ["array under token_ids", { token_ids: ["a1B2c3D4e5" + "F6g7H8i9J0k"] }],
    ["object under token_id", { token_id: { inner: "a1B2c3D4e5" + "F6g7H8i9J0k" } }],
    ["secret as a key under token_id", { token_id: { ["a1B2c3D4e5" + "F6g7H8i9J0k"]: true } }],
    ["upper-case UUID under token_id", { token_id: FAKE_UUID.toUpperCase() }],
    ["long opaque token_id", { token_id: FAKE_LONG }],
    ["long opaque TOKEN_ID pair", { env: [{ name: "TOKEN_ID", value: FAKE_LONG }] }],
    ["GitHub token under token_id", { token_id: "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["secret_id stays strict", { secret_id: FAKE_TOK_ID }],
    // L2 count exemption (count string under a plural tokens key):
    ["numeric string under a singular token key", { token: "123456789" }],
    ["password under a token-count key", { tokens: { password: "12345678" } }],
    ["opaque string under a token-count key", { tokens: FAKE_OPAQUE }],
    ["digits and letters under a token-count key", { input_tokens: "123456abc" }],
    ["pair name inside a token-count key", { tokens: { name: "token", value: "83920144" } }],
    ["upper-case pair name inside a token-count key", { tokens: { name: "TOKEN", value: "83920144" } }],
    ["label pair name inside a token-count key", { tokens: { name: "API KEY", value: "839201447" } }],
    ["separator form inside a token-count key", { tokens: ["token", "=", "83920144"] }],
    ["tuple inside a token-count key", { tokens: [["token", "83920144"]] }],
    ["pair inside total_tokens", { total_tokens: { key: "token", value: "83920144" } }],
    ["nested numeric string under a token-count key", { input_tokens: { x: "1234567890123456" } }],
    ["count with a zero-width space", { tokens: "12345678\u200b9" }],
    ["long number with a unit", { tokens: "1234567k" }],
    // verifier round 2: no count masking inside a credential context
    ["count key under a password key", { password: { tokens: "83920144" } }],
    ["count key under a pair value", { name: "PASSWORD", value: { tokens: "83920144" } }],
    ["count key in a credential tuple", { env: ["DB_PASSWORD", { tokens: "83920144" }] }],
    ["count key that is also a pair value key", { name: "DB_PASSWORD", tokens_value: "83920144" }],
    ["long grouped digits", { tokens: "123_456_789_012_345_678_901_234" }],
    ["access_tokens is not a count key", { access_tokens: "12345678901234567890" }],
    ["recovery_tokens is not a count key", { recovery_tokens: "12345678" }],
    // verifier round 3: glued credential keys, pair objects, read/write
    ["count key under rootpassword", { rootpassword: { tokens: "83920144" } }],
    ["count key under dbpassword", { dbpassword: { input_tokens: "83920144" } }],
    ["count key under authtoken", { authtoken: { tokens: "83920144" } }],
    ["count key in an array under githubtoken", { githubtoken: [{ tokens: "83920144" }] }],
    ["count key beside a pair name", { name: "DB_PASSWORD", tokens: "83920144" }],
    ["count key beside a key name", { key: "API_KEY", input_tokens: "83920144" }],
    ["write_tokens is not a count key", { write_tokens: "83920144" }],
    ["read_write_tokens is not a count key", { read_write_tokens: "83920144" }],
    ["count key after a glued name in an array", { a: ["dbpassword", { tokens: "83920144" }] }],
    ["count key under credential", { credential: { tokens: "83920144" } }],
    ["count key under pwd", { pwd: { tokens: "83920144" } }],
    ["count key under a spaced pass word", { "pass word": { tokens: "83920144" } }],
    ["count key after a glued name and a separator", { a: ["rootpassword", "=", { tokens: "83920144" }] }],
    ["numeric password string", { password: "12345678" }],
    // RK9-678 M: a credential name, its value, then more items
    ["three-item list", { a: ["PASSWORD", "Hunter2Hunter", "x"] }],
    ["four-item list, name in the middle", { argv: ["deploy", "API_KEY", FAKE_HEX, "--verbose"] }],
    ["nested three-item tuple", { env: [["DB_PASSWORD", FAKE_HEX, "prod"]] }],
    ["tag list, bare name in the middle, unknown word", { tags: ["infra", "secret", "hunterhunter"] }],
    ["object after a name in a long list", { a: ["PASSWORD", { v: "hunter2hunter2" }, "x"] }],
    // RK9-678 L: a UUID under an API key id
    ["UUID under api_key_id", { api_key_id: FAKE_UUID }],
    ["UUID under apiKeyId", { apiKeyId: FAKE_UUID }],
    ["UUID API_KEY_ID pair", { env: [{ name: "API_KEY_ID", value: FAKE_UUID }] }],
    // RK9-678: the shared keyword set (pass, pw, credentials)
    ["pw key", { pw: "hunter2hunter" }],
    ["db_pass key", { db_pass: "hunter2hunter" }],
    ["DB_PW key", { DB_PW: "hunter2hunter" }],
    ["credentials key", { credentials: "hunter2hunter" }],
    ["credential key", { credential: "hunter2hunter" }],
    ["credentials object", { credentials: { db: "hunter2hunter" } }],
    ["DB_PASS tuple", { env: ["DB_PASS", FAKE_HEX] }],
    ["DB_PASS pair", { env: [{ name: "DB_PASS", value: FAKE_HEX }] }],
    ["--pass flag, short value", { argv: ["tool", "--pass", "foo"] }],
    ["pass= in a free-text value", { note: "user=bob pass=hunter2hunter" }],
    ["passphrase= in a free-text value", { note: "passphrase=correcthorse" }],
    ["private_key= in a free-text value", { note: "private_key=abcdefgh12" }],
    // RK9-678 verifier round 1: pass and pw in assignment and pair positions
    ["pass, separator, value", { a: ["pass", "=", "Hunter2Hunter"] }],
    ["pw, separator, value", { a: ["pw", "=", "Hunter2Hunter"] }],
    ["db_pass, separator, value", { a: ["db_pass", "=", "Hunter2Hunter"] }],
    ["pass= item", { a: ["pass=", "Hunter2Hunter"] }],
    ["PW: item", { a: ["PW:", "Hunter2Hunter"] }],
    ["PASS: item", { a: ["PASS:", "Hunter2Hunter"] }],
    ["DB_PASS: item", { a: ["DB_PASS:", "Hunter2Hunter"] }],
    ["DB PASS label", { a: ["DB PASS", "Hunter2Hunter"] }],
    ["DB PW label", { a: ["DB PW", "Hunter2Hunter"] }],
    ["pass as a pair name", { env: [{ name: "pass", value: "Hunter2Hunter" }] }],
    ["pw as a pair name", { name: "pw", value: "Hunter2Hunter" }],
    ["db_pass as a pair name", { name: "db_pass", value: "Hunter2Hunter" }],
    ["db_pw as a Key/Value pair", { Key: "db_pw", Value: "Hunter2Hunter" }],
    // RK9-678 verifier round 1: a token key below another credential key
    ["counter key under token under userPass", { userPass: { token: { "session-user-model-cost-today": 1 } } }],
    ["counter key under token under DB_PASS", { DB_PASS: { token: { "session-user-model-cost-today": 1 } } }],
    ["counter key under token in a pair value", { name: "DB_PASSWORD", value: { token: { "session-user-model-cost-today": 1 } } }],
    ["counter key under token after a name", { a: ["DB_PASSWORD", { token: { "session-user-model-cost-today": 1 } }] }],
    ["counter key under access_tokens", { access_tokens: { system_user_session: 1 } }],
    // RK9-678: a secret as a key, whatever it labels
    ["secret key labelling a number under password", { password: { hunter2hunter2: 1 } }],
    ["secret key labelling a number under secret_key", { secret_key: { hunter2hunter2: 1 } }],
    ["secret key labelling a branch", { aws_secret_access_key: { hunter2hunter2: { a: 1 } } }],
    ["secret key labelling a number under tokens", { tokens: { hunter2hunter2: 1 } }],
    ["letters-only secret key under tokens", { tokens: { hunterpass: 1 } }],
    ["counter key under a password key", { secret_key: { cache_read: 1 } }],
    ["counter key under password below tokens", { tokens: { password: { cache_read: 1 } } }],
    ["counter key after a name in a list", { env: ["DB_PASSWORD", { cache_read: 1 }] }],
    ["counter key in a pair value", { name: "DB_PASSWORD", value: { cache_read: 1 } }],
    // --password-stdin exemption: a flag value after a real credential flag
    ["flag-like value after a credential flag", { argv: ["mysql", "--password", "--abcdef12"] }],
    ["value after --password still flagged", { argv: ["mysql", "--password", "hunter2hunter2"] }],
  ])("flags %s", (_label, metadata) => {
    expect(rk9CoordMetadataHasSecret(metadata)).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    // false positives of the unanchored key rule (MEDIUM)
    ["tokens_used", { tokens_used: 123456 }],
    ["context_tokens", { context_tokens: 291000 }],
    ["max_tokens", { max_tokens: 200000 }],
    ["secret_scan", { secret_scan: "passed" }],
    ["token_count", { token_count: 12 }],
    ["tmux_pane", { tmux_pane: "%12" }],
    ["branch", { branch: "rk9/RK9-625-presence" }],
    ["tokenizer", { tokenizer: "cl100k_base" }],
    ["secretary", { secretary: "Anne Lahti" }],
    ["password_policy", { password_policy: "strict" }],
    ["counter map under tokens", { tokens: { input: 1234, output: 56 } }],
    ["input_tokens", { usage: { input_tokens: 123456 } }],
    ["maxTokens", { maxTokens: 200000 }],
    ["name/value pair with a plain name", { env: [{ name: "EDITOR", value: "vim-nox" }] }],
    ["two-item tuple with a plain name", { env: ["EDITOR", "vim-nox"] }],
    ["three-item list starting with a credential name", { tags: ["token", "billing", "usage"] }],
    ["ZWJ emoji", { face: "\u{1F469}\u200d\u{1F4BB}" }],
    ["pair object without a value key", { field: "password", status: "rotated" }],
    ["token_type", { token_type: "Bearer" }],
    // verifier round 2: free-text values are not credential names
    ["branch names in a two-item list", { branches: ["rk9-642-secret-check", "master"] }],
    ["file paths in a two-item list", { files: ["src/token-refresh.ts", "src/auth.ts"] }],
    ["commit subjects", { recent: ["fix(rk9-coord): presence metadata secret check", "feat(db): advisory lock"] }],
    ["issue title tuple", { issue: ["Fix password reset flow", "in-progress"] }],
    ["setting label", { setting: { label: "Password reset emails", value: "enabled" } }],
    // RK9-665 L1: free-text two-item lists and labels
    ["tag list with secret", { tags: ["secret", "important"] }],
    ["tag list with tokens", { tags: ["tokens", "billing"] }],
    ["changed list with password", { changed: ["password", "reset_flow"] }],
    ["plural name in a pair object", { name: "tokens", value: "unlimited" }],
    ["file names in a two-item list", { files: ["token.ts", "README.md"] }],
    ["TOKEN_ID as a pair name", { env: [{ name: "TOKEN_ID", value: "tok_" + "abc123" }] }],
    ["--token-file flag", { argv: ["--token-file", "/run/x"] }],
    ["flag after a credential flag", { argv: ["docker", "login", "--password-stdin", "--username", "bob123"] }],
    // RK9-665 L2: token ids and count strings
    ["token_id", { token_id: FAKE_TOK_ID }],
    ["last_token_id", { last_token_id: "tok_" + "abc123def" }],
    ["numeric token_id", { token_id: "1234567890" }],
    ["token_id as a UUID", { token_id: FAKE_UUID }],
    ["tokens as a count string", { tokens: "123456" }],
    ["input_tokens as a count string", { input_tokens: "1234567" }],
    ["nested count string", { usage: { cache_read_tokens: "123456" } }],
    ["count strings beside each other", { usage: { input_tokens: "1234567", output_tokens: "1,234" } }],
    ["cache count keys", { usage: { cache_read_tokens: "123456", cache_creation_input_tokens: "234567" } }],
    ["tokens_limit with a unit", { context: { tokens_used: 1234, tokens_limit: "200k" } }],
    // RK9-678 false positives next to the leak fixtures above
    ["tag list, bare name in the middle, known word", { tags: ["infra", "secret", "important"] }],
    ["UUID under token_id stays accepted", { usage: { token_id: FAKE_UUID } }],
    ["prefixed api_key_id", { api_key_id: FAKE_TOK_ID }],
    ["UUID under api_key_ref", { api_key_ref: FAKE_UUID }],
    ["counter map under tokens", { tokens: { input: 1234, cache_read: 12, output: null } }],
    ["nested counter map under tokens", { usage: { tokens: { completion_details: { reasoning: 3 } } } }],
    ["pwd key", { pwd: "/home/rk9admin" }],
    ["compass key", { compass: "northwest" }],
    ["bypass key", { bypass: "enabled_mode" }],
    ["lower-case pass words in a list", { steps: ["first-pass", "second-pass", "review"] }],
    ["pass as a tag", { status: ["pass", "completed"] }],
    ["pass: in free text", { note: "second pass: refactoring" }],
    ["pwd= in free text", { note: "cd ~ && pwd=/home/rk9admin" }],
    ["tmux window", { tmux_window: "@7" }],
    ["counter map under input_tokens", { input_tokens: { cache_read: 12 } }],
    ["counter map under tokens under tokens", { tokens: { usage: { tokens: { cache_read: 1 } } } }],
  ])("accepts %s", (_label, metadata) => {
    expect(rk9CoordMetadataHasSecret(metadata)).toBe(false);
  });
});

// RK9 Custom (RK9-676): one value check per string, not one per ancestor key.
describe("presence metadata secret check cost and counter flags (RK9-676)", () => {
  function nested(depth: number, leaf: unknown): Record<string, unknown> {
    let value: unknown = leaf;
    for (let level = depth - 1; level >= 0; level -= 1) value = { [`k${level}`]: value };
    return value as Record<string, unknown>;
  }

  it("checks 15 levels over a 4 KB `eyJ` value in under 50 ms", () => {
    const metadata = nested(15, "eyJ".repeat(1300));
    expect(JSON.stringify(metadata).length).toBeGreaterThan(3900);
    rk9CoordMetadataHasSecret(metadata);
    const started = performance.now();
    expect(rk9CoordMetadataHasSecret(metadata)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("still flags a value under a keyword ancestor deep in the tree", () => {
    expect(rk9CoordMetadataHasSecret({ a: { token: { b: { c: "hunter2hunter2" } } } })).toBe(true);
    expect(rk9CoordMetadataHasSecret(nested(12, `Bearer ${"x".repeat(12)}`))).toBe(true);
  });

  it("keeps counter flags under tokens and rejects other keys there", () => {
    expect(rk9CoordMetadataHasSecret({ tokens: { output: null, cached: true, input: 12 } })).toBe(false);
    expect(rk9CoordMetadataHasSecret({ tokens: { hunterpass: true } })).toBe(true);
    expect(rk9CoordMetadataHasSecret({ password: { output: true } })).toBe(true);
  });

  it("flags a Bearer token glued with invisible characters in a metadata value", () => {
    expect(rk9CoordMetadataHasSecret({ note: `1Bearer\u200babcdefghijkl` })).toBe(true);
  });
});

describe("presence service source contract", () => {
  it("never writes heartbeat_runs and the heartbeat service does not know about presence", async () => {
    const service = await readFile(new URL("../services/rk9-coord-presence.ts", import.meta.url), "utf8");
    expect(service).not.toMatch(/\.(insert|update|delete)\(\s*heartbeatRuns/);
    expect(service).toContain('accessMode: "read only"');
    const heartbeat = await readFile(new URL("../services/heartbeat.ts", import.meta.url), "utf8");
    expect(heartbeat).not.toMatch(/rk9[-_]?coord/i);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-actors] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord presence API against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let readOnlyDb!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let agentId = "";
  let otherAgentId = "";
  let issueId = "";
  const runningRunId = randomUUID();
  const finishedRunId = randomUUID();
  const staleRunId = randomUUID();
  const otherCompanyRunId = randomUUID();
  let clock = new Date();
  const env = { RK9_COORD_PRESENCE_TTL_S: "300" } as NodeJS.ProcessEnv;

  type Actor = Express.Request["actor"];
  const operatorKey = (): Actor => ({
    type: "board",
    userId: "operator-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    keyId: "board-key-1",
    source: "board_key",
  });
  const otherBoardUser = (): Actor => ({
    type: "board",
    userId: "other-user",
    companyIds: [otherCompanyId],
    memberships: [{ companyId: otherCompanyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    keyId: "board-key-2",
    source: "board_key",
  });
  const agentKey = (): Actor => ({
    type: "agent",
    agentId,
    companyId,
    keyId: "agent-key-1",
    keyScope: { kind: "standard" },
    runId: runningRunId,
    source: "agent_key",
  });

  function makeApp(actor: Actor, database = db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(
      "/api",
      rk9CoordRoutes(database, {
        boardHost: "paperclip-01",
        boardKeyIds: null,
        presence: { now: () => clock, env },
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const base = (cid = companyId) => `/api/companies/${cid}/rk9/coord/actors`;
  const CC = "cc:paperclip-01:sess-1";

  async function registrations(actorRef: string) {
    const rows = await db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "rk9.coord.actor_registered")));
    return rows.filter((r) => (r.details as { actorRef?: string } | null)?.actorRef === actorRef);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-actors-");
    db = createDb(tempDb.connectionString);
    const roUrl = new URL(tempDb.connectionString);
    roUrl.searchParams.set("default_transaction_read_only", "on");
    readOnlyDb = createDb(roUrl.toString());
    await db.insert(companies).values([
      { id: companyId, name: "RK9 presence", issuePrefix: "RKP" },
      { id: otherCompanyId, name: "Other presence", issuePrefix: "RKQ" },
    ]);
    const [agent, otherAgent] = await db
      .insert(agents)
      .values([
        { companyId, name: "Presence Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
        { companyId: otherCompanyId, name: "Other Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      ])
      .returning();
    agentId = agent!.id;
    otherAgentId = otherAgent!.id;
    const [issue] = await db
      .insert(issues)
      .values({ companyId, identifier: "RKP-7", title: "Presence target", status: "in_progress", priority: "medium" })
      .returning();
    issueId = issue!.id;
  }, 60_000);

  beforeEach(async () => {
    clock = new Date();
    await db.delete(activityLog);
    await db.delete(rk9CoordActors);
    await db.delete(heartbeatRuns);
    const started = new Date(clock.getTime() - 90_000);
    const old = new Date(clock.getTime() - 3 * 3600_000);
    await db.insert(heartbeatRuns).values([
      { id: runningRunId, companyId, agentId, status: "running", startedAt: started, createdAt: started, updatedAt: started, contextSnapshot: { issueId } },
      { id: finishedRunId, companyId, agentId, status: "succeeded", startedAt: started, finishedAt: clock, contextSnapshot: { issueId } },
      { id: staleRunId, companyId, agentId, status: "running", startedAt: old, createdAt: old, updatedAt: old, lastOutputAt: old, contextSnapshot: { taskId: "not-a-uuid" } },
      { id: otherCompanyRunId, companyId: otherCompanyId, agentId: otherAgentId, status: "running", startedAt: started, updatedAt: started },
    ]);
  });

  afterAll(async () => {
    await readOnlyDb?.$client?.end?.({ timeout: 0 });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("upserts idempotently by actor_ref and logs only the first registration", async () => {
    const app = makeApp(operatorKey());
    const body = { kind: "cc", host: "paperclip-01", external_id: "sess-1", name: "Presence work", issue: "RKP-7", repo: "paperclip", branch: "work/RKP-7", phase: "coding", client_event_id: "c-1" };
    const first = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ actorId: CC, kind: "cc", host: "paperclip-01", trust: "attributed", created: true, ttlS: 300 });
    const second = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.created).toBe(false);
    const rows = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "sess-1", host: "paperclip-01", repo: "paperclip", branch: "work/RKP-7", phase: "coding" });
    const logged = await registrations(CC);
    expect(logged).toHaveLength(1);
  });

  it("counts a stub row inserted by another coord route as unregistered until the first PUT", async () => {
    await db.insert(rk9CoordActors).values({
      companyId,
      kind: "cc",
      actorRef: "cc:paperclip-01:stub",
      host: "paperclip-01",
      externalId: "stub",
      trust: "attributed",
      livenessSource: "hook",
    });
    const app = makeApp(operatorKey());
    const put = await request(app).put(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:stub").send({ phase: "x" });
    expect(put.status).toBe(200);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:stub").send({ phase: "y" });
    expect(await registrations("cc:paperclip-01:stub")).toHaveLength(1);
  });

  it("logs exactly one registration for concurrent first PUTs", async () => {
    const app = makeApp(operatorKey());
    const ref = "cc:paperclip-01:race";
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).put(`${base()}/me`).set("X-RK9-Actor", ref).send({ phase: "go" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(await registrations(ref)).toHaveLength(1);
  });

  it("keeps the registration marker out of client hands", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { presence_registered_at: "x", a: 1 } });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { b: 2 } });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).toMatchObject({ b: 2 });
    expect(row!.metadata).not.toHaveProperty("a");
    expect(String(row!.metadata.presence_registered_at)).not.toBe("x");
    expect(await registrations(CC)).toHaveLength(1);
  });

  it("answers 422 to a secret in a field that is stored verbatim", async () => {
    const app = makeApp(operatorKey());
    for (const body of [
      { branch: "fix/token=supersecret123" },
      { external_id: "rk9_coord_AbCdEfGhIjKl" },
      { metadata: { note: "rk9_coord_AbCdEfGhIjKl" } },
      // JSON escaping must not hide whitespace from the pattern (verifier round 2).
      { metadata: { note: "Bearer\nabcdefghijklmnop" } },
      { metadata: { note: "Bearer\tabcdefghijklmnop" } },
      { metadata: { note: "token\u0001=\u0001supersecret123" } },
      { metadata: { nested: [{ "token=supersecret123": 1 }] } },
      // key/value form (verifier round 3)
      { metadata: { password: "hunter2hunter2" } },
      { metadata: { github_token: "abcdefghijkl" } },
      { metadata: { aws: { secret: "abcdefghijkl" } } },
      { metadata: { url: "https://user:pass\tword@host" } },
      // a credential-named key above an array or nested object (verifier round 4)
      { metadata: { password: ["hunter2hunter2"] } },
      { metadata: { api_key: ["abcdef123456"] } },
      { metadata: { secret: { db: "hunter2hunter2" } } },
      { metadata: { secrets: { db: "hunter2hunter2" } } },
      { metadata: { passwords: { prod: ["hunter2hunter2"] } } },
      { metadata: { tokens: "abcdefghijkl" } },
      { metadata: { note: "secrets=abcdefghijkl" } },
      { branch: "Bearer\u0085abcdefghijk" },
      // RK9-642 (verifier round 5)
      { metadata: { env: [{ name: "PASSWORD", value: "hunter2hunter2" }] } },
      { metadata: { env: [["DB_PASSWORD", "hunter2hunter2"]] } },
      { metadata: { password: { hunter2hunter2: true } } },
      { metadata: { "pass\u00adword": "hunter2hunter2" } },
    ]) {
      const res = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
      expect(res.status).toBe(422);
    }
    expect(await db.select().from(rk9CoordActors)).toHaveLength(0);
  });

  it("measures the metadata cap in UTF-8 bytes", async () => {
    const app = makeApp(operatorKey());
    // 1500 emoji = 3000 UTF-16 units but 6000 UTF-8 bytes.
    const res = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { e: "😀".repeat(1500) } });
    expect(res.status).toBe(422);
  });

  it("accepts plain metadata under keys that are not credential names", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({ metadata: { tmux: { window: "@12", panes: ["main-pane", "logs-pane"] }, attempt: 3 } });
    expect(res.status).toBe(201);
  });

  it("accepts token counts and keys that only contain a credential word (RK9-642)", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({
        metadata: {
          tokens_used: 123456,
          max_tokens: 200000,
          secret_scan: "passed",
          tokenizer: "cl100k_base",
          usage: { input_tokens: 123456, tokens: { input: 1234, output: 56 } },
        },
      });
    expect(res.status).toBe(201);
  });

  it("accepts legitimate metadata: a backslash-u0000 literal and a real emoji", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({ metadata: { path: "C:\\u0000dir", face: "😀" } });
    expect(res.status).toBe(201);
  });

  it("clears a stale client_external_id once the client id matches", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "other" });
    let [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata.client_external_id).toBe("other");
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "sess-1" });
    [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).not.toHaveProperty("client_external_id");
  });

  it("keeps client_external_id server-owned", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { client_external_id: "forged" } });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).not.toHaveProperty("client_external_id");
  });

  it("refreshes trust on phase updates and ends", async () => {
    await db.insert(rk9CoordActors).values({ companyId, kind: "cc", actorRef: CC, host: "paperclip-01", trust: "verified" });
    const app = makeApp(operatorKey());
    await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "x" });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.trust).toBe("attributed");
  });

  it("updates phase without an activity row and shows it in GET at once", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ phase: "start" });
    const before = (await registrations(CC)).length;
    clock = new Date(clock.getTime() + 500);
    const phase = await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "running tests" });
    expect(phase.status).toBe(200);
    expect(phase.body.phase).toBe("running tests");
    expect((await registrations(CC)).length).toBe(before);
    const allLogs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(allLogs.some((r) => r.action !== "rk9.coord.actor_registered")).toBe(false);
    const list = await request(app).get(`${base()}?active=1`).set("X-RK9-Actor", CC);
    expect(list.status).toBe(200);
    expect(list.body.actors.find((a: { actorId: string }) => a.actorId === CC)).toMatchObject({ phase: "running tests", lastSeenS: 0 });
  });

  it("answers rk9_coord_actor_not_found to a phase without a registration", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", "cc:paperclip-01:ghost").send({ phase: "x" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("rk9_coord_actor_not_found");
  });

  it("redacts and caps the phase before storage (RK9-549 fixture)", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ phase: "Korjaa login-bugi token=supersecret123" });
    let [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.phase).toBe("Korjaa login-bugi [redacted]");
    await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: `${"z".repeat(300)} ghp_abcdefghijk` });
    [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.phase).toHaveLength(140);
    expect(row!.phase).not.toContain("ghp_");
  });

  it("ends idempotently and drops the actor from active lists at once", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    const end = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "sess-1", host: "paperclip-01" });
    expect(end.status).toBe(204);
    const again = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", CC);
    expect(again.status).toBe(204);
    const never = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:never");
    expect(never.status).toBe(204);
    const active = await request(app).get(`${base()}?active=1`);
    expect(active.body.actors.map((a: { actorId: string }) => a.actorId)).not.toContain(CC);
    const all = await request(app).get(`${base()}?active=0`);
    expect(all.body.actors.map((a: { actorId: string }) => a.actorId)).toContain(CC);
  });

  it("drops a kill -9'd actor after the TTL plus one refresh, with no cleanup step", async () => {
    const app = makeApp(operatorKey());
    const live = "cc:paperclip-01:live";
    const dead = "cc:paperclip-01:dead";
    const t0 = clock.getTime();
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", dead).send({});
    // `live` refreshes every 200 s; `dead` was killed and never sends again.
    clock = new Date(t0 + 200_000);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    clock = new Date(t0 + 299_000);
    let ids = (await request(app).get(`${base()}?active=1`)).body.actors.map((a: { actorId: string }) => a.actorId);
    expect(ids).toEqual(expect.arrayContaining([live, dead]));
    clock = new Date(t0 + 400_000);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    ids = (await request(app).get(`${base()}?active=1`)).body.actors.map((a: { actorId: string }) => a.actorId);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead);
    // The row still exists: liveness is a read rule, not a delete.
    const rows = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, dead));
    expect(rows[0]!.endedAt).toBeNull();
  });

  it("filters by repo and issue and returns compact rows", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ repo: "mv50000/paperclip", branch: "work/RKP-7", issue: "RKP-7", name: "A" });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "worktree:RKP-8").send({ repo: "bk" });
    const byRepo = await request(app).get(`${base()}?active=1&repo=paperclip`);
    expect(byRepo.body.actors).toEqual([
      expect.objectContaining({ actorId: CC, kind: "cc", host: "paperclip-01", name: "A", issue: "RKP-7", repoBranch: "mv50000/paperclip@work/RKP-7", phase: null, ageS: 0 }),
    ]);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "worktree:RKP-9").send({ repo: "o/myXrepo" });
    const underscore = await request(app).get(`${base()}?repo=my_repo`);
    expect(underscore.body.actors).toEqual([]);
        const byIssue = await request(app).get(`${base()}?issue=RKP-8`);
    expect(byIssue.body.actors.map((a: { actorId: string }) => a.actorId)).toEqual(["worktree:RKP-8"]);
  });

  it("projects running heartbeat runs as agent_run rows without writing anything", async () => {
    const before = await db.select().from(heartbeatRuns);
    // A connection whose every transaction is READ ONLY: any INSERT or UPDATE
    // on any table would fail the request.
    const app = makeApp(operatorKey(), readOnlyDb);
    const res = await request(app).get(`${base()}?active=1`);
    expect(res.status).toBe(200);
    const runs = res.body.actors.filter((a: { kind: string }) => a.kind === "agent_run");
    expect(runs).toEqual([
      {
        actorId: `agent_run:${runningRunId}`,
        kind: "agent_run",
        host: null,
        name: "Presence Coder",
        issue: "RKP-7",
        repo: null,
        branch: null,
        repoBranch: null,
        phase: null,
        trust: "verified",
        ageS: 90,
        lastSeenS: 90,
        runStatus: "running",
        source: "heartbeat_run",
      },
    ]);
    const byIssue = await request(app).get(`${base()}?issue=RKP-7`);
    expect(byIssue.body.actors.map((a: { actorId: string }) => a.actorId)).toEqual([`agent_run:${runningRunId}`]);
    const byRepo = await request(app).get(`${base()}?repo=paperclip`);
    expect(byRepo.body.actors).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual(before);
    // The read-only connection really rejects writes.
    await expect(readOnlyDb.insert(rk9CoordActors).values({ companyId, kind: "orch", actorRef: "orch:x", trust: "attributed" })).rejects.toThrow();
  });

  it("registers an agent run once and does not list it twice", async () => {
    const app = makeApp(agentKey());
    const put = await request(app).put(`${base()}/me`).send({ phase: "working" });
    expect(put.status).toBe(201);
    expect(put.body).toMatchObject({ actorId: `agent_run:${runningRunId}`, trust: "attributed" });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, `agent_run:${runningRunId}`));
    expect(row).toMatchObject({ agentId, runId: runningRunId, host: null, externalId: runningRunId });
    const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, put.body.id));
    expect(logged[0]).toMatchObject({ actorType: "agent", agentId, runId: runningRunId });
    const list = await request(app).get(`${base()}?active=1`);
    const mine = list.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: "presence", phase: "working" });
    // Ending the presence row does not hide a run that is still running.
    await request(app).delete(`${base()}/me`);
    const after = await request(app).get(`${base()}?active=1`);
    const projected = after.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(projected).toEqual([expect.objectContaining({ source: "heartbeat_run", runStatus: "running" })]);
    const all = await request(app).get(`${base()}?active=0`);
    const both = all.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(both.map((a: { source: string }) => a.source).sort()).toEqual(["heartbeat_run", "presence"]);
  });

  it("rejects another company's cid for agent keys and board users", async () => {
    const agentOther = await request(makeApp(agentKey())).put(`${base(otherCompanyId)}/me`).send({});
    expect(agentOther.status).toBe(403);
    const agentList = await request(makeApp(agentKey())).get(base(otherCompanyId));
    expect(agentList.status).toBe(403);
    const boardOther = await request(makeApp(otherBoardUser())).get(base());
    expect(boardOther.status).toBe(403);
    const boardPut = await request(makeApp(otherBoardUser())).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    expect(boardPut.status).toBe(403);
    expect(await db.select().from(rk9CoordActors)).toHaveLength(0);
  });

  it.each([
    [{ kind: "bogus" }],
    [{ host: "Paperclip-01" }],
    [{ external_id: "has space" }],
    [{ external_id: "" }],
    [{ phase: "p".repeat(1001) }],
    [{ issue: "not an issue" }],
    [{ repo: "a/b/c" }],
    [{ pid: -1 }],
    [{ branch: "a\u0000b" }],
    [{ branch: "a\u0001b" }],
    [{ metadata: { a: "x\u0000y" } }],
    [{ metadata: { a: "\ud800" } }],
    [{ metadata: { "\udc00": 1 } }],
    [{ metadata: JSON.parse(`{"a":${"[".repeat(3000)}${"]".repeat(3000)}}`) }],
    [{ metadata: JSON.parse(`{"a":${"[".repeat(20)}1${"]".repeat(20)}}`) }],
    [{ unknown: true }],
  ])("answers 422 to an invalid PUT body %j", async (body) => {
    const res = await request(makeApp(operatorKey())).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(res.status).toBe(422);
  });

  it("answers 422 to a bad phase body or list query", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    expect((await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({})).status).toBe(422);
    expect((await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "p".repeat(1001) })).status).toBe(422);
    expect((await request(app).get(`${base()}?active=yes`)).status).toBe(422);
    expect((await request(app).get(`${base()}?limit=0`)).status).toBe(422);
  });

  it("rejects a body kind or host that contradicts the resolved actor", async () => {
    const app = makeApp(operatorKey());
    const kind = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ kind: "worktree" });
    expect(kind.status).toBe(403);
    expect(kind.body.code).toBe("rk9_coord_actor_spoof");
    const host = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ host: "mv-laptop" });
    expect(host.status).toBe(403);
    expect(host.body.code).toBe("rk9_coord_host_mismatch");
  });

  it("keeps the actor middleware in front: mutation without an actor id is 400", async () => {
    const res = await request(makeApp(operatorKey())).put(`${base()}/me`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rk9_coord_actor_required");
  });

  it("service list honours the injected TTL env", async () => {
    const svc = rk9CoordPresenceService(db, { now: () => clock, env: { RK9_COORD_PRESENCE_TTL_S: "60" } as NodeJS.ProcessEnv });
    await svc.upsert({ companyId, kind: "orch", actorId: "orch:ttl", host: "paperclip-01", trust: "attributed" }, {});
    clock = new Date(clock.getTime() + 61_000);
    const rows = await svc.list(companyId, { active: true });
    expect(rows.map((r) => r.actorId)).not.toContain("orch:ttl");
  });
});
