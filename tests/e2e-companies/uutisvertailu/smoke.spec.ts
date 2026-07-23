import { expect, test } from "@playwright/test";
import {
  attachConsoleCollector,
  expectHomeServes,
  expectHtmlStructure,
  expectNoCriticalErrors,
} from "../fixtures/smoke-helpers";

test.describe("Uutisvertailu — smoke", () => {
  test("etusivu vastaa", async ({ page, baseURL }) => {
    await expectHomeServes(page, baseURL!);
  });

  test("HTML-rakenne renderöityy", async ({ page, baseURL }) => {
    await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
    await expectHtmlStructure(page);
  });

  test("ei kriittisiä console-erroreita", async ({ page, baseURL }) => {
    const collected = attachConsoleCollector(page);
    await page.goto(baseURL!, { waitUntil: "networkidle", timeout: 30_000 });
    expectNoCriticalErrors(collected);
  });

  test("/healthz vastaa 200 (liveness)", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/healthz`);
    expect(
      response.status(),
      `/healthz palautti ${response.status()}, odotettiin 200`,
    ).toBe(200);
    const body = await response.json();
    expect(["ok", "pending", "error"]).toContain(body.status);
  });

  test("stories.json tarjoillaan", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/data/stories.json`);
    expect(
      response.status(),
      `/data/stories.json palautti ${response.status()}, odotettiin 2xx`,
    ).toBeLessThan(400);
  });
});
