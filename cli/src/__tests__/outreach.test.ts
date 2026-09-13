import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  formatMessageForReview,
  mapPrhRecordToProspect,
  parsePrhImportFile,
  parseReviewChoice,
  registerOutreachCommands,
} from "../commands/client/outreach.js";

describe("registerOutreachCommands", () => {
  it("registers the outreach command tree", () => {
    const program = new Command();
    expect(() => registerOutreachCommands(program)).not.toThrow();
    const outreach = program.commands.find((c) => c.name() === "outreach");
    expect(outreach).toBeDefined();
    expect(outreach?.commands.map((c) => c.name())).toEqual(["import", "enrich", "draft", "review"]);
  });
});

describe("mapPrhRecordToProspect", () => {
  it("maps prh-lookup.ts's NormalizedCompany shape", () => {
    const record = { names: { primary: "Acme Oy" }, businessId: "1234567-8" };
    const mapped = mapPrhRecordToProspect(record);
    expect(mapped).toMatchObject({ orgName: "Acme Oy", businessId: "1234567-8", source: "prh", email: null });
  });

  it("maps enrich-fetch.ts's {prh, website} shape, preferring website.finalUrl", () => {
    const record = {
      prh: { name: "Acme Oy", businessId: "1234567-8" },
      website: { url: "https://acme.fi", finalUrl: "https://www.acme.fi/" },
    };
    const mapped = mapPrhRecordToProspect(record);
    expect(mapped.orgName).toBe("Acme Oy");
    expect(mapped.sourceUrl).toBe("https://www.acme.fi/");
  });

  it("carries known AI-enrichment fields into `enrichment` when no explicit enrichment object is given", () => {
    const record = { orgName: "Acme Oy", eaaRelevance: "high", techStack: ["WordPress"] };
    const mapped = mapPrhRecordToProspect(record);
    expect(mapped.enrichment).toEqual({ eaaRelevance: "high", techStack: ["WordPress"] });
  });

  it("throws when no org name can be found", () => {
    expect(() => mapPrhRecordToProspect({ businessId: "1234567-8" })).toThrow(/org name/);
  });
});

describe("parsePrhImportFile", () => {
  it("accepts a bare array", () => {
    expect(parsePrhImportFile(JSON.stringify([{ orgName: "A" }]))).toEqual([{ orgName: "A" }]);
  });

  it("accepts prh-lookup.ts's {companies:[...]} envelope", () => {
    expect(parsePrhImportFile(JSON.stringify({ companies: [{ orgName: "A" }], totalResults: 1 }))).toEqual([
      { orgName: "A" },
    ]);
  });

  it("rejects anything else", () => {
    expect(() => parsePrhImportFile(JSON.stringify({ foo: "bar" }))).toThrow();
  });
});

describe("parseReviewChoice", () => {
  it("parses approve/edit/skip/quit", () => {
    expect(parseReviewChoice("a")).toEqual({ action: "approve" });
    expect(parseReviewChoice("A")).toEqual({ action: "approve" });
    expect(parseReviewChoice("e")).toEqual({ action: "edit" });
    expect(parseReviewChoice("s")).toEqual({ action: "skip" });
    expect(parseReviewChoice("q")).toEqual({ action: "quit" });
  });

  it("parses a reject reason after 'r'", () => {
    expect(parseReviewChoice("r too salesy")).toEqual({ action: "reject", reason: "too salesy" });
    expect(parseReviewChoice("r")).toEqual({ action: "reject", reason: "ei syytä annettu" });
  });

  it("returns null for unrecognized input so the caller can ask again", () => {
    expect(parseReviewChoice("x")).toBeNull();
    expect(parseReviewChoice("")).toBeNull();
  });
});

describe("formatMessageForReview", () => {
  it("includes the org name, address, subject and body", () => {
    const text = formatMessageForReview(
      { id: "m1", prospectId: "p1", subject: "Nopea kysymys", bodyText: "Hei Acme,\n\nkiitos.", status: "draft" },
      { id: "p1", orgName: "Acme Oy", email: "info@acme.fi", status: "new", sourceUrl: null },
    );
    expect(text).toContain("Acme Oy");
    expect(text).toContain("info@acme.fi");
    expect(text).toContain("Nopea kysymys");
    expect(text).toContain("kiitos.");
  });
});
