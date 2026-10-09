import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * The environment key that marks a process as spawned by this test run.
 *
 * The name must not start with `PAPERCLIP_`: `runChildProcess` strips inherited
 * `PAPERCLIP_*` keys, so such a marker would never reach the wrapper or the
 * bridge server.
 */
export const REAPER_MARKER_ENV_KEY = "PCP_TEST_REAPER_MARKER";

/** The `project.provide` key under which the vitest globalSetup hands the marker to the workers. */
export const REAPER_MARKER_PROVIDE_KEY = "pcpTestReaperMarker";

export interface ProcCandidate {
  pid: number;
  cmdline: string;
  environ: string;
  /** The working directory link, without the " (deleted)" suffix the kernel adds once the directory is gone. */
  cwd: string;
}

/** True when the process environment carries exactly this marker value. */
export function carriesMarker(candidate: ProcCandidate, marker: string): boolean {
  return candidate.environ.split("\0").includes(`${REAPER_MARKER_ENV_KEY}=${marker}`);
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * SIGKILL every process for which `belongs` is true, synchronously, and return
 * the pids it signalled. It never signals itself or its parent. Linux only:
 * other platforms have no /proc and do nothing.
 */
export function sweepProcessesSync(belongs: (candidate: ProcCandidate) => boolean): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || pid === process.ppid) continue;
    const base = `/proc/${entry}`;
    let cwd = "";
    try {
      cwd = readlinkSync(`${base}/cwd`).replace(/ \(deleted\)$/, "");
    } catch {
      // Gone, or owned by another user.
    }
    const candidate = { pid, cmdline: readOrEmpty(`${base}/cmdline`), environ: readOrEmpty(`${base}/environ`), cwd };
    if (!belongs(candidate)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // Already gone.
    }
  }
  return killed;
}
