// --- RK9 Custom (RK9-357): upstream has no agent cgroup. See doc/upgrade/agent-cgroup.md ---
//
// Moves an agent-run child process into a separate cgroup v2 leaf, so agent
// load (CLI runs, ACP sidecars, builds) cannot starve the board API.
//
// The host unit delegates its cgroup (`Delegate=yes`), runs the server in a
// `server/` leaf and creates an `agents/` leaf next to it. It then sets
// `PAPERCLIP_AGENT_CGROUP` to the absolute path of the `agents/` leaf. Each
// spawn site calls `moveProcessToAgentCgroup(child.pid)` right after the spawn.
// Descendants inherit the cgroup, so one move per spawned child is enough as
// long as it lands before the child forks.
//
// The write is synchronous on purpose. An async write needs event-loop round
// trips; under load that is hundreds of milliseconds, and early descendants
// (MCP servers, a bwrap sandbox child) would stay in the server leaf. A cgroup
// migration waits for an RCU grace period: 5 ms p50 and 12 ms p95 on CT 354 at
// 92 % CPU pressure (28.9.2026), the same order as the fork in `spawn()`
// itself. Agent spawns are rare.
//
// Even a synchronous write races a child that forks at once (`sh -c "a & b"`):
// the fork can land while the migration waits. So after the move the helper
// sweeps the server's own cgroup and moves every process whose parent chain
// reaches the child. Processes forked by an already moved process are born in
// the agent leaf, so a few passes converge. The sweep never moves the server
// process itself or anything outside the child's subtree.
//
// After a successful move the child's oom_score_adj is raised, so a
// service-wide OOM picks an agent process before the server. Descendants
// inherit the value. Raising it needs no privilege.
//
// The feature fails open. When the variable is unset, nothing happens. When it
// is set but the move is impossible (not Linux, a path outside /sys/fs/cgroup,
// a missing or unwritable leaf), the child keeps running in the server cgroup
// and the helper logs one warning per reason per process. The helper never
// throws. Kill, cancel and timeout paths do not depend on it: they signal the
// process group, and a cgroup move does not change the group.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const AGENT_CGROUP_ENV = "PAPERCLIP_AGENT_CGROUP";
export const CGROUP_FS_ROOT = "/sys/fs/cgroup";
export const AGENT_OOM_SCORE_ADJ = 500;

export interface MoveToAgentCgroupOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Root the configured path must live under. Tests point this at a temp dir. */
  cgroupRoot?: string;
  /** Directory that holds `<pid>/stat`, `<pid>/oom_score_adj` and `self/cgroup`. Tests point this at a temp dir. */
  procRoot?: string;
  /** The server's own pid. Tests override it. */
  selfPid?: number;
  warn?: (message: string) => void;
}

const warnedReasons = new Set<string>();

/** Test-only: allow the one-time warnings to fire again. */
export function resetAgentCgroupWarningForTests() {
  warnedReasons.clear();
}

function warnOnce(warn: (message: string) => void, reason: string, message: string) {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  try {
    warn(`[agent-cgroup] ${message}`);
  } catch {
    // A failing logger must not break the spawn path.
  }
}

function errorCode(err: unknown) {
  return (err as NodeJS.ErrnoException | null)?.code ?? (err instanceof Error ? err.message : String(err));
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
  const stay = "; agent processes stay in the server cgroup";

  const raw = env[AGENT_CGROUP_ENV]?.trim();
  if (!raw) return null;
  if (platform !== "linux") {
    warnOnce(warn, "platform", `${AGENT_CGROUP_ENV} is set but the platform is ${platform}, not linux${stay}`);
    return null;
  }
  if (!path.isAbsolute(raw)) {
    warnOnce(warn, "relative", `${AGENT_CGROUP_ENV} must be an absolute path, got "${raw}"${stay}`);
    return null;
  }
  const leaf = path.resolve(raw);
  if (!leaf.startsWith(`${cgroupRoot}${path.sep}`)) {
    warnOnce(warn, "outside", `${AGENT_CGROUP_ENV} must point under ${cgroupRoot}, got "${raw}"${stay}`);
    return null;
  }
  return path.join(leaf, "cgroup.procs");
}

const MAX_SWEEP_PASSES = 3;

