import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  PREFIX_TO_VAULT_SLUG,
  buildQmdArgs,
  buildRecallCollections,
  clampLimit,
  collectionFromUri,
  parseQmdJson,
  recallKnowledge,
  type QmdRunner,
} from "./knowledge-recall.js";

// recallKnowledge calls logActivity(db, ...) best-effort; a stub db that rejects is fine
// because the service swallows activity-log failures. We inject resolveSlug + runQmd so
// neither a real DB nor the qmd binary is needed.
const stubDb = {} as unknown as Db;

// Real `qmd search --json` row shape: {docid, score, file, line, title, snippet}.
// There is no `path` or `collection` field — collection = the qmd://<col>/ prefix of `file`.
function qmdRows(
  rows: Array<Partial<{ docid: string; file: string; title: string; score: number; line: number; snippet: string }>>,
) {
  return JSON.stringify(rows);
}

describe("buildRecallCollections", () => {
  it("scopes a company to its own collection + shared", () => {
    expect(buildRecallCollections("rk9")).toEqual(["rk9", "shared"]);
    expect(buildRecallCollections("sunspot")).toEqual(["sunspot", "shared"]);
  });
  it("shared queries only shared", () => {
    expect(buildRecallCollections("shared")).toEqual(["shared"]);
  });
});

describe("clampLimit", () => {
  it("defaults and caps", () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(10);
    expect(clampLimit(3)).toBe(3);
    expect(clampLimit(999)).toBe(50);
  });
});

describe("buildQmdArgs", () => {
  it("emits search with -c per collection, -n limit, and --json", () => {
    expect(buildQmdArgs("token use", ["rk9", "shared"], 5)).toEqual([
      "search",
      "token use",
      "-c",
      "rk9",
      "-c",
      "shared",
      "-n",
      "5",
      "--json",
    ]);
  });
});

describe("collectionFromUri", () => {
  it("extracts the collection from a qmd:// uri", () => {
    expect(collectionFromUri("qmd://rk9/projects/a.md")).toBe("rk9");
    expect(collectionFromUri("qmd://shared/resources/b.md")).toBe("shared");
  });
  it("returns empty for a non-matching uri", () => {
    expect(collectionFromUri("/opt/repos/rk9-knowledge/rk9/a.md")).toBe("");
    expect(collectionFromUri("")).toBe("");
    expect(collectionFromUri("qmd://rk9")).toBe(""); // no trailing slash -> no path
  });
});

describe("parseQmdJson", () => {
  const allowed = new Set(["rk9", "shared"]);
  it("parses valid rows in scope (collection derived from file uri)", () => {
    const out = parseQmdJson(
      qmdRows([{ file: "qmd://rk9/resources/a.md", title: "A", score: 0.86, snippet: "hi" }]),
      allowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sourcePath: "qmd://rk9/resources/a.md", title: "A", score: 0.86, collection: "rk9" });
  });
  it("drops rows from a collection outside the allowed scope (cross-company leak guard)", () => {
    const out = parseQmdJson(
      qmdRows([
        { file: "qmd://rk9/a.md", snippet: "ok" },
        { file: "qmd://ololla/secret.md", snippet: "LEAK" },
      ]),
      allowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0].collection).toBe("rk9");
  });
  it("returns empty on blank or invalid JSON", () => {
    expect(parseQmdJson("", allowed)).toEqual([]);
    expect(parseQmdJson("not json", allowed)).toEqual([]);
    expect(parseQmdJson("{}", allowed)).toEqual([]);
  });
});

describe("PREFIX_TO_VAULT_SLUG", () => {
  it("maps every fleet prefix to its vault slug", () => {
    expect(PREFIX_TO_VAULT_SLUG).toMatchObject({
      RK9: "rk9",
      SAA: "saatavilla",
      ALL: "alli-audit",
      QUA: "quantimodo",
      OLL: "ololla",
      AUR: "sunspot",
      SEC: "paperclip",
    });
  });
});

describe("recallKnowledge", () => {
  it("queries ONLY the company's own collection + shared (scoping enforced server-side)", async () => {
    const seen: string[][] = [];
    const runQmd: QmdRunner = async (args) => {
      // capture the -c collection args
      const cols: string[] = [];
      for (let i = 0; i < args.length; i++) if (args[i] === "-c") cols.push(args[i + 1]);
      seen.push(cols);
      return { stdout: qmdRows([{ file: "qmd://rk9/a.md", snippet: "x", score: 0.5 }]), timedOut: false };
    };
    const res = await recallKnowledge(
      stubDb,
      { query: "anything", companyId: "company-uuid" },
      { runQmd, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(seen).toEqual([["rk9", "shared"]]);
    expect(res.collections).toEqual(["rk9", "shared"]);
    expect(res.snippets).toHaveLength(1);
  });

  it("filters out any out-of-scope row even if qmd returned one", async () => {
    const runQmd: QmdRunner = async () => ({
      stdout: qmdRows([
        { file: "qmd://rk9/a.md", snippet: "ok", score: 0.9 },
        { file: "qmd://quantimodo/secret.md", snippet: "LEAK", score: 0.99 },
      ]),
      timedOut: false,
    });
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets.every((s) => s.collection === "rk9" || s.collection === "shared")).toBe(true);
    expect(res.snippets.find((s) => s.snippet === "LEAK")).toBeUndefined();
  });

  it("returns empty + timedOut when qmd is killed at the deadline (never blocks the agent)", async () => {
    const runQmd: QmdRunner = async () => ({ stdout: "", timedOut: true });
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets).toEqual([]);
    expect(res.timedOut).toBe(true);
  });

  it("returns empty and does not invoke qmd for an unmapped company", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: "", timedOut: false }));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, resolveSlug: async () => null, vaultRoot: "/tmp/vault" },
    );
    expect(runQmd).not.toHaveBeenCalled();
    expect(res.snippets).toEqual([]);
    expect(res.collections).toEqual([]);
  });

  it("returns empty (not throw) when the qmd runner errors", async () => {
    const runQmd: QmdRunner = async () => {
      throw new Error("qmd: command not found");
    };
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets).toEqual([]);
  });
});
