// RK9 Custom (RK9-639): writeCoordEnvFile in server/scripts/rk9-coord-token.mjs
// removes its temp file (mode 0600, token inside) on every failure, also when
// the close of the file handle fails on the success path.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({ close: false, rename: false, writeFile: false, sync: false, chmod: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (failures.writeFile) {
        handle.writeFile = async () => {
          throw new Error("ENOSPC: writeFile failed");
        };
      }
      if (failures.sync) {
        handle.sync = async () => {
          throw new Error("EIO: sync failed");
        };
      }
      if (!failures.close) return handle;
      let failed = false;
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        await realClose();
        if (!failed) {
          failed = true;
          throw new Error("EIO: close failed");
        }
      };
      return handle;
    },
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      if (failures.chmod) throw new Error("EPERM: chmod failed");
      return actual.chmod(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failures.rename) throw new Error("EXDEV: rename failed");
      return actual.rename(...args);
    },
  };
});

const { writeCoordEnvFile } = await import("../../scripts/rk9-coord-token.mjs");

const TOKEN = `rk9_coord_${"B".repeat(40)}xyz`;
const input = {
  coordUrl: "http://paperclip:3100",
  companyId: "11111111-1111-4111-8111-111111111111",
  token: TOKEN,
  record: { id: "33333333-3333-4333-8333-333333333333", principalKind: "host", principalName: "mv-laptop" },
};

describe("writeCoordEnvFile cleanup", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rk9-coord-envfile-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["close", "rename", "writeFile", "sync", "chmod"] as const)("leaves no temp file when %s fails", async (step) => {
    const sub = path.join(dir, step);
    await (await import("node:fs/promises")).mkdir(sub);
    failures[step] = true;
    try {
      await expect(writeCoordEnvFile(path.join(sub, "coord.env"), input)).rejects.toThrow(/failed/);
    } finally {
      failures[step] = false;
    }
    expect(await readdir(sub)).toEqual([]);
  });

  it("writes the file when nothing fails", async () => {
    const sub = path.join(dir, "ok");
    await (await import("node:fs/promises")).mkdir(sub);
    await writeCoordEnvFile(path.join(sub, "coord.env"), input);
    expect(await readdir(sub)).toEqual(["coord.env"]);
  });
});
