import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";

/**
 * The environment key that marks a process as spawned by this test run.
 *
 * The name must not start with `PAPERCLIP_`: `runChildProcess` strips inherited
 * `PAPERCLIP_*` keys, so such a marker would never reach the wrapper or the
 * bridge server. The first test module that loads this file sets the value, and
 * every process the test run spawns afterwards inherits it.
 */
export const REAPER_MARKER_ENV_KEY = "PCP_TEST_REAPER_MARKER";
if (!process.env[REAPER_MARKER_ENV_KEY]) process.env[REAPER_MARKER_ENV_KEY] = randomUUID();

/** The marker entry, for a test that spawns a process with a hand-built env. */
export function reaperMarkerEnv(): Record<string, string> {
  return { [REAPER_MARKER_ENV_KEY]: process.env[REAPER_MARKER_ENV_KEY] ?? "" };
}

// Every root a test has handed to the reaper. A run that timed out keeps going
// in the background after its test's teardown, so it can start a new wrapper
// or bridge server after the reap in afterEach. The exit hook below sweeps all
// of these roots once more when the test worker ends.
const seenRoots = new Set<string>();

function ownedByRoots(
  candidate: { cmdline: string; environ: string; cwd: string },
  roots: Iterable<string>,
  markerEntry: string,
): boolean {
  if (!candidate.environ.split("\0").includes(markerEntry)) return false;
  // The kernel appends " (deleted)" to the cwd link once the directory is gone.
  const cwdPath = candidate.cwd.replace(/ \(deleted\)$/, "");
  for (const root of roots) {
    if (
      candidate.cmdline.includes(root) ||
      candidate.environ.includes(root) ||
      cwdPath === root ||
      cwdPath.startsWith(`${root}/`)
    ) {
      return true;
    }
  }
  return false;
}

process.once("exit", () => {
  const marker = process.env[REAPER_MARKER_ENV_KEY];
  if (seenRoots.size === 0 || !marker) return;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return;
  }
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const base = `/proc/${entry}`;
    let cwd = "";
    try {
      cwd = readlinkSync(`${base}/cwd`);
    } catch {
      // Gone, or owned by another user.
    }
    const candidate = { cmdline: read(`${base}/cmdline`), environ: read(`${base}/environ`), cwd };
    if (!ownedByRoots(candidate, seenRoots, `${REAPER_MARKER_ENV_KEY}=${marker}`)) continue;
    try {
      process.kill(Number(entry), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/**
 * Kill every process that still belongs to one of the given temp roots.
 *
 * A remote-run test stages a process-session wrapper (`nohup node
 * paperclip-process-session-remote.mjs &`), the agent command it spawns and the
 * sandbox callback bridge server. All of them outlive the test when a run fails
 * or times out, so the test's own teardown must not rely on the run's cleanup.
 * A process belongs to a root when its command line, working directory or
 * environment names that root AND its environment carries this test run's
 * marker, so an unrelated process of the same user is never hit. Linux only:
 * other platforms have no /proc and do nothing.
 */
export async function reapProcessesUnder(roots: readonly string[]): Promise<number> {
  const needles = roots.filter((root) => root.length > 0);
  const marker = process.env[REAPER_MARKER_ENV_KEY];
  if (needles.length === 0 || !marker) return 0;
  const markerEntry = `${REAPER_MARKER_ENV_KEY}=${marker}`;
  for (const root of needles) seenRoots.add(root);
  let entries: string[];
  try {
    entries = await fs.readdir("/proc");
  } catch {
    return 0;
  }
  let killed = 0;
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
      .map(async (entry) => {
        const base = `/proc/${entry}`;
        const [cmdline, environ, cwd] = await Promise.all([
          fs.readFile(`${base}/cmdline`, "utf8").catch(() => ""),
          fs.readFile(`${base}/environ`, "utf8").catch(() => ""),
          fs.readlink(`${base}/cwd`).catch(() => ""),
        ]);
        if (!ownedByRoots({ cmdline, environ, cwd }, needles, markerEntry)) return;
        try {
          process.kill(Number(entry), "SIGKILL");
          killed += 1;
        } catch {
          // Already gone, or owned by another user.
        }
      }),
  );
  return killed;
}
