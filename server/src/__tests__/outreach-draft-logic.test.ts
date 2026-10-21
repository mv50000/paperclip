import { describe, expect, it } from "vitest";
import {
  buildDraftUserMessage,
  demoUrlForSegment,
  estimateCostUsd,
  isEndOfLifePhp,
  parseDraftResponse,
  parseProviders,
  RK9_NO_LINK_LINE,
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
    expect(msg).toContain(RK9_NO_LINK_LINE);
    expect(msg).not.toMatch(/Ainoa sallittu linkki|rk9\.fi\/selitys/);
    expect(msg).not.toMatch(/ajanvaraus|VAIHTOVIESTI|ALOITUSVIESTI|Timma|saatavilla/i);
    expect(msg).toContain("SUBJECT:");
  });

  it("rk9: asks for type A when no website was found", () => {
    const msg = buildDraftUserMessage({ company: "rk9", orgName: "Acme Oy", observation: null, websiteUrl: null });
    expect(msg).toContain("Verkkosivua ei löytynyt. → Kirjoita viestityyppi A (EI SIVUA).");
    expect(msg).not.toContain("viestityyppi B");
    expect(msg).toMatch(/älä keksi/i);
    expect(msg).toContain(RK9_NO_LINK_LINE);
    expect(msg).not.toMatch(/Ainoa sallittu linkki|rk9\.fi\/selitys/);
    expect(msg).not.toMatch(/ajanvaraus|saatavilla/i);
    // websiteUrl omitted behaves as "not found"
    expect(buildDraftUserMessage({ company: "rk9", orgName: "Acme Oy", observation: null })).toContain(
      "viestityyppi A (EI SIVUA)",
    );
  });

  it("rk9: asks for type C when the site reports an end-of-life PHP branch", () => {
    const msg = buildDraftUserMessage({
      company: "rk9",
      orgName: "Acme Oy",
      observation: null,
      websiteUrl: "https://www.acme.fi/",
      phpVersion: "7.4.33",
    });
    expect(msg).toContain(
      "Verkkosivu löytyi: https://www.acme.fi/. Sivuston palvelin kertoo käyttävänsä PHP-versiota 7.4.33, jonka tietoturvatuki on päättynyt. → Kirjoita viestityyppi C (VANHA PHP).",
    );
    expect(msg).not.toContain("viestityyppi B");
    expect(msg).toContain(RK9_NO_LINK_LINE);
  });

  it("rk9: a supported or unknown PHP version stays type B, and no website stays type A", () => {
    for (const phpVersion of ["8.2.35", "8.5.12", null, undefined, "unknown"]) {
      const msg = buildDraftUserMessage({ company: "rk9", orgName: "A", observation: null, websiteUrl: "https://a.fi", phpVersion });
      expect(msg).toContain("viestityyppi B (SIVU ON)");
      expect(msg).not.toContain("PHP");
    }
    expect(
      buildDraftUserMessage({ company: "rk9", orgName: "A", observation: null, websiteUrl: null, phpVersion: "5.6.40" }),
    ).toContain("viestityyppi A (EI SIVUA)");
  });

  it("isEndOfLifePhp: branches below 8.2 are end-of-life", () => {
    for (const v of ["5.2.13", "5.6.40", "7.3.33", "7.4.33", "8.0.30", "8.1.34", "PHP/8.1.34"]) expect(isEndOfLifePhp(v)).toBe(true);
    for (const v of ["8.2.35", "8.3.36", "8.4.27", "8.5.12", "9.0.0"]) expect(isEndOfLifePhp(v)).toBe(false);
    for (const v of [null, undefined, "", "PHP"]) expect(isEndOfLifePhp(v)).toBe(false);
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

  it("estimates cost from Opus 5.5 per-token pricing", () => {
    // $4/1M input, $20/1M output (cached 2026-09-26).
    expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4, 6);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
    expect(estimateCostUsd({ input_tokens: 500_000, output_tokens: 100_000 })).toBeCloseTo(2 + 2, 6);
  });
});
