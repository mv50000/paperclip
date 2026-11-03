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
  it.each(["a\u0000b", "name\u0085x", "na​me", "x‮y", "a\tb"])("rejects control or format characters %j", (to) => {
    expect(sendRk9CoordInboxSchema.safeParse({ to, body: "hi" }).success).toBe(false);
  });

  it("accepts ordinary targets", () => {
    for (const to of ["orchestrator", "RK9-641", "cc:paperclip-01:abc", "Sessio ääkköset"]) {
      expect(sendRk9CoordInboxSchema.safeParse({ to, body: "hi" }).success, to).toBe(true);
    }
  });
});

describe("display text keeps joiners and selectors (RK9-641 item 10)", () => {
  it.each([
    ["coding \u{1F469}‍\u{1F4BB} now", "coding \u{1F469}‍\u{1F4BB} now"],
    ["love ❤️", "love ❤️"],
    ["fire ❤️‍\u{1F525}", "fire ❤️‍\u{1F525}"],
    ["می‌خواهم", "می‌خواهم"],
  ])("keeps %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it("removes a run of three or more joiners or selectors (smuggling)", () => {
    expect(collapseRk9CoordText("hi\u{1F600}︁︂︃︄ there")).toBe("hi\u{1F600} there");
    expect(collapseRk9CoordText("a‌‍‌‍b")).toBe("ab");
    expect(collapseRk9CoordText("a​‍​‍​‍b")).toBe("ab");
  });

  it("still removes bidi overrides, tag characters and controls", () => {
    expect(collapseRk9CoordText("ok ‮hidden⁦ text")).toBe("ok hidden text");
    expect(collapseRk9CoordText("x\u{E0041}\u{E0042}y")).toBe("xy");
    expect(collapseRk9CoordText("a\u0000b\u0085c")).toBe("abc");
  });

  it("fails closed when a single joiner splits a keyword", () => {
    expect(toRk9CoordLine(`pass‌word=${canary} ok`, 140, env)).toBe("[redacted]");
    expect(toRk9CoordLine(`tok️en=${canary}`, 140, env)).toBe("[redacted]");
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
    [`ｔｏｋｅｎ＝${canary}`],
    [`ｐａｓｓｗｏｒｄ: ${canary}`],
  ])("redacts %j", (input) => {
    const out = toRk9CoordLine(`note ${input} end`, 200, env)!;
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(canary);
    expect(rk9CoordTextHasSecret(input, env)).toBe(true);
  });

  it("keeps a bracketed value of numbers, keys or short words (token counts)", () => {
    for (const ok of [`"tokens": {"input": 1234, "output": 56}`, `"tokens": [1234, 5678]`]) {
      expect(rk9CoordTextHasSecret(ok, env), ok).toBe(false);
    }
  });

  it("keeps other full-width text when it has no secret", () => {
    expect(toRk9CoordLine("ｔｅｓｔ ok", 140, env)).toBe("ｔｅｓｔ ok");
    expect(rk9CoordMatchText("ｔｏｋｅｎ")).toBe("token");
  });

  it("documents the prose false positive (item 14): a keyword, a colon and a word", () => {
    expect(toRk9CoordLine("Secrets: rotated today", 140, env)).toBe("[redacted] today");
    expect(toRk9CoordLine("token budget is fine", 140, env)).toBe("token budget is fine");
  });
});

describe("toRk9CoordLine edge cases (RK9-641)", () => {
  it("does not let a raw-only match mask a second, hidden secret", () => {
    const text = `ssh://u:pa\tss@h Bearer​${canary}xyz`;
    const out = toRk9CoordLine(text, 200, env)!;
    expect(out).not.toContain(canary);
  });

  it("caps with an ellipsis", () => {
    expect(toRk9CoordLine("a".repeat(50), 10, env)).toBe(`${"a".repeat(9)}…`);
    expect(toRk9CoordLine("x".repeat(500), 140, env)).toHaveLength(140);
  });
});
