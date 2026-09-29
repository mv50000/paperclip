// RK9-368: `listProspects({ unenriched })` runs against a real Postgres. The
// route test mocks the service, so the jsonb filter itself had no coverage.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, outreachProspects } from "@paperclipai/db";
import { listProspects } from "../services/outreach/prospects.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

describe("listProspects unenriched filter against a real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const ids = { enriched: randomUUID(), failed: randomUUID(), fresh: randomUUID(), noUrl: randomUUID() };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-outreach-unenriched-");
    db = createDb(started.connectionString);
    tempDb = started;
    await db.insert(companies).values({ id: companyId, name: "RK9", issuePrefix: "RK9" });
    const base = { companyId, source: "test" };
    await db.insert(outreachProspects).values([
      {
        ...base, id: ids.enriched, orgName: "Enriched", sourceUrl: "https://a.example",
        enrichment: { website: { snippet: "x", url: "https://a.example", scrapedAt: "2026-09-01T00:00:00Z" } },
      },
      {
        ...base, id: ids.failed, orgName: "Failed", sourceUrl: "https://b.example",
        enrichment: { website: { attemptedAt: "2026-09-01T00:00:00Z", error: "scrape_failed" } },
      },
      { ...base, id: ids.fresh, orgName: "Fresh", sourceUrl: "https://c.example" },
      { ...base, id: ids.noUrl, orgName: "NoUrl" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  const idsOf = async (opts: Parameters<typeof listProspects>[2]) =>
    (await listProspects(db, companyId, opts)).map((r) => r.id).sort();

  it("returns only never-attempted rows that have a sourceUrl", async () => {
    expect(await idsOf({ unenriched: true })).toEqual([ids.fresh]);
  });

  it("retryFailed also returns rows whose earlier attempt failed, never enriched or url-less ones", async () => {
    expect(await idsOf({ unenriched: true, retryFailed: true })).toEqual([ids.failed, ids.fresh].sort());
  });

  it("retryFailed lists never-attempted rows before failed ones", async () => {
    const rows = await listProspects(db, companyId, { unenriched: true, retryFailed: true });
    expect(rows.map((r) => r.id)).toEqual([ids.fresh, ids.failed]);
  });

  it("without unenriched returns everything", async () => {
    expect(await idsOf({})).toHaveLength(4);
  });
});
