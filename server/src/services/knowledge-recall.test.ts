import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  PREFIX_TO_VAULT_SLUG,
  buildQmdArgs,
  candidateCollections,
  clampLimit,
  collectionFromUri,
  parseCollectionList,
  parseQmdJson,
  recallKnowledge,
  type QmdRunner,
} from "./knowledge-recall.js";

// recallKnowledge calls logActivity(db, ...) best-effort; a stub db that rejects is fine
// because the service swallows activity-log failures. We inject resolveSlug + runQmd +
// listCollections so neither a real DB nor the qmd binary is needed.
const stubDb = {} as unknown as Db;

// Real `qmd vsearch --json` row shape: {docid, score, file, line, title, snippet}.
// There is no `path` or `collection` field — collection = the qmd://<col>/ prefix of `file`.
function qmdRows(
  rows: Array<Partial<{ docid: string; file: string; title: string; score: number; line: number; snippet: string }>>,
) {
  return JSON.stringify(rows);
}

describe("candidateCollections", () => {
  it("scopes a company to its facts + docs collections + shared", () => {
    expect(candidateCollections("rk9")).toEqual(["rk9", "rk9-docs", "shared"]);
    expect(candidateCollections("sunspot")).toEqual(["sunspot", "sunspot-docs", "shared"]);
  });
  it("shared queries only shared", () => {
    expect(candidateCollections("shared")).toEqual(["shared"]);
  });
});

