import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // RK9 Custom (RK9-462): create the test reaper marker before any worker
    // starts and sweep marked orphans after the run, so a worker killed by a
    // signal leaves no wrapper, bridge server or runtime service behind.
    globalSetup: ["./src/test-support/reaper-global-setup.ts"],
  },
});
