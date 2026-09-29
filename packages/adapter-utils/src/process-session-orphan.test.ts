import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getProcessSessionRemoteSource } from "./execution-target.js";
import { reapProcessesUnder } from "./test-support/reap-process-session-orphans.js";

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

  async function launch(outputToStdout: boolean) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-orphan-defense-"));
    roots.push(root);
    const sessionDir = path.join(root, "session");
    const cwd = path.join(root, "cwd");
    await mkdir(path.join(sessionDir, "stdin"), { recursive: true });
    await mkdir(path.join(sessionDir, "events"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const script = path.join(root, "wrapper.mjs");
    await writeFile(script, getProcessSessionRemoteSource({ outputToStdout }), "utf8");
    // The child prints its pid, then sleeps and ignores SIGTERM like a stubborn agent.
    const childSource = `console.log(process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const commandPayload = Buffer.from(
      JSON.stringify({ command: process.execPath, args: ["-e", childSource], cwd, env: {} }),
      "utf8",
    ).toString("base64");
    const wrapper = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
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
});
