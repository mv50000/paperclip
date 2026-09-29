import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getProcessSessionRemoteSource } from "./execution-target.js";
import { reapProcessesUnder, reaperMarkerEnv } from "./test-support/reap-process-session-orphans.js";

// RK9-358: the wrapper runs detached, so a run that dies must not leave the
// wrapper or its agent child behind.
describe.skipIf(process.platform !== "linux")("process session wrapper orphan defense (RK9-358)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await reapProcessesUnder(roots);
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
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

  // The child prints its pid, then sleeps and ignores SIGTERM like a stubborn agent.
  const stubbornChild = {
    command: process.execPath,
    args: ["-e", `console.log(process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`],
  };

  async function launch(outputToStdout: boolean, agent: { command: string; args: string[] } = stubbornChild) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-orphan-defense-"));
    roots.push(root);
    const sessionDir = path.join(root, "session");
    const cwd = path.join(root, "cwd");
    await mkdir(path.join(sessionDir, "stdin"), { recursive: true });
    await mkdir(path.join(sessionDir, "events"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const script = path.join(root, "wrapper.mjs");
    await writeFile(script, getProcessSessionRemoteSource({ outputToStdout }), "utf8");
    const commandPayload = Buffer.from(
      JSON.stringify({ command: agent.command, args: agent.args, cwd, env: {} }),
      "utf8",
    ).toString("base64");
    const wrapper = spawn(process.execPath, [script], {
      cwd: root,
      // Only what the wrapper needs: the full process.env would copy the agent's
      // own credentials (PAPERCLIP_API_KEY) into a process that may outlive the test.
      env: {
        PATH: process.env.PATH ?? "",
        ...reaperMarkerEnv(),
        PAPERCLIP_PROCESS_SESSION_DIR: sessionDir,
        PAPERCLIP_PROCESS_SESSION_COMMAND_B64: commandPayload,
        PAPERCLIP_PROCESS_SESSION_WATCH_INTERVAL_MS: "100",
        PAPERCLIP_PROCESS_SESSION_TERMINATE_GRACE_MS: "300",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    wrapper.stdout.resume();
    wrapper.stderr.resume();
    return { root, sessionDir, cwd, wrapper };
  }

  async function childPid(handle: Awaited<ReturnType<typeof launch>>): Promise<number> {
    // Locate the child by its parent pid.
    let pid = 0;
    const ok = await waitUntil(() => {
      const out = spawnSync("pgrep", ["-P", String(handle.wrapper.pid)], { encoding: "utf8" }).stdout.trim();
      pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(pid);
    }, 10_000);
    expect(ok).toBe(true);
    return pid;
  }

  for (const outputToStdout of [false, true]) {
    it(`ends the wrapper and its child when the session directory disappears (stream=${outputToStdout})`, async () => {
      const handle = await launch(outputToStdout);
      const child = await childPid(handle);
      const wrapperPid = handle.wrapper.pid!;
      await rm(handle.sessionDir, { recursive: true, force: true });
      expect(await waitUntil(() => !alive(wrapperPid) && !alive(child), 10_000)).toBe(true);
    });

    it(`ends the wrapper and its child when the child working directory disappears (stream=${outputToStdout})`, async () => {
      const handle = await launch(outputToStdout);
      const child = await childPid(handle);
      const wrapperPid = handle.wrapper.pid!;
      await rm(handle.cwd, { recursive: true, force: true });
      expect(await waitUntil(() => !alive(wrapperPid) && !alive(child), 10_000)).toBe(true);
    });
  }

  it("kills the child when the wrapper receives SIGTERM", async () => {
    const handle = await launch(false);
    const child = await childPid(handle);
    handle.wrapper.kill("SIGTERM");
    expect(await waitUntil(() => !alive(child), 10_000)).toBe(true);
  });

  // RK9-361: the child exits, but a subprocess of its own keeps the stdout and
  // stderr pipes open, so "close" never fires. SIGTERM must still end the wrapper.
  for (const outputToStdout of [false, true]) {
    it(`exits on SIGTERM while a grandchild holds the output pipes (stream=${outputToStdout})`, async () => {
      const handle = await launch(outputToStdout, {
        command: "/bin/sh",
        args: ["-c", "sleep 25 & echo started > started; exit 0"],
      });
      const wrapperPid = handle.wrapper.pid!;
      const started = path.join(handle.cwd, "started");
      const exited = new Promise<void>((resolve) => handle.wrapper.once("exit", () => resolve()));
      expect(await waitUntil(() => existsSync(started), 10_000)).toBe(true);
      // Wait until the shell itself is gone, so only the sleep holds the pipes.
      expect(
        await waitUntil(
          () => spawnSync("pgrep", ["-P", String(wrapperPid)], { encoding: "utf8" }).stdout.trim() === "",
          10_000,
        ),
      ).toBe(true);
      const sentAt = Date.now();
      handle.wrapper.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
      expect(alive(wrapperPid)).toBe(false);
      expect(Date.now() - sentAt).toBeLessThan(3_000);
      expect(handle.wrapper.exitCode ?? handle.wrapper.signalCode).not.toBe(0);
    });
  }
});
