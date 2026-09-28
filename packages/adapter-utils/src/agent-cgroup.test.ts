// --- RK9 Custom (RK9-357): agent cgroup leaf. See doc/upgrade/agent-cgroup.md ---
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CGROUP_ENV,
  AGENT_OOM_SCORE_ADJ,
  moveProcessToAgentCgroup,
  resetAgentCgroupWarningForTests,
  resolveAgentCgroupProcsPath,
  withoutAgentCgroupEnv,
} from "./agent-cgroup.js";
import { runChildProcess } from "./server-utils.js";

describe("agent cgroup leaf", () => {
  let root: string;
  let leaf: string;
  let procRoot: string;
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
    procRoot = path.join(root, "proc");
    for (const pid of [4321, 4322]) {
      await fs.mkdir(path.join(procRoot, String(pid)), { recursive: true });
      await fs.writeFile(path.join(procRoot, String(pid), "oom_score_adj"), "0\n");
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const linuxOptions = (value: string | undefined) => ({
    env: value === undefined ? {} : { [AGENT_CGROUP_ENV]: value },
    platform: "linux" as NodeJS.Platform,
    cgroupRoot: root,
    procRoot,
    warn,
  });

  it("does nothing and stays silent when the variable is unset", async () => {
    expect(resolveAgentCgroupProcsPath(linuxOptions(undefined))).toBeNull();
    expect(resolveAgentCgroupProcsPath(linuxOptions("   "))).toBeNull();
    expect(moveProcessToAgentCgroup(1234, linuxOptions(undefined))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("writes the pid into cgroup.procs of the configured leaf", async () => {
    expect(moveProcessToAgentCgroup(4321, linuxOptions(leaf))).toBe(true);
    expect(moveProcessToAgentCgroup(4322, linuxOptions(`${leaf}/`))).toBe(true);
    const written = await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8");
    expect(written).toBe("4321\n4322\n");
    for (const pid of [4321, 4322]) {
      const adj = await fs.readFile(path.join(procRoot, String(pid), "oom_score_adj"), "utf8");
      expect(adj.trim()).toBe(String(AGENT_OOM_SCORE_ADJ));
    }
    expect(warnings).toEqual([]);
  });

  it("keeps the move when oom_score_adj cannot be raised", async () => {
    // The pid has no proc entry: ENOENT is silent (the child already exited).
    expect(moveProcessToAgentCgroup(9999, linuxOptions(leaf))).toBe(true);
    expect(warnings).toEqual([]);
    await fs.chmod(path.join(procRoot, "4321", "oom_score_adj"), 0o444);
    if (process.getuid?.() !== 0) {
      expect(moveProcessToAgentCgroup(4321, linuxOptions(leaf))).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("oom_score_adj");
    }
  });

  it("warns once per reason, so a later different failure is still reported", async () => {
    const missing = path.join(root, "system.slice", "missing", "agents");
    expect(moveProcessToAgentCgroup(1, linuxOptions(missing))).toBe(false);
    expect(moveProcessToAgentCgroup(2, linuxOptions(missing))).toBe(false);
    expect(moveProcessToAgentCgroup(3, linuxOptions("relative"))).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("ENOENT");
    expect(warnings[1]).toContain("absolute path");
  });

  it("sweeps descendants that were forked before the move landed", async () => {
    // Server pid 100 runs in server/. Child 200 forked 201 (then 202 under 201) before the move.
    // 300 is an unrelated server helper, 301 its child; 400's parent chain is unreadable.
    const serverLeaf = path.join(root, "system.slice", "paperclip.service", "server");
    await fs.mkdir(serverLeaf, { recursive: true });
    await fs.writeFile(path.join(serverLeaf, "cgroup.procs"), "100\n201\n202\n300\n301\n400\n");
    await fs.mkdir(path.join(procRoot, "self"), { recursive: true });
    await fs.writeFile(path.join(procRoot, "self", "cgroup"), "0::/system.slice/paperclip.service/server\n");
    const parents: Record<number, number> = { 100: 1, 200: 100, 201: 200, 202: 201, 300: 100, 301: 300 };
    for (const [pid, ppid] of Object.entries(parents)) {
      await fs.mkdir(path.join(procRoot, pid), { recursive: true });
      await fs.writeFile(path.join(procRoot, pid, "stat"), `${pid} (sh (x) y) S ${ppid} ${pid} ${pid} 0\n`);
      await fs.writeFile(path.join(procRoot, pid, "oom_score_adj"), "0\n");
    }

    expect(moveProcessToAgentCgroup(200, { ...linuxOptions(leaf), selfPid: 100 })).toBe(true);

    const agents = (await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).trim().split("\n");
    expect(agents).toEqual(["200", "201", "202"]);
    for (const pid of ["200", "201", "202"]) {
      expect((await fs.readFile(path.join(procRoot, pid, "oom_score_adj"), "utf8")).trim()).toBe("500");
    }
    for (const pid of ["100", "300", "301"]) {
      expect((await fs.readFile(path.join(procRoot, pid, "oom_score_adj"), "utf8")).trim()).toBe("0");
    }
    expect(warnings).toEqual([]);
  });

  it("does not sweep when the server cgroup cannot be read", async () => {
    await fs.mkdir(path.join(procRoot, "self"), { recursive: true });
    await fs.writeFile(path.join(procRoot, "self", "cgroup"), "0::/../../escape\n");
    expect(moveProcessToAgentCgroup(4321, { ...linuxOptions(leaf), selfPid: 100 })).toBe(true);
    expect((await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).trim()).toBe("4321");
  });

  it("never moves the server's own pid", async () => {
    expect(moveProcessToAgentCgroup(4321, { ...linuxOptions(leaf), selfPid: 4321 })).toBe(false);
    expect(await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).toBe("");
    expect((await fs.readFile(path.join(procRoot, "4321", "oom_score_adj"), "utf8")).trim()).toBe("0");
  });

  it("strips the server-only variable from a child env", () => {
    const env = { [AGENT_CGROUP_ENV]: leaf, PATH: "/usr/bin" };
    expect(withoutAgentCgroupEnv(env)).toEqual({ PATH: "/usr/bin" });
    expect(env[AGENT_CGROUP_ENV]).toBe(leaf);
  });

  it("rejects invalid pids without touching the leaf", async () => {
    for (const pid of [undefined, null, 0, -5, 1.5, Number.NaN]) {
      expect(moveProcessToAgentCgroup(pid, linuxOptions(leaf))).toBe(false);
    }
    expect(await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).toBe("");
  });

  it("fails open on a non-Linux platform with one warning", async () => {
    const options = { ...linuxOptions(leaf), platform: "darwin" as NodeJS.Platform };
    expect(moveProcessToAgentCgroup(1, options)).toBe(false);
    expect(moveProcessToAgentCgroup(2, options)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("darwin");
    expect(await fs.readFile(path.join(leaf, "cgroup.procs"), "utf8")).toBe("");
  });

  it("refuses a relative path or a path outside the cgroup root", async () => {
    expect(moveProcessToAgentCgroup(1, linuxOptions("agents"))).toBe(false);
    expect(warnings[0]).toContain("absolute path");

    resetAgentCgroupWarningForTests();
    warnings.length = 0;
    const escape = path.join(root, "..", path.basename(root) + "-outside");
    expect(moveProcessToAgentCgroup(1, linuxOptions(escape))).toBe(false);
    expect(moveProcessToAgentCgroup(1, linuxOptions(path.join(leaf, "..", "..", "..", "..")))).toBe(false);
    expect(moveProcessToAgentCgroup(1, linuxOptions(root))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("must point under");
  });

  it("leaves oom_score_adj untouched when the leaf cannot take the pid", async () => {
    await fs.chmod(path.join(leaf, "cgroup.procs"), 0o444);
    if (process.getuid?.() !== 0) {
      expect(moveProcessToAgentCgroup(4321, linuxOptions(leaf))).toBe(false);
      expect((await fs.readFile(path.join(procRoot, "4321", "oom_score_adj"), "utf8")).trim()).toBe("0");
    }
  });

  it("fails open with one warning when the leaf is missing", async () => {
    const missing = path.join(root, "system.slice", "missing", "agents");
    expect(moveProcessToAgentCgroup(1, linuxOptions(missing))).toBe(false);
    expect(moveProcessToAgentCgroup(2, linuxOptions(missing))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ENOENT");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails open with one warning when the leaf is not writable",
    async () => {
      await fs.chmod(path.join(leaf, "cgroup.procs"), 0o444);
      expect(moveProcessToAgentCgroup(1, linuxOptions(leaf))).toBe(false);
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
    expect(moveProcessToAgentCgroup(1, options)).toBe(false);
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
