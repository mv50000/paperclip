import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

import {
  carriesMarker,
  REAPER_MARKER_ENV_KEY,
  REAPER_MARKER_PROVIDE_KEY,
  sweepProcessesSync,
  type ProcCandidate,
} from "./proc-sweep.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run marker; the key equals `REAPER_MARKER_PROVIDE_KEY`. */
    pcpTestReaperMarker: string;
  }
}

/**
 * The path prefixes that name a test temp root: every root the reaper tests
 * create is `<tmpdir>/paperclip-*` (for example `paperclip-process-session-*`
 * and `paperclip-vitest-*`). Both the configured and the resolved tmpdir count,
 * because a process's cwd link is always the resolved path.
 */
export function testTempRootPrefixes(tmpdir: string = os.tmpdir()): string[] {
  const prefixes = new Set([path.join(tmpdir, "paperclip-")]);
  try {
    prefixes.add(path.join(realpathSync(tmpdir), "paperclip-"));
  } catch {
    // The tmpdir is gone; the configured path is all there is.
  }
  return [...prefixes];
}

function mentionsPrefix(candidate: ProcCandidate, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) =>
      candidate.cmdline.includes(prefix) || candidate.environ.includes(prefix) || candidate.cwd.startsWith(prefix),
  );
}

/**
 * Kill every process that carries this run's marker AND names a test temp
 * root in its command line, environment or working directory. The marker is a
 * fresh UUID per run, so a test run in another worktree, or anything else of
 * the same user, is never hit.
 */
export function sweepMarkedTestOrphans(marker: string, prefixes: readonly string[] = testTempRootPrefixes()): number[] {
  if (!marker || prefixes.length === 0) return [];
  return sweepProcessesSync((candidate) => carriesMarker(candidate, marker) && mentionsPrefix(candidate, prefixes));
}

/**
 * Vitest globalSetup for `@paperclipai/adapter-utils` (RK9-462).
 *
 * The reaper's `process.once("exit")` hook in a test worker does not run when
 * the worker is killed by a signal, so a wrapper, bridge server or runtime
 * service that the worker started stays behind. This setup runs in the vitest
 * main process: it creates the run marker before the pool starts, so each
 * worker inherits it through `process.env` (and can read it back through
 * `inject`), and its teardown sweeps /proc by that marker. The teardown cannot
 * see a worker's seen roots, so it matches by the temp-root path prefix instead.
 * No signal handler is added to the worker: that would change how it ends.
 */
export default function setup(project: TestProject): () => void {
  // Always a fresh value: a vitest started from inside a test must not sweep
  // the processes of the run that started it.
  const marker = randomUUID();
  process.env[REAPER_MARKER_ENV_KEY] = marker;
  project.provide(REAPER_MARKER_PROVIDE_KEY, marker);
  return () => {
    sweepMarkedTestOrphans(marker);
  };
}
