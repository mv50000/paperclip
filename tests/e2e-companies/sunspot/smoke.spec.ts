import { expect, test } from "@playwright/test";
import {
  attachConsoleCollector,
  expectHomeServes,
  expectHtmlStructure,
  expectNoCriticalErrors,
} from "../fixtures/smoke-helpers";

test.describe("Sunspot — smoke", () => {
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

  test("/api/health vastaa 2xx", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/api/health`);
    expect(
      response.status(),
      `/api/health palautti ${response.status()}, odotettiin 2xx`,
    ).toBeLessThan(400);
  });
});