function readParentPid(procRoot: string, pid: number): number | null {
  try {
    const stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // "pid (comm) state ppid ..."; comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function readCgroupPids(procsPath: string): number[] {
  try {
    return readFileSync(procsPath, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

/** The `cgroup.procs` file of the cgroup the server process runs in. */
function resolveOwnCgroupProcsPath(procRoot: string, cgroupRoot: string): string | null {
  try {
    const line = readFileSync(path.join(procRoot, "self", "cgroup"), "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (!line) return null;
    const own = path.resolve(cgroupRoot, `.${line.slice(3).trim()}`);
    if (own !== cgroupRoot && !own.startsWith(`${cgroupRoot}${path.sep}`)) return null;
    return path.join(own, "cgroup.procs");
  } catch {
    return null;
  }
}

/**
 * Moves the processes in the server cgroup that descend from `rootPid`.
 * Returns the moved pids.
 */
function sweepDescendants(
  rootPid: number,
  procsPath: string,
  procRoot: string,
  cgroupRoot: string,
  selfPid: number,
): number[] {
  const ownProcsPath = resolveOwnCgroupProcsPath(procRoot, cgroupRoot);
  if (!ownProcsPath || ownProcsPath === procsPath) return [];
  const moved: number[] = [];
  const seen = new Set<number>([selfPid, rootPid]);
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass += 1) {
    // A pid that already moved (or was rejected) is skipped, so a pass only counts new work.
    const candidates = readCgroupPids(ownProcsPath).filter((pid) => !seen.has(pid));
    if (candidates.length === 0) break;
    const parents = new Map<number, number | null>();
    const parentOf = (pid: number) => {
      if (!parents.has(pid)) parents.set(pid, readParentPid(procRoot, pid));
      return parents.get(pid) ?? null;
    };
    let movedThisPass = 0;
    for (const pid of candidates) {
      let cursor: number | null = parentOf(pid);
      let descends = false;
      for (let depth = 0; cursor !== null && cursor > 1 && depth < 64; depth += 1) {
        if (cursor === selfPid) break;
        if (cursor === rootPid) {
          descends = true;
          break;
        }
        cursor = parentOf(cursor);
      }
      if (!descends) continue;
      seen.add(pid);
      try {
        writeFileSync(procsPath, `${pid}\n`, { flag: "a" });
        moved.push(pid);
        movedThisPass += 1;
      } catch {
        // The process exited or cannot move; leave it where it is.
      }
    }
    if (movedThisPass === 0) break;
  }
  return moved;
}

function raiseOomScoreAdj(procRoot: string, pid: number, warn: (message: string) => void) {
  try {
    writeFileSync(path.join(procRoot, String(pid), "oom_score_adj"), `${AGENT_OOM_SCORE_ADJ}\n`);
  } catch (err) {
    const code = errorCode(err);
    if (code !== "ESRCH" && code !== "ENOENT") {
      warnOnce(warn, `oom:${code}`, `cannot raise oom_score_adj of agent processes (${code})`);
    }
  }
}

/**
 * Moves `pid` and its already forked descendants into the agent cgroup leaf
 * and raises their oom_score_adj. Returns true when the move succeeded and
 * false otherwise. Never throws.
 */
export function moveProcessToAgentCgroup(
  pid: number | null | undefined,
  options: MoveToAgentCgroupOptions = {},
): boolean {
  try {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    const warn = options.warn ?? ((message: string) => console.warn(message));
    const procsPath = resolveAgentCgroupProcsPath({ ...options, warn });
    if (!procsPath) return false;
    try {
      writeFileSync(procsPath, `${pid}\n`, { flag: "a" });
    } catch (err) {
      const code = errorCode(err);
      // ESRCH: the child already exited. That is a normal race, not a setup error.
      if (code === "ESRCH") return false;
      warnOnce(warn, `move:${code}`, `cannot write pid to ${procsPath} (${code}); agent processes stay in the server cgroup`);
      return false;
    }
    const procRoot = options.procRoot ?? "/proc";
    const cgroupRoot = path.resolve(options.cgroupRoot ?? CGROUP_FS_ROOT);
    raiseOomScoreAdj(procRoot, pid, warn);
    const selfPid = options.selfPid ?? process.pid;
    for (const descendant of sweepDescendants(pid, procsPath, procRoot, cgroupRoot, selfPid)) {
      raiseOomScoreAdj(procRoot, descendant, warn);
    }
    return true;
  } catch {
    return false;
  }
}

/** Returns a copy of `env` without the server-only agent cgroup variable. */
export function withoutAgentCgroupEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[AGENT_CGROUP_ENV];
  return copy;
}
// --- /RK9 Custom ---
