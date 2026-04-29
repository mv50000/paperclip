import { defineConfig } from "@playwright/test";
import { COMPANIES, companyByName } from "./fixtures/companies";

const REPORT_DIR = process.env.E2E_COMPANIES_REPORT_DIR ?? "./playwright-report";
const RESULTS_DIR = process.env.E2E_COMPANIES_RESULTS_DIR ?? "./test-results";

export default defineConfig({
  testDir: ".",
  testMatch: "**/smoke.spec.ts",
  timeout: 60_000,
  retries: 1,
  workers: 2,
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: false,
  },
  projects: COMPANIES.map((co) => ({
    name: co.name,
    testDir: `./${co.name}`,
    use: {
      baseURL: co.baseUrl,
      browserName: "chromium",
    },
    metadata: {
      company: co.name,
      ownerAgent: co.ownerAgent,
    },
  })),
  outputDir: RESULTS_DIR,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: REPORT_DIR }],
    ["junit", { outputFile: `${RESULTS_DIR}/junit.xml` }],
    ["json", { outputFile: `${RESULTS_DIR}/results.json` }],
  ],
});

export { COMPANIES, companyByName };
