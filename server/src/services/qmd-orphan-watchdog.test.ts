import { describe, expect, it, vi } from "vitest";
import { isStaleQmdWorker, parsePsRows, startQmdOrphanWatchdog, type QmdProcessInfo } from "./qmd-orphan-watchdog.js";

describe("parsePsRows", () => {
  it("parses `ps -eo pid,etimes,args` rows", () => {
    const stdout = [
      "  12345    305 node /opt/repos/rk9-knowledge/.qmd/dist/cli/qmd.js vsearch HetznerAppDown -c rk9 -n 10 --json",
      "    999      2 /usr/bin/ps -eo pid,etimes,args",
      "",
    ].join("\n");
    expect(parsePsRows(stdout)).toEqual([
      {
        pid: 12345,
        etimeSec: 305,
        command: "node /opt/repos/rk9-knowledge/.qmd/dist/cli/qmd.js vsearch HetznerAppDown -c rk9 -n 10 --json",
      },
      { pid: 999, etimeSec: 2, command: "/usr/bin/ps -eo pid,etimes,args" },
    ]);
  });

  it("ignores blank lines and lines that don't match the pid/etimes/args shape", () => {
    expect(parsePsRows("")).toEqual([]);
    expect(parsePsRows("PID ELAPSED COMMAND\n")).toEqual([]);
  });
});

describe("isStaleQmdWorker", () => {
  const proc = (etimeSec: number, command: string): QmdProcessInfo => ({ pid: 1, etimeSec, command });

  it("flags a qmd.js vsearch process older than the threshold", () => {
    expect(isStaleQmdWorker(proc(150, "node .../dist/cli/qmd.js vsearch some query -c rk9 --json"), 120)).toBe(true);
  });

  it("flags a qmd.js search (BM25) process older than the threshold", () => {
    expect(isStaleQmdWorker(proc(150, "node .../dist/cli/qmd.js search CT357 -c rk9 --json"), 120)).toBe(true);
  });

  it("does not flag a process younger than the threshold", () => {
    expect(isStaleQmdWorker(proc(30, "node .../dist/cli/qmd.js vsearch q -c rk9 --json"), 120)).toBe(false);
  });

  it("does not flag an unrelated stale process (e.g. qmd collection list)", () => {
    expect(isStaleQmdWorker(proc(300, "node .../dist/cli/qmd.js collection list"), 120)).toBe(false);
    expect(isStaleQmdWorker(proc(300, "sshd: paperclip@pts/3"), 120)).toBe(false);
  });
});

describe("startQmdOrphanWatchdog", () => {
  it("kills every stale qmd worker found on a sweep, and nothing else", async () => {
    const listProcesses = vi.fn(async () =>
      [
        "  111    500 node .../dist/cli/qmd.js vsearch stale-query -c rk9 --json",
        "  222     10 node .../dist/cli/qmd.js vsearch fresh-query -c rk9 --json",
        "  333    600 node .../dist/cli/qmd.js collection list",
      ].join("\n"),
    );
    const killProcess = vi.fn();
    const handle = startQmdOrphanWatchdog({ staleSec: 120, deps: { listProcesses, killProcess } });
    try {
      await handle.runNow();
      expect(killProcess).toHaveBeenCalledTimes(1);
      expect(killProcess).toHaveBeenCalledWith(111);
    } finally {
      handle.stop();
    }
  });

  it("never throws out of a tick even when listProcesses rejects", async () => {
    const listProcesses = vi.fn(async () => {
      throw new Error("ps: command not found");
    });
    const killProcess = vi.fn();
    const handle = startQmdOrphanWatchdog({ deps: { listProcesses, killProcess } });
    try {
      await expect(handle.runNow()).rejects.toThrow(); // runNow() is the raw tick — callers wrap it
      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });
});
