// RK9 Custom (RK9-641): the one coord redaction module (rk9-coord-text.ts)
// after the RK9-625 copy merged into it. Pure unit tests, no database. The
// older fixtures stay in rk9-coord-journal.test.ts and
// rk9-coord-actors-routes.test.ts. Fake values only, built at runtime so the
// repo secret scan does not flag the test source.
import { describe, expect, it } from "vitest";
import { sendRk9CoordInboxSchema } from "@paperclipai/shared";
import {
  collapseRk9CoordText,
  redactRk9CoordText,
  RK9_COORD_JWT_BRANCH,
  RK9_COORD_SECRET_RX_DEFAULT,
  rk9CoordJwtSpans,
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

// RK9 Custom (RK9-676, verifier round 2 and the parent's JWT decision).
describe("RK9-676 redaction never weaker than the sequential replace", () => {
  const R = "[redacted]";
  const KEYWORD =
    /((?:token|secret|password|passwd|api[_-]?key|apikey)s?["']?\s*(?:[=:]|->|=>|%3[ad])\s*)(?:([[{(]\s*[^\]})]{6,}[\]})]?)|["']?[^\s"',;]{6,})/gi;
  // RK9-684: the default pattern before RK9-684 (no prefix keyword stop, no
  // `Bearer` keyword value). The fuzz below must be at least as strict as the
  // replace with this one too.
  const PRE_RK9_684_DEFAULT =
    "(gh[opusr]_|github_pat_|pcp_[a-z]+_|vck_|qmk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|xox[abpors]-|glpat-)[A-Za-z0-9_-]{6,}" +
    "|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9._-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----" +
    "|://[^ /:@]+:[^ /@]+@|(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}" +
    "|((token|secret|password|passwd|passphrase|private[_-]?key|credentials?|api[_-]?key|apikey|(?<![A-Za-z])pw)[\"']?\\s*[=:]\\s*" +
    "|(?<![A-Za-z])pass[\"']?\\s*=\\s*)[\"']?[^\\s\"',;]{6,}";
  // The RK9-641 redaction (origin/master before RK9-676), with the counter
  // exemption widened to every brace value under token(s): a weaker baseline.
  function sequential(text: string, pattern = RK9_COORD_SECRET_RX_DEFAULT): string {
    return text
      .replace(new RegExp(pattern, "gi"), R)
      .replace(/rk9_coord_[A-Za-z0-9_-]{6,}/gi, R)
      .replace(KEYWORD, (match: string, prefix: string, bracket: string | undefined) =>
        bracket !== undefined && bracket.startsWith("{") && /^tokens?(?![a-z])/i.test(prefix) ? match : R,
      );
  }
  const body = ["MIIEvQIBADANBg", "kqhkiG9w0BAQEF"].join("");
  // Built at runtime so the repo secret scan does not flag the fake keys.
  const pem = (kind: string, edge = "BEGIN") => `-----${edge} ${kind}${kind ? " " : ""}PRIVATE ${"KEY"}-----`;

  it.each([
    [`{"secrets": "${pem("")}\\n${body}\\n${pem("", "END")}\\n"}`, body],
    [`secrets: "${pem("RSA")}\\n${body}"`, body],
    [`passwords -> "${pem("OPENSSH")}\\n${body}`, body],
    [`{"tokens": "Bearer abcdefgh12%2Bsecretpart%3D%3D"}`, "secretpart"],
    [`Bearer abcdefgh12_token=abc&tokens: REALSECRETVALUE9`, "REALSECRETVALUE9"],
    [`${"gh" + "p_"}abcdefghij_secret=1&secrets: REALSECRETVALUE9 end`, "REALSECRETVALUE9"],
  ])("redacts %j", (input, secret) => {
    expect(redactRk9CoordText(input, env)).not.toContain(secret);
    expect(toRk9CoordLine(input, 16000, env)).not.toContain(secret);
  });

  it("keeps every secret that the sequential replace removed (seeded differential fuzz)", () => {
    const canary = "Qz9Kp7WmX";
    // RK9-684 item 8: an upper-case canary inside a PEM header, so the fuzz
    // sees header words that a JWT-adjacent match leaves visible.
    const header = "QZCANARYX";
    const pieces = [
      "token", "tokens", "secrets", "password", "api_key", ": ", "=", "->", "%3D", " ", " ", "Bearer ", "basic ",
      "AKIA", "ABCDEFGHIJKLMNOP", "rk9_coord_", "ghp_", ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), "\\n", "\"", "'", "[", "{",
      "(", ")", "]", "}", "eyJ", "abcdefgh", ".", "-", "_", "&", ",", "x", "://u:", "@", canary,
      "-----BEGIN ", `${header} `, ["PRIVATE", "KEY-----"].join(" "), "bearer ", "secret", "passphrase",
    ];
    let seed = 676;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const count = (text: string) => text.split(canary).length - 1 + text.split(header).length - 1;
    const leaks: string[] = [];
    for (let i = 0; i < 20_000 && leaks.length < 5; i += 1) {
      const length = 2 + (next() % 14);
      let text = "";
      for (let k = 0; k < length; k += 1) text += pieces[next() % pieces.length];
      const shown = count(redactRk9CoordText(text, env));
      if (shown > count(sequential(text)) || shown > count(sequential(text, PRE_RK9_684_DEFAULT))) leaks.push(text);
    }
    expect(leaks).toEqual([]);
  });

  it("hides the PEM header next to a JWT run, as the full regex did (RK9-684 item 8)", () => {
    const text = `eyJabcdefgh.bearer abcdefgh${["-----BEGIN RSA", "PRIVATE", "KEY-----"].join(" ")}`;
    expect(sequential(text)).not.toContain("RSA");
    expect(redactRk9CoordText(text, env)).not.toContain("RSA");
    expect(redactRk9CoordText(text, env)).not.toContain("PRIVATE");
    expect(toRk9CoordLine(text, 500, env)).not.toContain("RSA");
  });
});