describe("parseCollectionList", () => {
  it("parses qmd collection list output into names", () => {
    const out = parseCollectionList(
      "Collections (3):\n\nrk9 (qmd://rk9/)\nshared (qmd://shared/)\nsunspot-docs (qmd://sunspot-docs/)\n",
    );
    expect(out).toEqual(["rk9", "shared", "sunspot-docs"]);
  });
  it("returns empty for noise", () => {
    expect(parseCollectionList("")).toEqual([]);
    expect(parseCollectionList("no collections here")).toEqual([]);
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
  it("emits vsearch with -c per collection, -n limit, and --json", () => {
    expect(buildQmdArgs("token use", ["rk9", "shared"], 5)).toEqual([
      "vsearch",
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
    expect(collectionFromUri("qmd://sunspot-docs/doc/b.md")).toBe("sunspot-docs");
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

// helper: capture the -c collection args a runQmd was called with
function captureRunQmd(stdout: string): { runQmd: QmdRunner; seen: string[][] } {
  const seen: string[][] = [];
  const runQmd: QmdRunner = async (args) => {
    const cols: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "-c") cols.push(args[i + 1]);
    seen.push(cols);
    return { stdout, timedOut: false };
  };
  return { runQmd, seen };
}

describe("recallKnowledge", () => {
  it("scopes to the company's existing collections only (facts + shared when no docs exist)", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://rk9/a.md", snippet: "x", score: 0.5 }]));
    const res = await recallKnowledge(
      stubDb,
      { query: "anything", companyId: "company-uuid" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(seen).toEqual([["rk9", "shared"]]); // rk9-docs candidate dropped (does not exist)
    expect(res.collections).toEqual(["rk9", "shared"]);
    expect(res.snippets).toHaveLength(1);
  });

  it("includes the <slug>-docs collection when it exists, and drops the non-existent facts collection", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://sunspot-docs/doc/a.md", snippet: "x", score: 0.6 }]));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        listCollections: async () => ["rk9", "shared", "sunspot-docs", "saatavilla-docs"],
        resolveSlug: async () => "sunspot",
        vaultRoot: "/tmp/vault",
      },
    );
    // candidates [sunspot, sunspot-docs, shared] ∩ existing => [sunspot-docs, shared]
    expect(seen).toEqual([["sunspot-docs", "shared"]]);
    expect(res.collections).toEqual(["sunspot-docs", "shared"]);
    expect(res.snippets).toHaveLength(1);
  });

  it("never queries another company's collection (cross-company isolation)", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        // even though ololla-docs exists in the index, a sunspot caller must never see it
        listCollections: async () => ["sunspot-docs", "ololla-docs", "shared"],
        resolveSlug: async () => "sunspot",
        vaultRoot: "/tmp/vault",
      },
    );
    expect(seen).toEqual([["sunspot-docs", "shared"]]);
    expect(seen[0]).not.toContain("ololla-docs");
  });

  it("filters out any out-of-scope row even if qmd returned one (defense in depth)", async () => {
    const runQmd: QmdRunner = async () => ({
      stdout: qmdRows([
        { file: "qmd://rk9/a.md", snippet: "ok", score: 0.9 },
        { file: "qmd://quantimodo-docs/secret.md", snippet: "LEAK", score: 0.99 },
      ]),
      timedOut: false,
    });
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets.every((s) => s.collection === "rk9" || s.collection === "shared")).toBe(true);
    expect(res.snippets.find((s) => s.snippet === "LEAK")).toBeUndefined();
  });

  it("returns empty + timedOut when qmd is killed at the deadline (never blocks the caller)", async () => {
    const runQmd: QmdRunner = async () => ({ stdout: "", timedOut: true });
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets).toEqual([]);
    expect(res.timedOut).toBe(true);
  });

  it("returns empty and does not invoke qmd for an unmapped company", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: "", timedOut: false }));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => null, vaultRoot: "/tmp/vault" },
    );
    expect(runQmd).not.toHaveBeenCalled();
    expect(res.snippets).toEqual([]);
    expect(res.collections).toEqual([]);
  });

  it("does not invoke vsearch when none of the candidate collections exist", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: qmdRows([]), timedOut: false }));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => [], resolveSlug: async () => "sunspot", vaultRoot: "/tmp/vault" },
    );
    expect(runQmd).not.toHaveBeenCalled();
    expect(res.snippets).toEqual([]);
    expect(res.collections).toEqual([]);
  });

  it("falls back to shared only when listing collections fails", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://shared/a.md", snippet: "x", score: 0.4 }]));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        listCollections: async () => {
          throw new Error("qmd collection list failed");
        },
        resolveSlug: async () => "sunspot",
        vaultRoot: "/tmp/vault",
      },
    );
    expect(seen).toEqual([["shared"]]); // candidates ∩ [shared] (fallback) => [shared]
    expect(res.collections).toEqual(["shared"]);
  });

  it("returns empty (not throw) when the qmd runner errors", async () => {
    const runQmd: QmdRunner = async () => {
      throw new Error("qmd: command not found");
    };
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets).toEqual([]);
  });

  it("operator mode (allCollections) searches EVERY existing collection, not just the company's", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://ololla-docs/a.md", snippet: "x", score: 0.7 }]));
    const all = ["rk9", "shared", "sunspot-docs", "ololla-docs", "quantimodo-docs"];
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c", allCollections: true },
      { runQmd, listCollections: async () => all, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(seen).toEqual([all]); // every collection passed to qmd
    expect(res.collections).toEqual(all);
    expect(res.snippets).toHaveLength(1);
  });

  it("operator mode works even when the company has no slug (admin passes any company id)", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    const all = ["rk9", "shared", "sunspot-docs"];
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c", allCollections: true },
      { runQmd, listCollections: async () => all, resolveSlug: async () => null, vaultRoot: "/tmp/vault" },
    );
    expect(seen).toEqual([all]);
  });

  it("WITHOUT allCollections, stays company-scoped even if many collections exist (isolation)", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        listCollections: async () => ["rk9", "shared", "sunspot-docs", "ololla-docs"],
        resolveSlug: async () => "sunspot",
        vaultRoot: "/tmp/vault",
      },
    );
    expect(seen).toEqual([["sunspot-docs", "shared"]]); // NOT ololla-docs, NOT rk9
  });
});
