// --- RK9 Custom (RK9-357): upstream has no agent cgroup. See doc/upgrade/agent-cgroup.md ---
//
// Moves an agent-run child process into a separate cgroup v2 leaf, so agent
// load (CLI runs, ACP sidecars, builds) cannot starve the board API.
//
// The host unit delegates its cgroup (`Delegate=yes`), runs the server in a
// `server/` leaf and creates an `agents/` leaf next to it. It then sets
// `PAPERCLIP_AGENT_CGROUP` to the absolute path of the `agents/` leaf. Each
// spawn site calls `moveProcessToAgentCgroup(child.pid)` right after the spawn.
// Descendants inherit the cgroup, so one move per spawned child is enough.
//
// The feature fails open. When the variable is unset, nothing happens. When it
// is set but the move is impossible (not Linux, a path outside /sys/fs/cgroup,
// a missing or unwritable leaf), the child keeps running in the server cgroup
// and the helper logs one warning per process. The helper never throws and
// never rejects. Kill, cancel and timeout paths do not depend on it: they
// signal the process group, and a cgroup move does not change the group.

import { promises as fs } from "node:fs";
import path from "node:path";

export const AGENT_CGROUP_ENV = "PAPERCLIP_AGENT_CGROUP";
export const CGROUP_FS_ROOT = "/sys/fs/cgroup";

export interface MoveToAgentCgroupOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Root the configured path must live under. Tests point this at a temp dir. */
  cgroupRoot?: string;
  warn?: (message: string) => void;
}

let warned = false;

/** Test-only: allow the one-time warning to fire again. */
export function resetAgentCgroupWarningForTests() {
  warned = false;
}

function warnOnce(warn: (message: string) => void, message: string) {
  if (warned) return;
  warned = true;
  try {
    warn(`[agent-cgroup] ${message}; agent processes stay in the server cgroup`);
  } catch {
    // A failing logger must not break the spawn path.
  }
}

/**
 * Returns the `cgroup.procs` file of the configured agent leaf, or null when
 * the feature is off or cannot work on this host.
 */
export function resolveAgentCgroupProcsPath(
  options: MoveToAgentCgroupOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cgroupRoot = path.resolve(options.cgroupRoot ?? CGROUP_FS_ROOT);
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const raw = env[AGENT_CGROUP_ENV]?.trim();
  if (!raw) return null;
  if (platform !== "linux") {
    warnOnce(warn, `${AGENT_CGROUP_ENV} is set but the platform is ${platform}, not linux`);
    return null;
  }
  if (!path.isAbsolute(raw)) {
    warnOnce(warn, `${AGENT_CGROUP_ENV} must be an absolute path, got "${raw}"`);
    return null;
  }
  const leaf = path.resolve(raw);
  if (!leaf.startsWith(`${cgroupRoot}${path.sep}`)) {
    warnOnce(warn, `${AGENT_CGROUP_ENV} must point under ${cgroupRoot}, got "${raw}"`);
    return null;
  }
  return path.join(leaf, "cgroup.procs");
}

/**
 * Moves `pid` into the agent cgroup leaf. Resolves true when the move
 * succeeded and false otherwise. Never rejects.
 */
export async function moveProcessToAgentCgroup(
  pid: number | null | undefined,
  options: MoveToAgentCgroupOptions = {},
): Promise<boolean> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let procsPath: string | null;
  try {
    procsPath = resolveAgentCgroupProcsPath({ ...options, warn });
  } catch {
    return false;
  }
  if (!procsPath) return false;
  try {
    // Async on purpose: a cgroup migration can wait on a kernel lock, and a
    // synchronous write would stall the server event loop for that time.
    await fs.writeFile(procsPath, `${pid}\n`, { flag: "a" });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // ESRCH: the child already exited. That is a normal race, not a setup error.
    if (code === "ESRCH") return false;
    warnOnce(
      warn,
      `cannot write pid to ${procsPath} (${code ?? (err instanceof Error ? err.message : String(err))})`,
    );
    return false;
  }
}
// --- /RK9 Custom ---
