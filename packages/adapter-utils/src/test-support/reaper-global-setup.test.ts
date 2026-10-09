import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, inject, it } from "vitest";

import { getProcessSessionRemoteSource } from "../execution-target.js";
import { REAPER_MARKER_ENV_KEY } from "./proc-sweep.js";
import { sweepMarkedTestOrphans, testTempRootPrefixes } from "./reaper-global-setup.js";

// RK9-462: the reaper's exit hook does not run when a worker is killed by a
// signal, so the vitest globalTeardown sweeps by the run marker instead.
describe.skipIf(process.platform !== "linux")("test reaper globalSetup and globalTeardown (RK9-462)", () => {
  const roots: string[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    // These processes carry another marker than this run's, so the reaper of
    // this run would not find them: kill them by pid.
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  // A zombie still answers kill(pid, 0), so read the process state.
  function alive(pid: number): boolean {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }

  async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
  }

  function environOf(pid: number): string[] {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    } catch {
      return [];
    }
  }

  const sleeper = ["-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`];

  it("hands the run marker to the worker and to a process its child spawns", async () => {
    const marker = inject("pcpTestReaperMarker");
    expect(marker).toMatch(/^[0-9a-f-]{36}$/);
    expect(process.env[REAPER_MARKER_ENV_KEY]).toBe(marker);

    // The child inherits the worker env and starts a grandchild the same way.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ${JSON.stringify(sleeper)}, { stdio: "ignore", detached: true });` +
          ` c.unref(); console.log(c.pid);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    await new Promise((resolve) => child.once("exit", resolve));
    const grandchild = Number.parseInt(out.trim(), 10);
    expect(Number.isFinite(grandchild)).toBe(true);
    pids.push(grandchild);
    expect(environOf(grandchild)).toContain(`${REAPER_MARKER_ENV_KEY}=${marker}`);
  });

  it("kills only processes that carry the given marker and name a test temp root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-reaper-sweep-"));
    roots.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "pcp-reaper-outside-"));
    roots.push(outside);
    const marker = `sweep-test-${process.pid}-${Date.now()}`;
    const started: Array<{ pid: number; entry: string }> = [];
    const start = (cwd: string, value: string) => {
      const proc = spawn(process.execPath, sleeper, {
        cwd,
        env: { PATH: process.env.PATH ?? "", [REAPER_MARKER_ENV_KEY]: value },
        stdio: "ignore",
      });
      pids.push(proc.pid!);
      started.push({ pid: proc.pid!, entry: `${REAPER_MARKER_ENV_KEY}=${value}` });
      return proc.pid!;
    };
    const target = start(root, marker);
    const otherMarker = start(root, `${marker}-other`);
    const otherPath = start(outside, marker);
    // Until exec, /proc still shows the worker's own environment.
    expect(await waitUntil(() => started.every(({ pid, entry }) => environOf(pid).includes(entry)), 5_000)).toBe(true);

    expect(sweepMarkedTestOrphans(marker, testTempRootPrefixes())).toEqual([target]);
    expect(await waitUntil(() => !alive(target), 5_000)).toBe(true);
    expect(alive(otherMarker)).toBe(true);
    expect(alive(otherPath)).toBe(true);
  });

  // The inner vitest test starts a process-session wrapper (detached, as the
  // remote `nohup ... &` does), records the wrapper and agent pids, and then
  // SIGKILLs its own worker, so the reaper's exit hook never runs.
  const innerTest = `
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
it("dies mid process-session run", async () => {
  const wrapper = spawn(process.execPath, [process.env.E2E_WRAPPER], {
    cwd: process.env.E2E_ROOT, detached: true, stdio: "ignore",
  });
  wrapper.unref();
  let child = 0;
  for (let i = 0; i < 200 && !child; i += 1) {
    const out = spawnSync("pgrep", ["-P", String(wrapper.pid)], { encoding: "utf8" }).stdout.trim();
    child = Number.parseInt(out.split("\\n")[0] || "", 10) || 0;
    if (!child) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  writeFileSync(process.env.E2E_PIDS, JSON.stringify({ wrapper: wrapper.pid, child }));
  process.kill(process.pid, "SIGKILL");
});
`;

  async function runWorkerKilledMidRun(withGlobalSetup: boolean) {
    const outer = await mkdtemp(path.join(os.tmpdir(), "paperclip-reaper-teardown-"));
    roots.push(outer);
    // The inner run gets its own tmpdir, so its teardown only sees its own roots.
    const tmp = path.join(outer, "t");
    const root = path.join(tmp, "paperclip-process-session-e2e");
    const sessionDir = path.join(root, "session");
    const cwd = path.join(root, "cwd");
    await mkdir(path.join(sessionDir, "stdin"), { recursive: true });
    await mkdir(path.join(sessionDir, "events"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const wrapper = path.join(root, "paperclip-process-session-remote.mjs");
    await writeFile(wrapper, getProcessSessionRemoteSource({ outputToStdout: false }), "utf8");
    const command = { command: process.execPath, args: sleeper, cwd, env: {} };

    const setupFile = fileURLToPath(new URL("./reaper-global-setup.ts", import.meta.url));
    const config = path.join(outer, "vitest.inner.config.mjs");
    await writeFile(
      config,
      `export default { test: ${JSON.stringify({
        root: outer,
        include: ["inner.test.mjs"],
        // The test kills its own process: it must be a forked worker, never the main process.
        pool: "forks",
        globals: true,
        globalSetup: withGlobalSetup ? [setupFile] : [],
      })} };\n`,
      "utf8",
    );
    await writeFile(path.join(outer, "inner.test.mjs"), innerTest, "utf8");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: tmp,
      E2E_ROOT: root,
      E2E_WRAPPER: wrapper,
      E2E_PIDS: path.join(outer, "pids.json"),
      PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
      PAPERCLIP_PROCESS_SESSION_COMMAND_B64: Buffer.from(JSON.stringify(command), "utf8").toString("base64"),
      PAPERCLIP_PROCESS_SESSION_WATCH_INTERVAL_MS: "100",
      PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS: "300",
    };
    // A fresh run: no marker of this run, and no worker state of this vitest.
    delete env[REAPER_MARKER_ENV_KEY];
    for (const key of Object.keys(env)) if (key.startsWith("VITEST")) delete env[key];

    const vitestBin = path.join(
      path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
      "vitest.mjs",
    );
    const result = spawnSync(process.execPath, [vitestBin, "run", "--config", config], {
      cwd: outer,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const recorded = JSON.parse(await readFile(env.E2E_PIDS!, "utf8")) as { wrapper: number; child: number };
    pids.push(recorded.wrapper, recorded.child);
    return { result, ...recorded };
  }

  it("leaves a wrapper and its agent behind without the globalSetup (the scenario is real)", async () => {
    const run = await runWorkerKilledMidRun(false);
    expect(run.result.stdout + run.result.stderr).toContain("Worker exited unexpectedly");
    expect(run.child).toBeGreaterThan(0);
    expect(alive(run.wrapper)).toBe(true);
    expect(alive(run.child)).toBe(true);
  }, 90_000);

  it("leaves no marked process alive after the globalTeardown when the worker is SIGKILLed", async () => {
    const run = await runWorkerKilledMidRun(true);
    expect(run.result.stdout + run.result.stderr).toContain("Worker exited unexpectedly");
    expect(run.child).toBeGreaterThan(0);
    expect(await waitUntil(() => !alive(run.wrapper) && !alive(run.child), 5_000)).toBe(true);
  }, 90_000);
});
