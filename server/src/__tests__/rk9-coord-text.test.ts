// RK9 Custom (RK9-641): the one coord redaction module (rk9-coord-text.ts)
// after the RK9-625 copy merged into it. Pure unit tests, no database. The
// older fixtures stay in rk9-coord-journal.test.ts and
// rk9-coord-actors-routes.test.ts. Fake values only, built at runtime so the
// repo secret scan does not flag the test source.
import { describe, expect, it } from "vitest";
import { sendRk9CoordInboxSchema } from "@paperclipai/shared";
import {
  collapseRk9CoordText,
  rk9CoordIdentifierHasSecret,
  rk9CoordMatchText,
  rk9CoordTextHasSecret,
  toRk9CoordLine,
} from "../services/rk9-coord-text.js";

const env = {} as NodeJS.ProcessEnv;
const canary = ["abcd", "efgh", "1234"].join("");
const ghToken = `${"gh" + "p_"}ABCDEFGHIJKLMNOP`;

describe("identifier secret check (RK9-641 items 7, 8)", () => {
  it("flags a URL credential although its match starts after the scheme letter", () => {
    expect(rk9CoordIdentifierHasSecret(`https://alice:${"hunter2"}pass@example.com`, env)).toBe(true);
    expect(rk9CoordIdentifierHasSecret(`ssh://bob:${canary}@host`, env)).toBe(true);
  });

  it("does not let a mid-word candidate hide the token after it", () => {
    expect(rk9CoordIdentifierHasSecret(`rk9-ai/task-runner_${ghToken}`, env)).toBe(true);
    expect(rk9CoordIdentifierHasSecret(`kiosk-frontend-${ghToken}`, env)).toBe(true);
  });

  it("still passes ordinary names with sk- mid-word", () => {
    for (const ok of ["rk9-ai/task-runner", "kiosk-frontend", "disk-monitor", "orchestrator", "https://example.com/x"]) {
      expect(rk9CoordIdentifierHasSecret(ok, env), ok).toBe(false);
    }
  });

  it("applies the lookbehind to an env override pattern too", () => {
    const custom = { RK9_SESSIONS_SECRET_RX: "zz_[a-z]{6,}" } as NodeJS.ProcessEnv;
    expect(rk9CoordIdentifierHasSecret("x/zz_abcdefgh", custom)).toBe(true);
    expect(rk9CoordIdentifierHasSecret("xzz_abcdefgh", custom)).toBe(false);
  });
});

describe("inbox `to` field (RK9-641 item 9)", () => {
  it.each(["a\u0000b", "name\u0085x", "na\u200bme", "x\u202ey", "a\tb"])("rejects control or format characters %j", (to) => {
    expect(sendRk9CoordInboxSchema.safeParse({ to, body: "hi" }).success).toBe(false);
  });

  it("accepts ordinary targets", () => {
    for (const to of ["orchestrator", "RK9-641", "cc:paperclip-01:abc", "Sessio \u00e4\u00e4kk\u00f6set"]) {
      expect(sendRk9CoordInboxSchema.safeParse({ to, body: "hi" }).success, to).toBe(true);
    }
  });
});

describe("display text keeps joiners and selectors (RK9-641 item 10)", () => {
  it.each([
    ["coding \u{1F469}\u200d\u{1F4BB} now", "coding \u{1F469}\u200d\u{1F4BB} now"],
    ["love \u2764\ufe0f", "love \u2764\ufe0f"],
    ["fire \u2764\ufe0f\u200d\u{1F525}", "fire \u2764\ufe0f\u200d\u{1F525}"],
    ["\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"],
  ])("keeps %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it("removes a run of three or more joiners or selectors (smuggling)", () => {
    expect(collapseRk9CoordText("hi\u{1F600}\ufe01\ufe02\ufe03\ufe04 there")).toBe("hi\u{1F600} there");
    expect(collapseRk9CoordText("a\u200c\u200d\u200c\u200db")).toBe("ab");
    expect(collapseRk9CoordText("a\u200b\u200d\u200b\u200d\u200b\u200db")).toBe("ab");
  });

  it("still removes bidi overrides, tag characters and controls", () => {
    expect(collapseRk9CoordText("ok \u202ehidden\u2066 text")).toBe("ok hidden text");
    expect(collapseRk9CoordText("x\u{E0041}\u{E0042}y")).toBe("xy");
    expect(collapseRk9CoordText("a\u0000b\u0085c")).toBe("abc");
  });

  it("fails closed when a single joiner splits a keyword", () => {
    expect(toRk9CoordLine(`pass\u200cword=${canary} ok`, 140, env)).toBe("[redacted]");
    expect(toRk9CoordLine(`tok\ufe0fen=${canary}`, 140, env)).toBe("[redacted]");
  });
});

