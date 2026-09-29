// RK9-368: a failed scrape / duplicate e-mail is recorded so the next
// `unenriched` run advances past the row instead of re-selecting it forever.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, outreachProspects } from "@paperclipai/db";
import { eq } from "drizzle-orm";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (cmd: string, args: unknown, opts: unknown, cb: (e: Error | null, out?: unknown) => void) => {
      if (cmd !== "firecrawl") return (actual.execFile as any)(cmd, args, opts, cb);
      cb(new Error("boom"));
      return undefined;
    },
  };
});

const { enrichProspectFromWebsite } = await import("../services/outreach/enrich.ts");
const { listProspects } = await import("../services/outreach/prospects.ts");
const { startEmbeddedPostgresTestDatabase } = await import("./helpers/embedded-postgres.ts");

describe("failed enrichment attempts are recorded", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const failedId = randomUUID();

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-outreach-enrichfail-");
    db = createDb(started.connectionString);
    tempDb = started;
    await db.insert(companies).values({ id: companyId, name: "RK9", issuePrefix: "RK9" });
    await db.insert(outreachProspects).values({
      id: failedId, companyId, orgName: "Broken", source: "test", sourceUrl: "https://broken.example",
    });
  }, 120_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("scrape_failed writes enrichment.website.{attemptedAt,error} and drops out of the unenriched list", async () => {
    expect(await listProspects(db, companyId, { unenriched: true })).toHaveLength(1);
    const result = await enrichProspectFromWebsite(db, companyId, failedId);
    expect(result).toEqual({ ok: false, reason: "scrape_failed" });

    const [row] = await db.select().from(outreachProspects).where(eq(outreachProspects.id, failedId));
    const website = (row.enrichment as any).website;
    expect(website.error).toBe("scrape_failed");
    expect(typeof website.attemptedAt).toBe("string");
    expect(website.snippet).toBeUndefined();

    expect(await listProspects(db, companyId, { unenriched: true })).toHaveLength(0);
    expect(await listProspects(db, companyId, { unenriched: true, retryFailed: true })).toHaveLength(1);
  });
});
