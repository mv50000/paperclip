import { describe, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, isCiRun } from "./helpers/embedded-pg.js";

describe("describeEmbeddedPostgres (RK9-566)", () => {
  const unsupported = async () => ({ supported: false, reason: "no initdb" });

  it("throws in CI when embedded Postgres cannot start, so the DB specs never skip there", async () => {
    await expect(describeEmbeddedPostgres("gate", { support: unsupported, env: { CI: "true" } })).rejects.toThrow(/required in CI for the gate tests: no initdb/);
    await expect(describeEmbeddedPostgres("gate", { support: unsupported, env: { CI: "1" } })).rejects.toThrow(/required in CI/);
  });

  it("skips with a warning on a local run, also with CI=0 or CI=false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const env of [{}, { CI: "0" }, { CI: "false" }, { CI: "" }]) {
        // describe.skip is a new chain on each read: the run is a skip when it is not `describe`.
        expect(await describeEmbeddedPostgres("gate", { support: unsupported, env })).not.toBe(describe);
      }
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("runs the suite when embedded Postgres starts", async () => {
    expect(await describeEmbeddedPostgres("gate", { support: async () => ({ supported: true }), env: { CI: "true" } })).toBe(describe);
  });

  it("isCiRun", () => {
    expect([undefined, "", "0", "false", "FALSE", " 0 "].map((CI) => isCiRun({ CI }))).toEqual([false, false, false, false, false, false]);
    expect(["true", "1", "yes"].map((CI) => isCiRun({ CI }))).toEqual([true, true, true]);
  });
});
