import { describe, expect, it } from "vitest";
import { buildDraftUserMessage, estimateCostUsd, parseDraftResponse } from "../services/outreach/draft.js";

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
