import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  PREFIX_TO_VAULT_SLUG,
  buildQmdArgs,
  candidateCollections,
  clampLimit,
  collectionFromUri,
  defaultRunQmd,
  fuseRRF,
  parseCollectionList,
  parseQmdJson,
  recallKnowledge,
  rowsToSnippets,
  type QmdDaemonQuery,
  type QmdRunner,
  type RecallSnippet,
} from "./knowledge-recall.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// recallKnowledge calls logActivity(db, ...) best-effort; a stub db that rejects is fine
// because the service swallows activity-log failures. We inject resolveSlug + runQmd +
// listCollections so neither a real DB nor the qmd binary is needed.
const stubDb = {} as unknown as Db;

// Every recallKnowledge test below stubs the qmd-mcp daemon to "unavailable" (null) unless it's
// specifically testing the daemon path, so these CLI-path/isolation/fusion tests keep exercising
// exactly what they did before RK9-186 without making a real network call to a daemon that may
// not be running in CI.
const noDaemon: QmdDaemonQuery = async () => null;

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
  it("emits vsearch (default) with -c per collection, -n limit, and --json", () => {
    expect(buildQmdArgs("token use", ["rk9", "shared"], 5)).toEqual([
      "vsearch", "token use", "-c", "rk9", "-c", "shared", "-n", "5", "--json",
    ]);
  });
  it("emits BM25 search when mode=search", () => {
    expect(buildQmdArgs("CT357", ["rk9"], 3, "search")).toEqual([
      "search", "CT357", "-c", "rk9", "-n", "3", "--json",
    ]);
  });
});

