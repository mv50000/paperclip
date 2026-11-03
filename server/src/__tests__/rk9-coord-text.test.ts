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