describe("keyword encodings (RK9-641 item 13)", () => {
  it.each([
    [`"tokens": ["${canary}"]`],
    [`"token": ["${canary}", "${canary}x"]`],
    [`"secrets": {"db": "${canary}"}`],
    [`password -> ${canary}`],
    [`api_key => ${canary}`],
    [`token%3D${canary}`],
    [`secret%3a${canary}`],
    [`\uff54\uff4f\uff4b\uff45\uff4e\uff1d${canary}`],
    [`\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44: ${canary}`],
  ])("redacts %j", (input) => {
    const out = toRk9CoordLine(`note ${input} end`, 200, env)!;
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(canary);
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
  });

  it("keeps a closed counter object of numbers (token counts); arrays are redacted", () => {
    expect(rk9CoordTextHasSecret(`"tokens": [1234, 5678]`, env)).toBe(true);
    for (const ok of [`"tokens": {"input": 1234, "output": 56}`, `{"tokens":{"cache_read":0,"ok":true}}`]) {
      expect(rk9CoordTextHasSecret(ok, env), ok).toBe(false);
    }
  });

  it("keeps other full-width text when it has no secret", () => {
    expect(toRk9CoordLine("\uff54\uff45\uff53\uff54 ok", 140, env)).toBe("\uff54\uff45\uff53\uff54 ok");
    expect(rk9CoordMatchText("\uff54\uff4f\uff4b\uff45\uff4e")).toBe("token");
  });

  it("documents the prose false positive (item 14): a keyword, a colon and a word", () => {
    expect(toRk9CoordLine("Secrets: rotated today", 140, env)).toBe("[redacted] today");
    expect(toRk9CoordLine("token budget is fine", 140, env)).toBe("token budget is fine");
  });
});

describe("toRk9CoordLine edge cases (RK9-641)", () => {
  it("does not let a raw-only match mask a second, hidden secret", () => {
    const text = `ssh://u:pa\tss@h Bearer\u200b${canary}xyz`;
    const out = toRk9CoordLine(text, 200, env)!;
    expect(out).not.toContain(canary);
  });

  it("caps with an ellipsis", () => {
    expect(toRk9CoordLine("a".repeat(50), 10, env)).toBe(`${"a".repeat(9)}\u2026`);
    expect(toRk9CoordLine("x".repeat(500), 140, env)).toHaveLength(140);
  });
});

// RK9-641 verifier round 1 regressions. Fake values only.
describe("verifier round 1 (RK9-641)", () => {
  const bearer = `Bearer\u200b${canary}xyz`;
  it.each([
    // a literal [redacted] marker split by an invisible character
    [`[redac\u200bted] ${bearer}`],
    [`[redac\u200bted] basic\u2060dXNlcjpodW50ZXIy`],
    [`[redac\u0001ted] Bearer\u0001${canary}xyz`],
    // a control as the separator plus another invisible character inside the token
    [`auth Bearer\u0001abcd\u200befghijkl done`],
    [`auth Bearer\u0001abcd\u200defghijkl done`],
    [`auth Bearer\u0001abcd\u0301efghijkl done`],
  ])("fails closed on %j", (input) => {
    expect(toRk9CoordLine(input, 200, env)).toBe("[redacted]");
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
  });

  it.each([
    ["passwords: [83749201]"],
    ["secrets=(847291034)"],
    ["api_keys: [3e8e1e2e5e]"],
    ["tokens: (hunter22secret: 1)"],
    ["tokens: [hunter22secret:]"],
    [`"tokens": {"hunter22secret": 1}`],
    ["tokens: [ passwords: 12345678"],
  ])("redacts a bracketed keyword value %j", (input) => {
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
    expect(toRk9CoordLine(input, 200, env)).not.toMatch(/83749201|847291034|3e8e1e2e5e|hunter22secret|12345678/);
  });

  it("redacts a long bracketed secret whole, not only its first 200 characters", () => {
    const long = "x9".repeat(160);
    const out = toRk9CoordLine(`secrets: [${long}] end`, 500, env)!;
    expect(out).not.toContain("x9x9");
  });

  it.each([
    [`gh\u0301p_abcdefghijklmnop`],
    [`ghp_abc\ufe00defghijklmnop`],
    [`ghp_abc\u034fdefghijkl`],
    [`ghp_abc\u3164defghijkl`],
    [`\uff47\uff48\uff50\uff3fabcdefghijkl`],
    [`AKIA\u0300ABCDEFGHIJKLMNOP`],
  ])("flags an identifier that hides a token with a mark, selector or full-width form %j", (to) => {
    expect(rk9CoordIdentifierHasSecret(to, env)).toBe(true);
  });

  it("removes bidi marks from display text", () => {
    expect(collapseRk9CoordText("a\u200eb\u200fc\u061cd")).toBe("abcd");
  });
});

