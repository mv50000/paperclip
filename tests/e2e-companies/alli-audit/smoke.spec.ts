import { expect, test } from "@playwright/test";
import {
  attachConsoleCollector,
  expectHomeServes,
  expectHtmlStructure,
  expectNoCriticalErrors,
} from "../fixtures/smoke-helpers";

test.describe("Alli-Audit — smoke", () => {
  test("etusivu vastaa (sallii redirectin /login:iin)", async ({ page, baseURL }) => {
    await expectHomeServes(page, baseURL!);
  });

  test("HTML-rakenne renderöityy (login-sivulla)", async ({ page, baseURL }) => {
    await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
    await expectHtmlStructure(page);
  });

  test("ei kriittisiä console-erroreita", async ({ page, baseURL }) => {
    const collected = attachConsoleCollector(page);
    await page.goto(baseURL!, { waitUntil: "networkidle", timeout: 30_000 });
    expectNoCriticalErrors(collected);
  });

  test("login-sivu lataa ja sisältää lomakkeen", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/login`, { waitUntil: "domcontentloaded" });
    const url = page.url();
    expect(url, "Pitäisi olla login-sivulla").toMatch(/\/login/);
    const formInputs = page.locator('input[type="email"], input[type="text"], input[name*="email" i], input[name*="user" i]');
    await formInputs.first().waitFor({ state: "visible", timeout: 15_000 });
  });
});
