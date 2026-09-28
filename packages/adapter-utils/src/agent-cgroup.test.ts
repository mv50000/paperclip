// --- RK9 Custom (RK9-357): agent cgroup leaf. See doc/upgrade/agent-cgroup.md ---
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CGROUP_ENV,
  moveProcessToAgentCgroup,
  resetAgentCgroupWarningForTests,
  resolveAgentCgroupProcsPath,
} from "./agent-cgroup.js";
import { runChildProcess } from "./server-utils.js";

describe("agent cgroup leaf", () => {
  let root: string;
  let leaf: string;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
  };

  beforeEach(async () => {
    resetAgentCgroupWarningForTests();
    warnings.length = 0;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-cgroup-"));
    leaf = path.join(root, "system.slice", "paperclip.service", "agents");
    await fs.mkdir(leaf, { recursive: true });
    await fs.writeFile(path.join(leaf, "cgroup.procs"), "");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const linuxOptions = (value: string | undefined) => ({
    env: value === undefined ? {} : { [AGENT_CGROUP_ENV]: value },
    platform: "linux" as NodeJS.Platform,
    cgroupRoot: root,
    warn,
  });

  it("does nothing and stays silent when the variable is unset", async () => {
    expect(resolveAgentCgroupProcsPath(linuxOptions(undefined))).toBeNull();
    expect(resolveAgentCgroupProcsPath(linuxOptions("   "))).toBeNull();
    await expect(moveProcessToAgentCgroup(1234, linuxOptions(undefined))).resolves.toBe(false);
    expect(warnings).toEqual([]);
  });

  it("writes the pid into cgroup.procs of the configured leaf", async () => {
    await expect(moveProcessToAgentCgroup(4321, linuxOptions(leaf))).resolves.toBe(true);
    await expect(moveProcessToAgentCgroup(4322, linuxOptions(`${leaf}/`))).resolves.toBe(true);
    const written = await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8");
    expect(written).toBe("4321\n4322\n");
    expect(warnings).toEqual([]);
  });

  it("rejects invalid pids without touching the leaf", async () => {
    for (const pid of [undefined, null, 0, -5, 1.5, Number.NaN]) {
      await expect(moveProcessToAgentCgroup(pid, linuxOptions(leaf))).resolves.toBe(false);
    }
    expect(await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).toBe("");
  });

  it("fails open on a non-Linux platform with one warning", async () => {
    const options = { ...linuxOptions(leaf), platform: "darwin" as NodeJS.Platform };
    await expect(moveProcessToAgentCgroup(1, options)).resolves.toBe(false);
    await expect(moveProcessToAgentCgroup(2, options)).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("darwin");
    expect(await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).toBe("");
  });

  it("refuses a relative path or a path outside the cgroup root", async () => {
    await expect(moveProcessToAgentCgroup(1, linuxOptions("agents"))).resolves.toBe(false);
    expect(warnings[0]).toContain("absolute path");

    resetAgentCgroupWarningForTests();
    warnings.length = 0;
    const escape = path.join(root, "..", path.basename(root) + "-outside");
    await expect(moveProcessToAgentCgroup(1, linuxOptions(escape))).resolves.toBe(false);
    await expect(moveProcessToAgentCgroup(1, linuxOptions(path.join(leaf, "..", "..", "..", "..")))).resolves.toBe(false);
    await expect(moveProcessToAgentCgroup(1, linuxOptions(root))).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("must point under");
  });

  it("fails open with one warning when the leaf is missing", async () => {
    const missing = path.join(root, "system.slice", "missing", "agents");
    await expect(moveProcessToAgentCgroup(1, linuxOptions(missing))).resolves.toBe(false);
    await expect(moveProcessToAgentCgroup(2, linuxOptions(missing))).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ENOENT");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails open with one warning when the leaf is not writable",
    async () => {
      await fs.chmod(path.join(leaf, "cgroup.procs"), 0o444);
      await expect(moveProcessToAgentCgroup(1, linuxOptions(leaf))).resolves.toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("EACCES");
    },
  );

  it("never throws when the logger throws", async () => {
    const options = {
      ...linuxOptions(path.join(root, "nope")),
      warn: () => {
        throw new Error("logger down");
      },
    };
    await expect(moveProcessToAgentCgroup(1, options)).resolves.toBe(false);
  });

  it("runChildProcess runs the child unchanged when the configured leaf cannot be used", async () => {
    const previous = process.env[AGENT_CGROUP_ENV];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[AGENT_CGROUP_ENV] = `/sys/fs/cgroup/rk9-357-missing-${randomUUID()}/agents`;
    try {
      const result = await runChildProcess(
        randomUUID(),
        process.execPath,
        ["-e", "process.stdout.write(String(Boolean(process.env.PAPERCLIP_AGENT_CGROUP)))"],
        {
          cwd: process.cwd(),
          env: {},
          timeoutSec: 10,
          graceSec: 1,
          onLog: async () => {},
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      // The server-side variable is not inherited by the agent run.
      expect(result.stdout).toBe("false");
    } finally {
      if (previous === undefined) delete process.env[AGENT_CGROUP_ENV];
      else process.env[AGENT_CGROUP_ENV] = previous;
      warnSpy.mockRestore();
    }
  });
});
// --- /RK9 Custom ---