describe("RK9-676 linear JWT scan (parent decision)", () => {
  const head = ["ey", "J", "hbGciOiJSU0EtT0FFUCJ9"].join("");
  const jwe = `${head}.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzcSr4qKAq7YN7e9jwQRb23nfa6c9d-StnImGyFDbSv04uVuxIp5Zms1gNxKKK2Da14B8S4rzVRltdYwam_lDp5XnZAYpQdb76FdIKLaVmqgfwX7XWRxv2322i-vDxRfqNzo_tETKzpVLzfiwQyeyPGLBIO56YJ7eObdv0je81860ppamavo35UgoRdbYaBcoh9QcfylQr66oc6vFWXRcZ_ZT2LawVCWTIy3brGPi6UklfCpIMfIjf7iGdXKHzg.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4vpzs9tX_EFShS8iB7j6jiSdiwkIr3ajwQzaBtQD_A.XFBoMYUZodetZdvTiFvSkQ`;

  it.each([[`id-${jwe}`], [`session_${jwe}`], [`a${["eyJ", "hbGciOiJub25lIn0"].join("")}.${["eyJ", "zdWIiOiIxIn0"].join("")}.`], [`{-${jwe}`], [jwe]])(
    "still redacts a glued token %j",
    (input) => {
      expect(redactRk9CoordText(input, env)).not.toContain("OKOawDo13gRp");
      expect(redactRk9CoordText(input, env)).not.toContain("hbGciOiJub25l");
    },
  );

  it("scans `eyJ` repeated over 100 KB in under 50 ms", () => {
    for (const text of ["eyJ".repeat(34_000), `${"eyJ".repeat(34_000)}.x`, "eyJ.".repeat(25_000), "a.".repeat(50_000)]) {
      redactRk9CoordText(text, env);
      const started = performance.now();
      redactRk9CoordText(text, env);
      rk9CoordIdentifierHasSecret(text, env);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(50);
    }
  });

  it("finds exactly the matches of the old JWT regex on a seeded corpus", () => {
    const old = new RegExp(RK9_COORD_JWT_BRANCH, "gi");
    const oldIdentifier = new RegExp(`(?:(?<![A-Za-z0-9])|(?=[^A-Za-z0-9]))(?:${RK9_COORD_JWT_BRANCH})`, "gi");
    const pieces = ["eyJ", "EYJ", "eyj", "a", "Z", "0", "9", "-", "_", ".", " ", "x", "abcdefgh", "/"];
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 20_000; i += 1) {
      let text = "";
      const length = 1 + (next() % 24);
      for (let k = 0; k < length; k += 1) text += pieces[next() % pieces.length];
      const expected = [...text.matchAll(old)].map((match) => [match.index, match.index + match[0].length]);
      expect(rk9CoordJwtSpans(text), text).toEqual(expected);
      oldIdentifier.lastIndex = 0;
      expect(rk9CoordJwtSpans(text, true).length > 0, text).toBe(oldIdentifier.test(text));
    }
  });

  it("keeps the pattern string identical to the bash default", () => {
    expect(RK9_COORD_SECRET_RX_DEFAULT).toContain(`|${RK9_COORD_JWT_BRANCH}|`);
  });
});

