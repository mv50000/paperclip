import { expect, test } from "@playwright/test";
import {
  attachConsoleCollector,
  expectHomeServes,
  expectHtmlStructure,
  expectNoCriticalErrors,
} from "../fixtures/smoke-helpers";

test.describe("Last Shadow (TLN) — smoke", () => {
  test("etusivu vastaa", async ({ page, baseURL }) => {
    await expectHomeServes(page, baseURL!);
  });

  test("HTML-rakenne renderöityy", async ({ page, baseURL }) => {
    await page.goto(baseURL!, { waitUntil: "domcontentloaded" });
    await expectHtmlStructure(page);
  });

  test("ei kriittisiä console-erroreita", async ({ page, baseURL }) => {
    // The wasm module loads on page load, but `run()` (the actual Bevy app
    // boot) is gated behind the player's first tap — see platforms/web/
    // src/lib.rs in rk9-ai/last-shadow — so this load never touches WebGL2/
    // WebGPU and can't be flaky about headless-runner GPU support.
    const collected = attachConsoleCollector(page);
    await page.goto(baseURL!, { waitUntil: "networkidle", timeout: 30_000 });
    expectNoCriticalErrors(collected);
  });

  // TLN-14 AC: "version.json served and updated per deploy" — this is the
  // one check every other company's smoke test doesn't need, since
  // last-shadow is the first static wasm-bindgen deploy in the suite rather
  // than a server-rendered app with its own /api/health.
  test("version.json vastaa ja sisältää sha:n", async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/version.json`);
    expect(
      response.status(),
      `/version.json palautti ${response.status()}, odotettiin 200`,
    ).toBe(200);

    const body = await response.json();
    expect(typeof body.sha, "version.json:ssa pitäisi olla merkkijono-kentä 'sha'").toBe(
      "string",
    );
    expect(body.sha.length, "version.json:n 'sha' on tyhjä").toBeGreaterThan(0);
  });
});
