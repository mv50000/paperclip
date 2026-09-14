import { describe, expect, it } from "vitest";
import {
  buildDraftUserMessage,
  demoUrlForSegment,
  estimateCostUsd,
  parseDraftResponse,
  parseProviders,
} from "../services/outreach/draft.js";

describe("outreach AI drafting — pure logic (RK9-196)", () => {
  it("includes the observation when one is known", () => {
    const msg = buildDraftUserMessage({ orgName: "Acme Oy", observation: "Sivulla mainostetaan iltavastaanottoa." });
    expect(msg).toContain("Acme Oy");
    expect(msg).toContain("Sivulla mainostetaan iltavastaanottoa.");
    expect(msg).toContain("SUBJECT:");
  });

  it("tells the model not to invent an observation when none is known", () => {
    const msg = buildDraftUserMessage({ orgName: "Acme Oy", observation: null });
    expect(msg).toMatch(/älä keksi/i);
  });

  // RK9-223: the template branch is decided by the PRH scan's providers field
  it("asks for the SWITCH message and names the detected booking system", () => {
    const msg = buildDraftUserMessage({ orgName: "Acme Oy", observation: null, providers: ["timma"] });
    expect(msg).toContain("Nykyinen ajanvarausjärjestelmä (tunnistettu sivulta): Timma");
    expect(msg).toContain("VAIHTOVIESTI");
    expect(msg).not.toContain("ALOITUSVIESTI");
  });

  it("asks for the START message when no booking system was detected", () => {
    const msg = buildDraftUserMessage({ orgName: "Acme Oy", observation: null, providers: [] });
    expect(msg).toContain("ALOITUSVIESTI");
    expect(msg).not.toContain("VAIHTOVIESTI");
    // legacy callers without the field behave the same
    expect(buildDraftUserMessage({ orgName: "Acme Oy", observation: null })).toContain("ALOITUSVIESTI");
  });

  it("joins multiple providers with readable labels", () => {
    const msg = buildDraftUserMessage({ orgName: "Acme Oy", observation: null, providers: ["nettiaika", "ajas"] });
    expect(msg).toContain("Nettiaika / Ajas");
  });

  it("names exactly one allowed link — the segment demo or the marketing site", () => {
    expect(buildDraftUserMessage({ orgName: "A", observation: null, demoUrl: "https://jooga-demo.saatavilla.fi" })).toContain(
      "Ainoa sallittu linkki viestissä: https://jooga-demo.saatavilla.fi",
    );
    expect(buildDraftUserMessage({ orgName: "A", observation: null })).toContain("Ainoa sallittu linkki viestissä: https://saatavilla.fi");
  });

  it("parses the pipe-joined providers string the PRH scan stores", () => {
    expect(parseProviders("nettiaika|ajas")).toEqual(["nettiaika", "ajas"]);
    expect(parseProviders(" Timma ")).toEqual(["timma"]);
    expect(parseProviders("")).toEqual([]);
    expect(parseProviders(undefined)).toEqual([]);
    expect(parseProviders(["Slotti"])).toEqual(["slotti"]);
  });

  it("maps segments to live demo tenants and falls back to the marketing site", () => {
    expect(demoUrlForSegment("hieroja")).toBe("https://hieroja-demo.saatavilla.fi");
    expect(demoUrlForSegment("kosmetologi")).toBe("https://hieroja-demo.saatavilla.fi");
    expect(demoUrlForSegment("jooga")).toBe("https://jooga-demo.saatavilla.fi");
    expect(demoUrlForSegment("pt")).toBe("https://pt-demo.saatavilla.fi");
    expect(demoUrlForSegment("kampaamo")).toBe("https://saatavilla.fi");
    expect(demoUrlForSegment(null)).toBe("https://saatavilla.fi");
  });

  it("parses the SUBJECT/BODY format", () => {
    const raw = "SUBJECT: Nopea kysymys\nBODY:\nHei Acme,\n\nHuomasimme sivunne.\n\nTerveisin";
    expect(parseDraftResponse(raw)).toEqual({
      subject: "Nopea kysymys",
      bodyText: "Hei Acme,\n\nHuomasimme sivunne.\n\nTerveisin",
    });
  });

  it("returns null for a response that doesn't follow the format", () => {
    expect(parseDraftResponse("Hei, tässä on viestisi ilman muotoa.")).toBeNull();
    expect(parseDraftResponse("SUBJECT: \nBODY:\n")).toBeNull();
  });

  it("estimates cost from Sonnet 5 per-token pricing", () => {
    // $2/1M input, $10/1M output (cached 2026-09-13).
    expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(2, 6);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(10, 6);
    expect(estimateCostUsd({ input_tokens: 500_000, output_tokens: 100_000 })).toBeCloseTo(1 + 1, 6);
  });
});
