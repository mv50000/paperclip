import fs from "node:fs/promises";

/**
 * Kill every process that still belongs to one of the given temp roots.
 *
 * A remote-run test stages a process-session wrapper (`nohup node
 * paperclip-process-session-remote.mjs &`) and the agent command it spawns. Both
 * outlive the test when a run fails or times out, so the test's own teardown
 * must not rely on the run's cleanup. A process belongs to a root when its
 * command line, working directory or environment names that root. Linux only:
 * other platforms have no /proc and do nothing.
 */
export async function reapProcessesUnder(roots: readonly string[]): Promise<number> {
  const needles = roots.filter((root) => root.length > 0);
  if (needles.length === 0) return 0;
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
        const owned = needles.some(
          (root) => cmdline.includes(root) || environ.includes(root) || cwd === root || cwd.startsWith(`${root}/`),
        );
        if (!owned) return;
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
