import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_SEC = 120;

/**
 * Safety-net sweep for orphaned `qmd vsearch`/`search` worker processes (RK9-181).
 *
 * knowledge-recall.ts kills its own tracked qmd process GROUP on timeout or client
 * disconnect (see killProcessGroup there), so under normal operation this watchdog should
 * find nothing. It exists for gaps outside that path — a qmd invocation started some other
 * way (manual debugging, a future caller of the CLI), or an unanticipated regression in the
 * primary kill logic — rather than as the primary mechanism. Mirrors the pull-based sweep
 * pattern of startAgentLivenessWatchdog (services/slack/liveness-watchdog.ts).
 */

export interface QmdProcessInfo {
  pid: number;
  etimeSec: number;
  command: string;
}

/** Parse `ps -eo pid,etimes,args` rows into structured process info. */
export function parsePsRows(stdout: string): QmdProcessInfo[] {
  const rows: QmdProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), etimeSec: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** A qmd vsearch/search worker (the grandchild the qmd launcher spawns — see
 *  knowledge-recall.ts's killProcessGroup doc) that has outlived the stale threshold. */
export function isStaleQmdWorker(proc: QmdProcessInfo, staleSec: number): boolean {
  return proc.etimeSec > staleSec && /qmd(\.js)?\s+(vsearch|search)\b/.test(proc.command);
}

export interface QmdWatchdogDeps {
  listProcesses?: () => Promise<string>;
  killProcess?: (pid: number) => void;
}

const defaultListProcesses = async (): Promise<string> => {
  const { stdout } = await execFile("ps", ["-eo", "pid,etimes,args"]);
  return stdout;
};

/** Single-pid SIGKILL, not a process-group kill: the orphan is a leaf process by the time it's
 *  stale (its own launcher parent already died, which is how it became an orphan). */
const defaultKillProcess = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== "ESRCH") logger.warn({ err: error, pid }, "qmd orphan watchdog: failed to kill stale process");
  }
};

export interface QmdOrphanWatchdogHandle {
  stop(): void;
  /** Run one sweep now (used by tests and on startup). */
  runNow(): Promise<void>;
}

export function startQmdOrphanWatchdog(
  opts: { intervalMs?: number; staleSec?: number; deps?: QmdWatchdogDeps } = {},
): QmdOrphanWatchdogHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleSec = opts.staleSec ?? DEFAULT_STALE_SEC;
  const listProcesses = opts.deps?.listProcesses ?? defaultListProcesses;
  const killProcess = opts.deps?.killProcess ?? defaultKillProcess;
  let inFlight = false;

  async function tick(): Promise<void> {
    const stdout = await listProcesses();
    const stale = parsePsRows(stdout).filter((p) => isStaleQmdWorker(p, staleSec));
    for (const proc of stale) {
      logger.warn(
        { pid: proc.pid, etimeSec: proc.etimeSec, command: proc.command },
        "qmd orphan watchdog: killing stale qmd worker",
      );
      killProcess(proc.pid);
    }
  }

  async function safeTick(): Promise<void> {
    if (inFlight) return; // guard against overlapping ticks (mirrors riskMonitorInFlight)
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      logger.error({ err: error }, "qmd orphan watchdog tick failed");
    } finally {
      inFlight = false;
    }
  }

  const interval = setInterval(() => void safeTick(), intervalMs);
  // Don't keep the process alive just for this timer.
  if (typeof interval.unref === "function") interval.unref();

  logger.info({ intervalMs, staleSec }, "qmd orphan watchdog started");

  return { stop: () => clearInterval(interval), runNow: tick };
}