describe("fuseRRF", () => {
  const snip = (p: string, score = 0.5): RecallSnippet => ({ sourcePath: p, title: p, score, collection: "rk9", snippet: "" });
  it("dedups by sourcePath and boosts a doc found in BOTH lists above singletons", () => {
    const A = snip("qmd://rk9/a.md"), B = snip("qmd://rk9/b.md"), C = snip("qmd://rk9/c.md");
    const out = fuseRRF([[A, B], [C, A]], 10); // A appears in both → highest RRF
    expect(out[0].sourcePath).toBe("qmd://rk9/a.md");
    expect(out.map((s) => s.sourcePath).sort()).toEqual(["qmd://rk9/a.md", "qmd://rk9/b.md", "qmd://rk9/c.md"]);
  });
  it("surfaces a doc that only the second (BM25) list found", () => {
    const out = fuseRRF([[snip("qmd://rk9/semantic.md")], [snip("qmd://rk9/ct357.md")]], 10);
    expect(out.map((s) => s.sourcePath)).toContain("qmd://rk9/ct357.md");
  });
  it("respects the limit", () => {
    expect(fuseRRF([[snip("a"), snip("b"), snip("c")]], 2)).toHaveLength(2);
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

describe("rowsToSnippets — daemon row shape (RK9-186 follow-up)", () => {
  const allowed = new Set(["rk9", "shared"]);

  it("normalizes a prefix-less daemon `file` (real production shape) into the qmd:// form the CLI path already uses", () => {
    // Confirmed against production 2026-09-12: the daemon's query tool answers with `file` as a
    // bare `<collection>/<path>`, not a `qmd://` URI — this is exactly the shape that made every
    // daemon recall silently return recall=0 before this fix.
    const out = rowsToSnippets(
      [
        {
          context: "…",
          docid: "#2feeaf",
          file: "rk9/resources/sunspot-hetzner-frontend-hang.md",
          line: 12,
          score: 0.91,
          snippet: "hang detail",
          title: "Sunspot Hetzner frontend hang",
        },
      ],
      allowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourcePath: "qmd://rk9/resources/sunspot-hetzner-frontend-hang.md",
      collection: "rk9",
      title: "Sunspot Hetzner frontend hang",
      score: 0.91,
    });
  });

  it("still rejects a prefix-less row from an out-of-scope/personal collection — missing the qmd:// prefix is not a free pass", () => {
    const out = rowsToSnippets([{ file: "personal/secret.md", snippet: "LEAK" }], allowed);
    expect(out).toEqual([]);
  });

  it("leaves an already-prefixed CLI-style file untouched (no double qmd://qmd:// prefixing)", () => {
    const out = rowsToSnippets([{ file: "qmd://rk9/a.md", snippet: "x" }], allowed);
    expect(out[0].sourcePath).toBe("qmd://rk9/a.md");
  });

  it("treats a missing/non-string file the same as before (empty collection, rejected)", () => {
    expect(rowsToSnippets([{ snippet: "no file field" }], allowed)).toEqual([]);
    expect(rowsToSnippets([{ file: "", snippet: "empty file" }], allowed)).toEqual([]);
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

// helper: capture the UNIQUE -c collection scope(s) a runQmd was called with. Hybrid runs the same
// scope twice (BM25 `search` + `vsearch`); we record the scope once so scope assertions stay simple.
function captureRunQmd(stdout: string): { runQmd: QmdRunner; seen: string[][] } {
  const seen: string[][] = [];
  const runQmd: QmdRunner = async (args) => {
    const cols: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "-c") cols.push(args[i + 1]);
    if (!seen.some((s) => s.join(",") === cols.join(","))) seen.push(cols);
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
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
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
        queryDaemon: noDaemon,
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
        queryDaemon: noDaemon,
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
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    expect(res.snippets.every((s) => s.collection === "rk9" || s.collection === "shared")).toBe(true);
    expect(res.snippets.find((s) => s.snippet === "LEAK")).toBeUndefined();
  });

  it("returns empty + timedOut when qmd is killed at the deadline (never blocks the caller)", async () => {
    const runQmd: QmdRunner = async () => ({ stdout: "", timedOut: true });
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    expect(res.snippets).toEqual([]);
    expect(res.timedOut).toBe(true);
  });

  it("returns empty and does not invoke qmd for an unmapped company", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: "", timedOut: false }));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => null, vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
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
      { runQmd, listCollections: async () => [], resolveSlug: async () => "sunspot", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
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
        queryDaemon: noDaemon,
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
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    expect(res.snippets).toEqual([]);
  });

  it("operator mode (allCollections) searches EVERY existing collection, not just the company's", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://ololla-docs/a.md", snippet: "x", score: 0.7 }]));
    const all = ["rk9", "shared", "sunspot-docs", "ololla-docs", "quantimodo-docs"];
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c", allCollections: true },
      { runQmd, listCollections: async () => all, resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    expect(seen).toEqual([all]); // every collection passed to qmd
    expect(res.collections).toEqual(all);
    expect(res.snippets).toHaveLength(1);
  });

  it("operator mode NEVER returns the operator's personal collections", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c", allCollections: true },
      {
        runQmd,
        listCollections: async () => ["rk9", "shared", "personal", "personal-sensitive"],
        resolveSlug: async () => "rk9",
        vaultRoot: "/tmp/vault",
        queryDaemon: noDaemon,
      },
    );
    expect(seen).toEqual([["rk9", "shared"]]); // personal* never reaches qmd
    expect(res.collections).toEqual(["rk9", "shared"]);
  });

  it("company scope never resolves a personal collection even if a slug collides", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        listCollections: async () => ["personal", "personal-docs", "shared"],
        resolveSlug: async () => "personal",
        vaultRoot: "/tmp/vault",
        queryDaemon: noDaemon,
      },
    );
    expect(seen).toEqual([["shared"]]);
  });

  it("operator mode works even when the company has no slug (admin passes any company id)", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([]));
    const all = ["rk9", "shared", "sunspot-docs"];
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c", allCollections: true },
      { runQmd, listCollections: async () => all, resolveSlug: async () => null, vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
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
        queryDaemon: noDaemon,
      },
    );
    expect(seen).toEqual([["sunspot-docs", "shared"]]); // NOT ololla-docs, NOT rk9
  });

  it("at the concurrency cap, sheds the model-loading vsearch and serves BM25-only (busy=true)", async () => {
    const modes: string[] = [];
    const runQmd: QmdRunner = async (args) => {
      modes.push(String(args[0]));
      return { stdout: qmdRows([{ file: "qmd://rk9/a.md", snippet: "x", score: 0.5 }]), timedOut: false };
    };
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", maxConcurrent: 0, queryDaemon: noDaemon },
    );
    expect(res.busy).toBe(true);
    expect(modes).toEqual(["search"]); // BM25 ran (cheap, no model); vsearch was shed
    expect(res.snippets).toHaveLength(1); // BM25-only results still served (graceful, not empty)
  });

  it("fuses vsearch + bm25 so a keyword-only hit surfaces alongside semantic hits", async () => {
    const runQmd: QmdRunner = async (args) =>
      args[0] === "vsearch"
        ? { stdout: qmdRows([{ file: "qmd://rk9/semantic.md", title: "Sem", snippet: "", score: 0.6 }]), timedOut: false }
        : { stdout: qmdRows([{ file: "qmd://rk9/ct357.md", title: "CT357", snippet: "", score: 0.95 }]), timedOut: false };
    const res = await recallKnowledge(
      stubDb,
      { query: "CT357", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    const files = res.snippets.map((s) => s.sourcePath);
    expect(files).toContain("qmd://rk9/ct357.md"); // BM25-only hit surfaced (the whole point)
    expect(files).toContain("qmd://rk9/semantic.md"); // semantic hit also present
  });

  it("is not busy on a normal call (cap not hit)", async () => {
    const { runQmd } = captureRunQmd(qmdRows([{ file: "qmd://rk9/a.md", snippet: "x", score: 0.5 }]));
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", queryDaemon: noDaemon },
    );
    expect(res.busy).toBe(false);
    expect(res.snippets).toHaveLength(1);
  });
});

