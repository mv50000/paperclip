import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// react is a peer (the host provides it at runtime), so the plugin cannot
// resolve it directly. The jsdom UI tests take the copy react-dom resolves,
// which keeps one React instance for react-dom and the components.
const fromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: fromReactDom.resolve("react") },
      { find: /^react\/jsx-runtime$/, replacement: fromReactDom.resolve("react/jsx-runtime") },
      { find: /^react\/jsx-dev-runtime$/, replacement: fromReactDom.resolve("react/jsx-dev-runtime") },
    ],
  },
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // Some tests load host source (shared validators, server services) on demand.
    testTimeout: 60_000,
  },
});
