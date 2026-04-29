import { expect, test } from "@playwright/test";
import {
  attachConsoleCollector,
  expectHomeServes,
  expectHtmlStructure,
  expectNoCriticalErrors,
} from "../fixtures/smoke-helpers";

test.describe("Ololla — smoke", () => {
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

  test("etusivun pääsisältö renderöityy", async ({ page, baseURL }) => {
    await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
    const main = page.locator("main, #__next > div, [role='main']").first();
    await main.waitFor({ state: "attached", timeout: 15_000 });
    const text = (await page.textContent("body")) ?? "";
    expect(text.length, "Sivun body näyttää tyhjältä").toBeGreaterThan(50);
  });
});
