import { describe, expect, it, vi } from "vitest";
import { normalizeGithubRepo } from "../services/github-repo-ownership.js";

describe("normalizeGithubRepo", () => {
  it.each([
    ["rk9-ai/saatavilla", "rk9-ai/saatavilla"],
    ["RK9-AI/Saatavilla", "rk9-ai/saatavilla"],
    ["https://github.com/mv50000/bk.git", "mv50000/bk"],
    ["https://github.com/rk9-ai/sunspot", "rk9-ai/sunspot"],
    ["https://github.com/rk9-ai/sunspot/", "rk9-ai/sunspot"],
    ["git@github.com:rk9-ai/last-shadow.git", "rk9-ai/last-shadow"],
    ["ssh://git@github.com/rk9-ai/onni-ja-alma.git", "rk9-ai/onni-ja-alma"],
    ["  mv50000/paperclip \n", "mv50000/paperclip"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeGithubRepo(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "not a repo", "https://gitlab.com/a/b", "a/b/c"])(
    "returns null for %j",
    (input) => {
      expect(normalizeGithubRepo(input as string | null | undefined)).toBeNull();
    },
  );
});

describe("createGithubRepoOwnership", () => {
  async function build(secretRows: unknown[], workspaceRows: unknown[], secretValues: Record<string, string | Error>) {
    vi.resetModules();
    vi.doMock("../services/secrets.js", () => ({
      secretService: () => ({
        resolveSecretValue: async (_companyId: string, secretId: string) => {
          const v = secretValues[secretId];
          if (v instanceof Error) throw v;
          return v;
        },
      }),
    }));
    const results = [secretRows, workspaceRows];
    const db = {
      select: () => {
        const chain = { from: () => chain, where: async () => results.shift() ?? [] };
        return chain;
      },
    };
    const mod = await import("../services/github-repo-ownership.js");
    return mod.createGithubRepoOwnership(db as any);
  }

  it("merges secret values and project workspace repo urls per company", async () => {
    const ownership = await build(
      [
        { id: "s1", companyId: "saa" },
        { id: "s2", companyId: "rk9" },
        { id: "s3", companyId: "broken" },
      ],
      [
        { companyId: "oll", repoUrl: "https://github.com/mv50000/bk.git" },
        { companyId: "saa", repoUrl: "https://github.com/rk9-ai/saatavilla.git" },
      ],
      { s1: "rk9-ai/saatavilla", s2: "mv50000/paperclip, rk9-ai/other", s3: new Error("decrypt failed") },
    );
    expect([...(await ownership.companiesOwningRepo("RK9-ai/Saatavilla"))]).toEqual(["saa"]);
    expect([...(await ownership.companiesOwningRepo("mv50000/paperclip"))]).toEqual(["rk9"]);
    expect([...(await ownership.companiesOwningRepo("rk9-ai/other"))]).toEqual(["rk9"]);
    expect([...(await ownership.companiesOwningRepo("mv50000/bk"))]).toEqual(["oll"]);
  });

  it("returns an empty set for an unmapped repo, an unreadable secret, or a malformed name", async () => {
    const ownership = await build([{ id: "s3", companyId: "broken" }], [], { s3: new Error("decrypt failed") });
    expect((await ownership.companiesOwningRepo("rk9-ai/liigaveikkaus")).size).toBe(0);
    expect((await ownership.companiesOwningRepo("")).size).toBe(0);
  });

  it("returns every company when two companies own the same repo", async () => {
    const ownership = await build(
      [
        { id: "s1", companyId: "sec" },
        { id: "s2", companyId: "rk9" },
      ],
      [],
      { s1: "mv50000/paperclip", s2: "mv50000/paperclip" },
    );
    expect([...(await ownership.companiesOwningRepo("mv50000/paperclip"))].sort()).toEqual(["rk9", "sec"]);
  });
});
