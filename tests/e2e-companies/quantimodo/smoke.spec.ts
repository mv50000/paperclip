import { expect, test } from "@playwright/test";

// Quantimodo-dev: Next.js-webui vastaa julkiseen URL:iin ja proxyttaa backendin
// (axum) reitit /api/* -polun alle. Backendin oma /health ei ole enää julkisesti
// tavoitettavissa — sen tilalla smoke todentaa, että proxy tavoittaa backendin
// (/api/v1/system/health vastaa 2xx tai 401, ei 5xx) ja että webui on ylhäällä
// (/ palauttaa 200 tai 307 → /login). Vanha API-only-oletus (root 404) poistettiin
// QUA-676/QUA-677:ssä 6.9.2026.

test.describe("Quantimodo — smoke", () => {
  test("Backend tavoitettavissa proxyn läpi (/api/v1/system/health 2xx tai 401)", async ({ request, baseURL }) => {
    // API-endpoint vaatii bearer-tunnuksen → 401 on hyväksyttävä: se todistaa että
    // pyyntö päätyi backendiin asti. 404 tarkoittaisi että proxy-reititys on rikki,
    // 5xx että backend-kontti on alhaalla.
    const response = await request.get(`${baseURL}/api/v1/system/health`);
    expect(
      [200, 401].includes(response.status()),
      `API system/health palautti ${response.status()}, odotettiin 200 tai 401 (auth required)`,
    ).toBe(true);
    const body = await response.json();
    expect(body, "Vastauksen pitäisi olla JSON (status- tai error-kenttä)").toEqual(
      expect.objectContaining(response.status() === 200 ? { status: expect.any(String) } : { error: expect.any(String) }),
    );
  });

  test("Webui vastaa root-pathiin (200 tai 307 → /login)", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/`, { maxRedirects: 0 });
    expect(
      [200, 307].includes(response.status()),
      `Root-pathin pitäisi palauttaa 200 tai 307 (login-redirect) — sai ${response.status()}`,
    ).toBe(true);
  });

  test("Reverse proxy ei palauta 502/503/504", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/api/v1/system/health`);
    expect(
      response.status(),
      `Upstream-virhe (5xx). Container alhaalla tai port-binding väärin. Sai ${response.status()}.`,
    ).toBeLessThan(500);
  });
});
