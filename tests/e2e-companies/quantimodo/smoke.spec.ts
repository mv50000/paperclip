import { expect, test } from "@playwright/test";

// Quantimodo on trading-API, ei web-frontend. Reitit: /health (JSON), /api/v1/*.
// Root-path / palauttaa 404 by design — smoke testaa /health- ja API-endpointeja.

test.describe("Quantimodo — smoke", () => {
  test("/health vastaa 2xx + healthy JSON", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/health`);
    expect(
      response.status(),
      `/health palautti ${response.status()}, odotettiin 2xx`,
    ).toBeLessThan(400);
    const body = await response.json();
    expect(body, "Health-vastauksen pitäisi olla JSON, jossa status-kenttä").toHaveProperty("status");
    expect(body.status, `status-kentän odotettiin olevan healthy/ok, oli "${body.status}"`).toMatch(/^(healthy|ok)$/i);
  });

  test("/api/v1/system/health vastaa (auth ok)", async ({ request, baseURL }) => {
    // API-endpoint vaatii bearer-tunnuksen → 401 on hyväksyttävä (todistaa että reitti on olemassa).
    // 5xx tai connection-error olisi merkki upstream-ongelmasta.
    const response = await request.get(`${baseURL}/api/v1/system/health`);
    expect(
      response.status(),
      `API system/health palautti ${response.status()}, odotettiin 2xx tai 401 (auth required)`,
    ).toBeLessThan(500);
  });

  test("Root-path / palauttaa 404 (API-only, ei frontendia)", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/`);
    expect(
      response.status(),
      `Root-pathin pitäisi palauttaa 404 (axum default unrouted) — sai ${response.status()}`,
    ).toBe(404);
  });

  test("Reverse proxy ei palauta 502/503/504", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/health`);
    expect(
      response.status(),
      `nginx upstream-virhe (5xx). Container alhaalla tai port-binding väärin. Sai ${response.status()}.`,
    ).toBeLessThan(500);
  });
});