describe("recallKnowledge — qmd-mcp daemon path (RK9-186)", () => {
  it("uses the daemon's results and never touches the CLI (not vsearch, not BM25) when the daemon answers", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: qmdRows([{ file: "qmd://rk9/cli-only.md" }]), timedOut: false }));
    const queryDaemon: QmdDaemonQuery = async () => [{ file: "qmd://rk9/from-daemon.md", score: 0.8, title: "D", snippet: "s" }];
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets.map((s) => s.sourcePath)).toContain("qmd://rk9/from-daemon.md");
    expect(res.snippets.map((s) => s.sourcePath)).not.toContain("qmd://rk9/cli-only.md");
    // The daemon's own `query` call already runs lex+vec in one round trip — a successful daemon
    // answer means NEITHER CLI pass (BM25 `search` nor `vsearch`) is invoked at all.
    expect(runQmd).not.toHaveBeenCalled();
  });

  it("surfaces daemon results even when `file` has no qmd:// prefix — production regression: every daemon recall silently returned recall=0 until this was fixed", async () => {
    const { runQmd } = captureRunQmd(qmdRows([]));
    // Exact row shape verified against the real daemon in production (2026-09-12).
    const queryDaemon: QmdDaemonQuery = async () => [
      {
        context: "…",
        docid: "#2feeaf",
        file: "rk9/resources/sunspot-hetzner-frontend-hang.md",
        line: 12,
        score: 0.91,
        snippet: "hang detail",
        title: "Sunspot Hetzner frontend hang",
      },
    ];
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets).toHaveLength(1);
    expect(res.snippets[0]).toMatchObject({
      sourcePath: "qmd://rk9/resources/sunspot-hetzner-frontend-hang.md",
      collection: "rk9",
      title: "Sunspot Hetzner frontend hang",
    });
  });

  it("logs a warning when the daemon returns rows but every one is filtered out by scope (silent-empty-recall signal)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const { runQmd } = captureRunQmd(qmdRows([]));
      // Out of scope for an "rk9" caller, prefix-less form included — must not slip through.
      const queryDaemon: QmdDaemonQuery = async () => [
        { file: "ololla-docs/x.md", snippet: "x" },
        { file: "qmd://quantimodo-docs/y.md", snippet: "y" },
      ];
      const res = await recallKnowledge(
        stubDb,
        { query: "q", companyId: "c" },
        { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
      );
      expect(res.snippets).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ rowCount: 2 }),
        "knowledge-recall: daemon returned rows but none matched the allowed scope after filtering",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when the daemon simply returns zero rows (that's a normal empty result, not a filtering anomaly)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const { runQmd } = captureRunQmd(qmdRows([]));
      const queryDaemon: QmdDaemonQuery = async () => [];
      await recallKnowledge(
        stubDb,
        { query: "q", companyId: "c" },
        { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        "knowledge-recall: daemon returned rows but none matched the allowed scope after filtering",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to the CLI vsearch path when the daemon is unavailable, WITHOUT the concurrency cap counting it against the daemon call itself", async () => {
    const { runQmd, seen } = captureRunQmd(qmdRows([{ file: "qmd://rk9/from-cli.md", snippet: "x", score: 0.5 }]));
    const queryDaemon: QmdDaemonQuery = async () => null; // daemon down/erroring
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(seen).toEqual([["rk9", "shared"]]); // CLI was actually invoked with the same scope
    expect(res.snippets.map((s) => s.sourcePath)).toContain("qmd://rk9/from-cli.md");
    expect(res.busy).toBe(false);
  });

  it("logs no CLI-path WARNs when the caller's request was already aborted before the daemon call (RK9-199)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    try {
      const controller = new AbortController();
      controller.abort();
      const runQmd = vi.fn<QmdRunner>(defaultRunQmd);
      const queryDaemon: QmdDaemonQuery = async () => null; // daemon unavailable → CLI fallback path
      const res = await recallKnowledge(
        stubDb,
        { query: "q", companyId: "c", signal: controller.signal },
        { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
      );
      expect(res.snippets).toEqual([]);
      // Only the (unrelated, pre-existing) best-effort activity-log warning is allowed here — no
      // "bm25/vsearch pass failed" WARN from the CLI fallback path, since the aborted signal makes
      // defaultRunQmd resolve immediately instead of throwing.
      for (const call of warnSpy.mock.calls) {
        expect(call[1]).not.toMatch(/bm25|vsearch/);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("falls back to CLI and sheds under the concurrency cap when BOTH the daemon and the cap are unavailable", async () => {
    const runQmd = vi.fn<QmdRunner>(async (args) => ({
      stdout: args[0] === "search" ? qmdRows([{ file: "qmd://rk9/bm25.md", snippet: "x", score: 0.3 }]) : qmdRows([]),
      timedOut: false,
    }));
    const queryDaemon: QmdDaemonQuery = async () => null;
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault", maxConcurrent: 0 },
    );
    expect(res.busy).toBe(true);
    // vsearch mode never invoked (shed); only the BM25 "search" pass ran.
    expect(runQmd.mock.calls.map((c) => c[0][0])).toEqual(["search"]);
    expect(res.snippets.map((s) => s.sourcePath)).toContain("qmd://rk9/bm25.md");
  });

  it("passes the daemon EXACTLY the already-filtered non-personal company scope — never omitted, never widened", async () => {
    const { runQmd } = captureRunQmd(qmdRows([]));
    let seenCollections: readonly string[] | undefined;
    const queryDaemon: QmdDaemonQuery = async (_query, collections) => {
      seenCollections = collections;
      return [];
    };
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      {
        runQmd,
        queryDaemon,
        // the index also contains the operator's personal vault and another company's docs
        listCollections: async () => ["rk9", "rk9-docs", "shared", "personal", "personal-sensitive", "ololla-docs"],
        resolveSlug: async () => "rk9",
        vaultRoot: "/tmp/vault",
      },
    );
    expect(seenCollections).toBeDefined();
    expect(seenCollections).toEqual(["rk9", "rk9-docs", "shared"]);
    expect(seenCollections).not.toContain("personal");
    expect(seenCollections).not.toContain("personal-sensitive");
    expect(seenCollections).not.toContain("ololla-docs");
  });

  it("still enforces the allowed-collection filter on daemon rows (defense in depth, mirrors the CLI path)", async () => {
    const { runQmd } = captureRunQmd(qmdRows([]));
    const queryDaemon: QmdDaemonQuery = async () => [
      { file: "qmd://rk9/ok.md", snippet: "ok", score: 0.9 },
      { file: "qmd://quantimodo-docs/secret.md", snippet: "LEAK", score: 0.99 },
    ];
    const res = await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => ["rk9", "shared"], resolveSlug: async () => "rk9", vaultRoot: "/tmp/vault" },
    );
    expect(res.snippets.find((s) => s.snippet === "LEAK")).toBeUndefined();
    expect(res.snippets.map((s) => s.sourcePath)).toContain("qmd://rk9/ok.md");
  });

  it("never calls the daemon when no collections are in scope", async () => {
    const runQmd = vi.fn<QmdRunner>(async () => ({ stdout: qmdRows([]), timedOut: false }));
    const queryDaemon = vi.fn<QmdDaemonQuery>(async () => []);
    await recallKnowledge(
      stubDb,
      { query: "q", companyId: "c" },
      { runQmd, queryDaemon, listCollections: async () => [], resolveSlug: async () => "sunspot", vaultRoot: "/tmp/vault" },
    );
    expect(queryDaemon).not.toHaveBeenCalled();
    expect(runQmd).not.toHaveBeenCalled();
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Exercises the REAL spawn/kill path (defaultRunQmd), not the injectable QmdRunner stub the
// suites above use — the bug (RK9-181) was specifically in how the immediate child is killed,
// so it can only be caught by actually spawning and signaling processes.
describe("defaultRunQmd — process-group kill (RK9-181)", () => {
  const fixture = join(__dirname, "__fixtures__", "fake-qmd-launcher.mjs");
  const originalBin = process.env.PAPERCLIP_QMD_BIN;
  const originalGrace = process.env.PAPERCLIP_QMD_KILL_GRACE_MS;

  afterEach(() => {
    if (originalBin === undefined) delete process.env.PAPERCLIP_QMD_BIN;
    else process.env.PAPERCLIP_QMD_BIN = originalBin;
    if (originalGrace === undefined) delete process.env.PAPERCLIP_QMD_KILL_GRACE_MS;
    else process.env.PAPERCLIP_QMD_KILL_GRACE_MS = originalGrace;
  });

  it("kills the whole process group on timeout — the grandchild worker dies too, not just the launcher", async () => {
    // "qmd" launcher stand-in = node running our fixture script directly.
    process.env.PAPERCLIP_QMD_BIN = process.execPath;
    process.env.PAPERCLIP_QMD_KILL_GRACE_MS = "50"; // keep the test fast

    const outFile = join(tmpdir(), `qmd-fixture-${process.pid}-${Date.now()}.json`);
    try {
      const result = await defaultRunQmd([fixture, outFile], { cwd: __dirname, timeoutMs: 200 });
      expect(result.timedOut).toBe(true);

      const { launcherPid, workerPid } = JSON.parse(readFileSync(outFile, "utf8")) as {
        launcherPid: number;
        workerPid: number;
      };
      await waitUntil(() => !isAlive(launcherPid) && !isAlive(workerPid), 8_000);
      expect(isAlive(launcherPid)).toBe(false);
      // The orphan RK9-181 fixes: a single-pid kill of launcherPid alone would leave this alive
      // (the worker ignores SIGTERM, and killing only the launcher never reaches it at all).
      expect(isAlive(workerPid)).toBe(false);
    } finally {
      rmSync(outFile, { force: true });
    }
  }, 15_000);

  it("kills the process group on client-disconnect (AbortSignal), independent of the timeout", async () => {
    process.env.PAPERCLIP_QMD_BIN = process.execPath;
    process.env.PAPERCLIP_QMD_KILL_GRACE_MS = "50";

    const outFile = join(tmpdir(), `qmd-fixture-abort-${process.pid}-${Date.now()}.json`);
    const controller = new AbortController();
    try {
      const runPromise = defaultRunQmd([fixture, outFile], {
        cwd: __dirname,
        timeoutMs: 5_000, // long enough that only the abort — not the timeout — can resolve this
        signal: controller.signal,
      });

      await waitUntil(() => {
        try {
          readFileSync(outFile, "utf8");
          return true;
        } catch {
          return false;
        }
      }, 2_000);
      controller.abort();

      const result = await runPromise;
      expect(result.timedOut).toBe(true);

      const { workerPid } = JSON.parse(readFileSync(outFile, "utf8")) as { workerPid: number };
      await waitUntil(() => !isAlive(workerPid), 8_000);
      expect(isAlive(workerPid)).toBe(false);
    } finally {
      rmSync(outFile, { force: true });
    }
  }, 15_000);
});