// RK9 Custom (RK9-678): the shared keyword set grew (operator decision
// 3.11.2026) and a cap no longer cuts the marker. Leak and false-positive
// fixtures side by side.
describe("RK9-678 shared keyword set", () => {
  const value = ["hunter2", "hunter"].join("");

  it.each([
    [`user=bob pass=${value}`, "user=bob [redacted]"],
    [`DB_PASS=${value} ok`, "DB_[redacted] ok"],
    [`pass%3D${value}`, "[redacted]"],
    [`pw: ${value}`, "[redacted]"],
    [`db_pw=${value}`, "db_[redacted]"],
    [`credentials=${value}`, "[redacted]"],
    [`credential: ${value}`, "[redacted]"],
    [`passphrase=${value}`, "[redacted]"],
    [`private_key: ${value}`, "[redacted]"],
    [`PRIVATE-KEY=${value}`, "[redacted]"],
    [`privatekeys=${value}`, "[redacted]"],
  ])("redacts %j", (input, expected) => {
    expect(redactRk9CoordText(input, env)).toBe(expected);
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
    expect(rk9CoordIdentifierHasSecret(input, env)).toBe(true);
  });

  it.each([
    "cd ~ && pwd=/home/rk9admin",
    "pwd: /home/rk9admin",
    "tests passed=3 skipped=0",
    "compass=northwest",
    "bypass=enabled_mode",
    "second pass: refactoring done",
    "passes=1234567",
    "first-pass-review",
  ])("keeps %j", (input) => {
    expect(redactRk9CoordText(input, env)).toBe(input);
    expect(rk9CoordTextHasSecret(input, env)).toBe(false);
  });

  it("the default pattern itself has the new keywords (the bash copy)", () => {
    const rx = new RegExp(RK9_COORD_SECRET_RX_DEFAULT.replace(`|${RK9_COORD_JWT_BRANCH}`, ""), "gi");
    expect(`user=bob pass=${value}`.replace(rx, "[redacted]")).toBe("user=bob [redacted]");
    expect(`pw=${value} passphrase=${value} private_key=${value} credentials=${value}`.replace(rx, "R")).toBe("R R R R");
    expect(`pwd=/home/rk9admin compass=northwest second pass: refactoring`.replace(rx, "R")).toBe(
      "pwd=/home/rk9admin compass=northwest second pass: refactoring",
    );
  });
});