// RK9-641 verifier round 2. Fake values only.
describe("verifier round 2 (RK9-641)", () => {
  it.each([
    [`auth Bearer\u200babcd\u200befghijkl done`],
    [`auth Bearer\u3164abcd\u200befghijkl done`],
    [`auth Bearer\u2800abcdefghijkl done`],
    [`auth basic\u200bdXNl\u200bcjpodW50ZXIy done`],
  ])("fails closed when invisible characters both separate and split a token %j", (input) => {
    expect(toRk9CoordLine(input, 200, env)).toBe("[redacted]");
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
  });

  it.each([[`Bearer\u3164abcdefghijkl`], [`Bearer\u1160abcdefghijkl`], [`Bearer\ufe0fabcdefghijkl`], [`Bearer\u2800abcdefghijkl`]])(
    "flags an identifier with a blank-looking separator %j",
    (to) => {
      expect(rk9CoordIdentifierHasSecret(to, env)).toBe(true);
    },
  );

  it.each([
    [`password: {"pin": 83749201}`],
    [`passwords: {pin: 83749201}`],
    [`api_key: {"key": 1234567890123}`],
    [`secret: {"CorrectHorseBatteryStaple": true}`],
    [`"tokens": {"input": 1, "model": "opus-${canary}"}`],
  ])("keeps no bracketed value under a credential keyword or with a string value %j", (input) => {
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
  });

  it.each([
    [`{"tokens":{"cache":{"read":1,"write":2}}}`],
    [`{"tokens":{"usage":{"input":1}}}`],
    [`"max_tokens": {"input": 1234, "output": -5, "ratio": 0.5, "ok": true, "x": null}`],
    [`tokens={input: 12}`],
  ])("keeps a counter object under tokens %j", (input) => {
    expect(rk9CoordTextHasSecret(input, env)).toBe(false);
  });

  it("matches a long digit run in a counter object in linear time", () => {
    const started = Date.now();
    expect(rk9CoordTextHasSecret(`"tokens": {${"1".repeat(20000)}x}`, env)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// RK9-641 verifier round 3. Fake values only.
describe("verifier round 3 (RK9-641)", () => {
  it.each(["true:", "null:", "false:", "a:1,"])("scans a counter object in linear time (%j repeated)", (unit) => {
    const started = Date.now();
    toRk9CoordLine(`phase tokens: {${unit.repeat(400)}!}`, 140, env);
    rk9CoordTextHasSecret(`tokens:{${unit.repeat(400)}!}`, env);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still keeps a counter object and rejects a string value after the scan rewrite", () => {
    expect(rk9CoordTextHasSecret(`"tokens": {"input": 1234, "ok": true, "x": null, "c": {"read": 1}}`, env)).toBe(false);
    expect(rk9CoordTextHasSecret(`"tokens": {"input2": 1}`, env)).toBe(true);
    expect(rk9CoordTextHasSecret(`"tokens": {"true": "x"}`, env)).toBe(true);
    expect(rk9CoordTextHasSecret(`"tokens": {"input": 12ab}`, env)).toBe(true);
  });

  it.each([
    [`\u2764\ufe0f fixing basic-auth-middleware`],
    [`Pa\u0308ivita\u0308 basicsettings.yaml`],
    [`ok \u{1F469}\u200d\u{1F4BB} Bearerless design`],
  ])("keeps ordinary text with invisible characters and a bearer/basic word %j", (input) => {
    expect(rk9CoordTextHasSecret(input, env)).toBe(false);
  });

  it("flags a glued Bearer token in an identifier", () => {
    expect(rk9CoordIdentifierHasSecret(`Bearer\u200babcd\u200befghijkl`, env)).toBe(true);
  });
});

// RK9 Custom (RK9-676): follow-ups of the RK9-641 verifier rounds. Fake values only.
describe("RK9-676 redaction follow-ups", () => {
  const jwt = ["ey", "J", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxIn0", ".", "sig"].join("");

  it("still redacts a JWT, also after a separator or a keyword", () => {
    for (const text of [jwt, `auth=${jwt}`, `x ${jwt} y`, `"${jwt}"`]) {
      expect(rk9CoordTextHasSecret(text, env), text).toBe(true);
      expect(toRk9CoordLine(text, 300, env), text).not.toContain("eyJzdWIi");
    }
  });

  it("checks `eyJ` repeated without a dot in linear time", () => {
    const text = "eyJ".repeat(1400);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) rk9CoordTextHasSecret(text, env);
    expect((performance.now() - started) / 20).toBeLessThan(20);
  });

  it("flags Bearer glued with invisible characters after a digit", () => {
    expect(rk9CoordTextHasSecret(`1Bearer​abcdefghijkl`, env)).toBe(true);
    expect(rk9CoordIdentifierHasSecret(`1Bearer​abcdefghijkl`, env)).toBe(true);
    expect(toRk9CoordLine(`id 1Bearer​abcdefghijkl`, 140, env)).toBe("[redacted]");
    // A letter before it is still another word.
    expect(rk9CoordTextHasSecret(`acidbasic‍\u{1F600}`, env)).toBe(false);
  });

  // Verifier round 1 (RK9-676): a 256-character cap on an unclosed bracket
  // left the tail of a long secret; the value still goes to the end.
  it("redacts an unclosed bracket value to the end of the text", () => {
    const long = ["s3", "Kr"].join("").repeat(200);
    const out = toRk9CoordLine(`secrets: ["${long} later text`, 500, env)!;
    expect(out).toBe("[redacted]");
    expect(toRk9CoordLine(`tokens: [ ${canary} more`, 200, env)).not.toContain(canary);
  });

  it.each([
    [`AKIAABCDEFGHIJKLMNOPx${"rk9_" + "coord_"}MX5t3Hg8GRqENUrSzwPp`, "MX5t3Hg8"],
    [`Bearer abcdefgh12_token%3DUTznH4BGTFGMSPX ok`, "UTznH4BG"],
    [`\u2705\ufe0f retry: Bearer abcdefgh12_token%3DUTznH4BGTFGMSPX ok`, "UTznH4BG"],
  ])("does not let one match eat the start of the next secret %j", (input, tail) => {
    const out = toRk9CoordLine(input, 300, env)!;
    expect(out).not.toContain(tail);
    expect(out).toContain("[redacted]");
  });

  it.each([[`tokens={abcdef:1}`], [`"tokens": {"hunterpass": 1}`], [`tokens: {"zzqxwvjk": true}`], [`"tokens": {"input": 1, "qwertyuiopas": 2}`]])(
    "redacts a counter object whose key is not a counter word %j",
    (input) => {
      expect(rk9CoordTextHasSecret(input, env)).toBe(true);
    },
  );

  it.each([
    [`"tokens": {"cache_read_input_tokens": 12, "completionTokensDetails": {"reasoningTokens": 3}}`],
    [`tokens={input: 12, output: 3, ratio: 0.5, x: null}`],
    [`"usage_tokens": {"prompt_tokens": 10, "total_tokens": 12, "cached": true}`],
  ])("keeps a counter object of counter words %j", (input) => {
    expect(rk9CoordTextHasSecret(input, env)).toBe(false);
  });

  // Whole-line loss (RK9-641 item 5): an emoji selector or an NFD accent next to
  // a redacted keyword value keeps the rest of the line.
  it.each([
    [`deploy ❤️ done, token: ${canary} next step`, "next step"],
    [`token️ note: password=${canary} then välilehti auki`, "välilehti auki"],
    [`päivitetty: token=välitetty${canary} ja muu teksti`, "ja muu teksti"],
    [`\u{1F44D}️ api_key=${canary}, sitten tarkistus`, "sitten tarkistus"],
  ])("keeps the harmless rest of %j", (input, rest) => {
    const out = toRk9CoordLine(input, 300, env)!;
    expect(out).not.toBe("[redacted]");
    expect(out).toContain("[redacted]");
    expect(out).toContain(rest);
    expect(out).not.toContain(canary);
  });

  it.each([
    [`ghp_abcdef́ghijklmnop rest`],
    [`ghp_abcdeöxyzxyzxyz rest`],
    [`auth Bearer abcdefgh́ijklmn rest`],
    [`auth Bearer​${canary}xyz rest`],
    [`sećrets: [aaa bbb ccc] rest`],
  ])("still fails closed when an invisible character splits a secret %j", (input) => {
    expect(toRk9CoordLine(input, 300, env)).toBe("[redacted]");
  });
});
