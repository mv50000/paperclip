import { expect, type Page } from "@playwright/test";

const ALLOWED_STATUS = [200, 301, 302, 303, 307, 308];

const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
  /favicon/i,
  /Content Security Policy/i,
  /Failed to load resource: the server responded with a status of 4\d\d/i,
  /third[-_ ]party cookies?/i,
  /sourcemap/i,
];

export interface CollectedConsole {
  errors: string[];
  pageErrors: string[];
}

export function attachConsoleCollector(page: Page): CollectedConsole {
  const collected: CollectedConsole = { errors: [], pageErrors: [] };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    collected.errors.push(text);
  });
  page.on("pageerror", (err) => {
    collected.pageErrors.push(err.message);
  });
  return collected;
}

export async function expectHomeServes(page: Page, baseURL: string): Promise<void> {
  const response = await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  expect(response, `Etusivun ${baseURL} pyyntö ei palauttanut vastausta`).not.toBeNull();
  const status = response!.status();
  expect(
    ALLOWED_STATUS,
    `Odotettu 2xx/3xx etusivulta, mutta sain ${status}. Tämä viittaa siihen että upstream on alhaalla tai reitti rikki.`,
  ).toContain(status);
}

export async function expectHtmlStructure(page: Page): Promise<void> {
  await expect(page.locator("html")).toBeAttached({ timeout: 10_000 });
  const title = await page.title();
  expect(title.length, "Sivulla ei ole <title>-tagia tai se on tyhjä").toBeGreaterThan(0);
  await expect(page.locator("body")).toBeAttached();
}

export function expectNoCriticalErrors(collected: CollectedConsole): void {
  expect(collected.pageErrors, `Sivulla heitettiin ajonaikaisia virheitä:\n${collected.pageErrors.join("\n")}`).toHaveLength(0);
  expect(collected.errors, `Sivulla console.error-rivejä:\n${collected.errors.join("\n")}`).toHaveLength(0);
}