describe("RK9-678 cap never cuts the marker", () => {
  it("moves a cut inside `[redacted]` to the marker start", () => {
    for (let pad = 125; pad <= 140; pad += 1) {
      const line = toRk9CoordLine(`${"a".repeat(pad)} token=${canary}xyz tail`, 140, env)!;
      expect(Array.from(line).length).toBeLessThanOrEqual(140);
      expect(line).not.toContain(canary);
      // Either the whole marker or none of it.
      expect(line.replace("[redacted]", "")).not.toMatch(/\[r?e?d?a?c?t?e?d?…$|\[…$/);
    }
  });

  it("keeps a marker that fits before the cut", () => {
    const line = toRk9CoordLine(`${"a".repeat(100)} token=${canary}xyz ${"b".repeat(60)}`, 140, env)!;
    expect(line).toContain(" [redacted] b");
    expect(line.endsWith("…")).toBe(true);
    expect(Array.from(line).length).toBe(140);
  });
});

// RK9 Custom (RK9-684): RK9-676 verifier follow-ups (items 1, 5, 6, 8, 10) and
// RK9-690 (the prefix rule no longer swallows the keyword).
describe("RK9-684 redaction follow-ups", () => {
  const value = ["super", "secret", "99"].join("");

  it.each([
    [`token: Bearer ${value}`],
    [`token=Bearer ${value}`],
    [`{"token": "Bearer ${value}"}`],
    [`password: basic ${value}`],
    [`api_key => Bearer ${value} tail`],
  ])("hides the value after `token: Bearer` too (item 1): %j", (input) => {
    expect(redactRk9CoordText(input, env)).not.toContain(value);
    expect(toRk9CoordLine(input, 500, env)).not.toContain(value);
  });

  it.each([
    [`QMK_API_KEY=${value}`, "[redacted]"],
    [`PCP_AGENT_API_KEY=${value}`, "[redacted]"],
    [`VCK_API_KEY=${value}`, "[redacted]"],
    [`SK_LIVE_PASSWORD=${value}`, "[redacted]"],
    [`whsec_api_key: ${value}`, "[redacted]"],
    [`sk-abc123def456ghi789jkl-password=${value}`, "[redacted]"],
    [`rk9_coord_SECRET=${value}`, "[redacted]"],
    [`RK9_COORD_API_TOKEN=${value}`, "[redacted]"],
  ])("RK9-690: the prefix rule leaves the value to the keyword rule: %j", (input, expected) => {
    expect(redactRk9CoordText(input, env)).toBe(expected);
    expect(new RegExp(RK9_COORD_SECRET_RX_DEFAULT, "gi").exec(input)?.[0]).not.toBe(input.split(/[=:]/)[0]);
  });

  it("stops a prefix value before a keyword in the pattern string alone (client parity, RK9-690)", () => {
    const rx = new RegExp(RK9_COORD_SECRET_RX_DEFAULT, "gi");
    for (const input of [`QMK_API_KEY=${value}`, `SK_LIVE_PASSWORD=${value}`, `sk-abc123def456ghi789jkl-password=${value}`]) {
      expect(input.replace(rx, "[redacted]")).not.toContain(value);
    }
    expect(`token: Bearer ${value}`.replace(rx, "[redacted]")).toBe("[redacted]");
  });

  it("still hides a token whose random part holds a keyword (the full prefix rule runs too)", () => {
    const token = `${"gh" + "p_"}tokenABCDEF1234567890`;
    expect(redactRk9CoordText(`x ${token} y`, env)).toBe("x [redacted] y");
    expect(rk9CoordIdentifierHasSecret(token, env)).toBe(true);
  });

  it("does not let one keyword value eat the next keyword (secret=1&secrets: <value>)", () => {
    const input = `${"gh" + "p_"}abcdefghij_secret=1&secrets: ${value} end`;
    expect(redactRk9CoordText(input, env)).not.toContain(value);
    expect(redactRk9CoordText(`secret=1&secrets: ${value}`, env)).not.toContain(value);
  });

  it("keeps counter flags under every keyword name, counts only under token(s) (item 5)", () => {
    expect(redactRk9CoordText(`passphrase: {"cached": true, "output": null}`, env)).toBe(`passphrase: {"cached": true, "output": null}`);
    expect(redactRk9CoordText(`"secret": {"output": false}`, env)).toBe(`"secret": {"output": false}`);
    expect(redactRk9CoordText(`passphrase: {"input": 12}`, env)).toBe("[redacted]");
    expect(redactRk9CoordText(`password: {"hunterpass": true}`, env)).toBe("[redacted]");
    expect(redactRk9CoordText(`tokens: {"input": 12, "cached": true}`, env)).toBe(`tokens: {"input": 12, "cached": true}`);
  });

  it("matches the stored runs exactly, not as substrings (item 6)", () => {
    // `ghijkl` is the tail of the token after the combining mark, and also part of the visible `zzghijklzz`.
    const line = toRk9CoordLine(`zzghijklzz ${"gh" + "p_"}abcdef\u0301ghijkl`, 500, env);
    expect(line).toBe("[redacted]");
  });

  it("splits an override pattern outside character classes (item 10)", () => {
    const override = { RK9_SESSIONS_SECRET_RX: `([)]|${RK9_COORD_JWT_BRANCH}|x)|zzsecretzz` } as NodeJS.ProcessEnv;
    expect(redactRk9CoordText("a ) b zzsecretzz", override)).toBe("a [redacted] b [redacted]");
  });
});
