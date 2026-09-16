import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/**
 * RK9-228, second round. The first fix filtered `process.env` inside the
 * claude-local adapter, which changed what the adapter *reported* but not what
 * the child process actually received: `runChildProcess` builds the child
 * environment itself and re-merges `process.env`. The preflight check happily
 * said "not inherited" while agents kept billing metered API credit.
 *
 * So this test spawns a real process and reads the environment it actually got.
 * A mock of `runChildProcess` would have passed against the broken version.
 */
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

async function spawnAndReadKey(opts: {
  env: Record<string, string>;
  doNotInheritEnvKeys?: readonly string[];
}): Promise<string> {
  const result = await runChildProcess(
    `env-inherit-${Date.now()}`,
    process.execPath,
    ["-e", "process.stdout.write(process.env.ANTHROPIC_API_KEY ?? '<unset>')"],
    {
      cwd: process.cwd(),
      env: opts.env,
      timeoutSec: 30,
      graceSec: 5,
      onLog: async () => {},
      ...(opts.doNotInheritEnvKeys ? { doNotInheritEnvKeys: opts.doNotInheritEnvKeys } : {}),
    },
  );
  return result.stdout.trim();
}

describe("runChildProcess host env inheritance", () => {
  it("passes a host key through when nothing asks it not to", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";

    expect(await spawnAndReadKey({ env: {} })).toBe("sk-host");
  }, 40_000);

  it("withholds a host key listed in doNotInheritEnvKeys", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";

    expect(
      await spawnAndReadKey({ env: {}, doNotInheritEnvKeys: ["ANTHROPIC_API_KEY"] }),
    ).toBe("<unset>");
  }, 40_000);

  it("still lets an explicit env value through", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";

    expect(
      await spawnAndReadKey({
        env: { ANTHROPIC_API_KEY: "sk-explicit" },
        doNotInheritEnvKeys: ["ANTHROPIC_API_KEY"],
      }),
    ).toBe("sk-explicit");
  }, 40_000);

  it("treats a blank explicit value as no value", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-host";

    expect(
      await spawnAndReadKey({
        env: { ANTHROPIC_API_KEY: "   " },
        doNotInheritEnvKeys: ["ANTHROPIC_API_KEY"],
      }),
    ).toBe("<unset>");
  }, 40_000);
});
