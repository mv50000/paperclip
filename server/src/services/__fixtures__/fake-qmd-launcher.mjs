// Test fixture for knowledge-recall.test.ts (RK9-181).
//
// Mimics the ONE property of @tobilu/qmd's real `bin/qmd` launcher that matters for the
// process-group-kill fix: it `spawn()`s the actual worker as its OWN child instead of
// `exec`ing into it, so the worker survives if only the launcher (this process) is killed.
// The worker here also ignores SIGTERM (like a real vsearch mid-inference can appear to,
// from the parent's point of view, until the model call returns) so the test can prove that
// only a process-GROUP signal reaches it.
//
// Usage: node fake-qmd-launcher.mjs <outFile>
// Writes { launcherPid, workerPid } to outFile once the worker is up.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const outFile = process.argv[2];

const worker = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { stdio: "ignore" },
);

writeFileSync(outFile, JSON.stringify({ launcherPid: process.pid, workerPid: worker.pid }));

// Real launcher relays the worker's exit to its own exit code; irrelevant here since a
// process-group kill signals both directly.
worker.on("exit", () => process.exit(0));
