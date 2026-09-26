import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeJournal,
  redactDbError,
  checkPinnedForkHashes,
  destructiveStatementsIn,
  forkTableReferencesIn,
  migrationSha256,
  scratchTargetViolations,
  tablesCreatedIn,
} from "./migration-dry-run-lib.js";

const SOCKET = "/var/run/postgresql";

describe("scratchTargetViolations", () => {
  it("allows the scratch database over a unix socket", () => {
    expect(scratchTargetViolations({ database: "paperclip_migdryrun", socketDir: SOCKET })).toEqual([]);
    expect(scratchTargetViolations({ database: "paperclip_migdryrun_fresh", socketDir: SOCKET })).toEqual([]);
  });

  it.each(["paperclip", "postgres", "template1", "paperclip_rehearsal", "paperclip_migdryrun-x", "PAPERCLIP"])(
    "refuses %s",
    (database) => {
      expect(scratchTargetViolations({ database, socketDir: SOCKET }).length).toBeGreaterThan(0);
    },
  );

  it("refuses TCP hosts and a missing PGHOST", () => {
    expect(scratchTargetViolations({ database: "paperclip_migdryrun", socketDir: "db.internal" })).not.toEqual([]);
    expect(scratchTargetViolations({ database: "paperclip_migdryrun", socketDir: undefined })).not.toEqual([]);
  });

  it("refuses libpq variables that redirect the tools away from the socket", () => {
    for (const name of ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGPORT"]) {
      expect(
        scratchTargetViolations({ database: "paperclip_migdryrun", socketDir: SOCKET, env: { [name]: "x" } }),
      ).not.toEqual([]);
    }
    expect(scratchTargetViolations({ database: "paperclip_migdryrun", socketDir: `${SOCKET},db.internal` })).not.toEqual([]);
  });

  it("refuses when DATABASE_URL names the scratch database", () => {
    expect(
      scratchTargetViolations({
        database: "paperclip_migdryrun",
        socketDir: SOCKET,
        envDatabaseUrl: "postgres://u@h/paperclip_migdryrun",
      }),
    ).not.toEqual([]);
  });
});

describe("checkPinnedForkHashes", () => {
  const file = { file: "9001_rk9_x.sql", content: "CREATE TABLE a();" };
  const baseline = { "9001_rk9_x.sql": migrationSha256(file.content) };

  it("passes when hashes match and ignores upstream files", () => {
    const result = checkPinnedForkHashes([file, { file: "0001_up.sql", content: "x" }], baseline);
    expect(result).toEqual({ missingBaseline: [], changed: [], staleBaseline: [] });
  });

  it("reports edited, unpinned and stale files", () => {
    expect(checkPinnedForkHashes([{ ...file, content: "CREATE TABLE a(); " }], baseline).changed).toHaveLength(1);
    expect(checkPinnedForkHashes([file, { file: "9002_rk9_y.sql", content: "" }], baseline).missingBaseline).toEqual([
      "9002_rk9_y.sql",
    ]);
    expect(checkPinnedForkHashes([], baseline).staleBaseline).toEqual(["9001_rk9_x.sql"]);
  });

  it("also pins a fork migration that sits in an upstream number slot", () => {
    const slot = { file: "0126_rk9_slot.sql", content: "SELECT 1;" };
    const pinned = { "0126_rk9_slot.sql": migrationSha256(slot.content) };
    expect(checkPinnedForkHashes([slot], pinned).changed).toEqual([]);
    expect(checkPinnedForkHashes([{ ...slot, content: "SELECT 2;" }], pinned).changed).toHaveLength(1);
  });

  it("matches the pinned baseline for the real fork migrations", () => {
    const dir = new URL("./migrations/", import.meta.url);
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({ file: name, content: fs.readFileSync(new URL(name, dir), "utf8") }));
    const pinned = JSON.parse(fs.readFileSync(new URL("./fork-migration-hashes.json", import.meta.url), "utf8"));
    expect(checkPinnedForkHashes(files, pinned)).toEqual({ missingBaseline: [], changed: [], staleBaseline: [] });
  });
});

describe("statement scanners", () => {
  it("finds destructive statements", () => {
    const sql = `-- c\nDROP TABLE IF EXISTS "cloud_upstream_runs";--> statement-breakpoint\nALTER TABLE "companies" DROP COLUMN IF EXISTS "brand_color";`;
    expect(destructiveStatementsIn(sql)).toEqual([
      { kind: "drop_table", table: "cloud_upstream_runs" },
      { kind: "drop_column", table: "companies", column: "brand_color" },
    ]);
  });

  it("finds statements that target or reference fork tables", () => {
    const forkTables = new Set(tablesCreatedIn('CREATE TABLE IF NOT EXISTS "risk_entries" (id uuid);'));
    const sql = `ALTER TABLE "risk_entries" ADD COLUMN "x" text;--> statement-breakpoint\nALTER TABLE "issues" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "public"."risk_entries"("id");--> statement-breakpoint\nALTER TABLE "issues" ADD COLUMN "y" text;`;
    const refs = forkTableReferencesIn(sql, forkTables);
    expect(refs.map((r) => r.via)).toEqual(["target", "foreign_key"]);
  });
});

describe("analyzeJournal", () => {
  it("flags upstream entries below the largest fork `when`", () => {
    const result = analyzeJournal([
      { idx: 0, tag: "0000_a", when: 10 },
      { idx: 1, tag: "0001_b", when: 20 },
      { idx: 2, tag: "9001_rk9_c", when: 100 },
      { idx: 3, tag: "0002_d", when: 30 },
    ]);
    expect(result.upstreamBelowForkMax).toBe(3);
    expect(result.nonMonotonic.map((e) => e.tag)).toEqual(["0002_d"]);
    expect(result.maxWhenTag).toBe("9001_rk9_c");
  });
});

describe("redactDbError", () => {
  it("keeps identifiers after identifier keywords", () => {
    const message = 'column "endpoint_id" referenced in foreign key constraint does not exist';
    expect(redactDbError(message)).toBe(message);
    expect(redactDbError('relation "email_messages" already exists')).toBe('relation "email_messages" already exists');
  });

  it.each([
    ['invalid input syntax for type uuid: "jane@example.com"', "jane@example.com"],
    ['invalid input syntax for type uuid: "Jane Doe\nKatu 1, Forssa"', "Katu 1"],
    ['invalid input syntax for type integer: "Mikko "the" Virtanen"', "Virtanen"],
    ['malformed array literal: "{"Jane Doe","jane@x.fi"}"', "jane@x.fi"],
    ['pg_restore: error: COPY failed for table "prospects": ERROR:  invalid input syntax for type uuid: "jane@x.fi"', "jane@x.fi"],
    ["bad value 'secret name'", "secret name"],
    ['duplicate key value violates unique constraint "x"\nDETAIL: Key (email)=(a@b.c) already exists.', "a@b.c"],
  ])("does not leak values from %s", (message, leaked) => {
    const redacted = redactDbError(message);
    expect(redacted).not.toContain(leaked);
    expect(redacted).not.toContain("\n");
  });

  it("tolerates non-string input", () => {
    expect(redactDbError(undefined)).toBe("");
    expect(redactDbError(new Error("boom"))).toBe("Error: boom");
  });
});
