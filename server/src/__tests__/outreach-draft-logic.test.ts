import { describe, expect, it } from "vitest";
import {
  buildDraftUserMessage,
  demoUrlForSegment,
  estimateCostUsd,
  parseDraftResponse,
  parseProviders,
  RK9_EXPLAINER_URL,
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

  // RK9-349: the rk9 template sells a website — no booking-system lines, A/B by website
  it("rk9: asks for type B and names the website when one was found", () => {
    const msg = buildDraftUserMessage({
      company: "rk9",
      orgName: "Acme Oy",
      observation: "Sivulla on vain puhelinnumero.",
      providers: ["timma"],
      demoUrl: "https://jooga-demo.saatavilla.fi",
      websiteUrl: "https://www.acme.fi/",
    });
    expect(msg).toContain("Yrityksen nimi: Acme Oy");
    expect(msg).toContain("Verkkosivu löytyi: https://www.acme.fi/. → Kirjoita viestityyppi B (SIVU ON).");
    expect(msg).toContain("Sivulla on vain puhelinnumero.");
    expect(msg).toContain("Ainoa sallittu linkki viestissä: https://rk9.fi/selitys");
    expect(msg).not.toMatch(/ajanvaraus|VAIHTOVIESTI|ALOITUSVIESTI|Timma|saatavilla/i);
    expect(msg).toContain("SUBJECT:");
  });

  it("rk9: asks for type A when no website was found", () => {
    const msg = buildDraftUserMessage({ company: "rk9", orgName: "Acme Oy", observation: null, websiteUrl: null });
    expect(msg).toContain("Verkkosivua ei löytynyt. → Kirjoita viestityyppi A (EI SIVUA).");
    expect(msg).not.toContain("viestityyppi B");
    expect(msg).toMatch(/älä keksi/i);
    expect(msg).toContain(`Ainoa sallittu linkki viestissä: ${RK9_EXPLAINER_URL}`);
    expect(msg).not.toMatch(/ajanvaraus|saatavilla/i);
    // websiteUrl omitted behaves as "not found"
    expect(buildDraftUserMessage({ company: "rk9", orgName: "Acme Oy", observation: null })).toContain(
      "viestityyppi A (EI SIVUA)",
    );
  });

  it("saatavilla user message is unchanged by the rk9 branch", () => {
    const facts = { orgName: "Acme Oy", observation: "x", providers: ["timma"], demoUrl: "https://pt-demo.saatavilla.fi" };
    const expected = [
      "Yrityksen nimi: Acme Oy",
      "Nykyinen ajanvarausjärjestelmä (tunnistettu sivulta): Timma. → Kirjoita VAIHTOVIESTI (template, kohta B).",
      'Ote heidän verkkosivultaan (käytä siitä VAIN tarkistettavaa faktaa, älä kerro sivua uudelleen): "x"',
      "Ainoa sallittu linkki viestissä: https://pt-demo.saatavilla.fi",
      "",
      "Vastaa TÄSMÄLLEEN tässä muodossa, ei muuta tekstiä ennen tai jälkeen:",
      "SUBJECT: <otsikko>",
      "BODY:",
      "<viestin runko>",
    ].join("\n");
    expect(buildDraftUserMessage(facts)).toBe(expected);
    expect(buildDraftUserMessage({ ...facts, company: "saatavilla" })).toBe(expected);
    expect(buildDraftUserMessage({ ...facts, company: "saatavilla", websiteUrl: "https://acme.fi" })).toBe(expected);
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
