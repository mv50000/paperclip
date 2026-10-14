import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // Some tests load host source (shared validators, server services) on demand.
    testTimeout: 60_000,
  },
});
