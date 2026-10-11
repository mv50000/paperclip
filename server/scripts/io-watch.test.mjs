import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "io-watch.sh");
const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// Runs io-watch.sh against a fake `iostat` that replays `awaits` (one w_await per
// sample; "" = no data) and a fake `pnpm` that records every Slack message.
function runIoWatch(awaits, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "io-watch-test-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(dir, "awaits"), awaits.join("\n") + "\n");
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(
    join(bin, "iostat"),
    `#!/bin/bash
n=$(( $(cat "${dir}/count") + 1 )); echo "$n" >"${dir}/count"
w=$(sed -n "\${n}p" "${dir}/awaits")
[ -z "$w" ] && exit 0
echo "Device r/s rkB/s rrqm/s %rrqm r_await rareq-sz w/s wkB/s wrqm/s %wrqm w_await wareq-sz d/s dkB/s drqm/s %drqm d_await dareq-sz f/s f_await aqu-sz %util"
echo "nvme0n1 1 1 0 0 1.00 1 1 1 0 0 $w 1 0 0 0 0 0 0 0 0 0.10 5.00"
`,
  );
  writeFileSync(join(bin, "pnpm"), `#!/bin/bash\nprintf '%s\\n' "$3" >>"${dir}/slack"\n`);
  chmodSync(join(bin, "iostat"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
  const log = join(dir, "io-watch.log");
  const result = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      IO_WATCH_LOG: log,
      PAPERCLIP_SERVER_DIR: dir,
      IO_WATCH_SAMPLE: "0",
      IO_WATCH_WARN_CONSEC: "2",
      IO_WATCH_OK_CONSEC: "2",
      IO_WATCH_HEARTBEAT: "99999",
      IO_WATCH_MAX_SAMPLES: String(awaits.length),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status).toBe(0);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const slackPath = join(dir, "slack");
  const slack = existsSync(slackPath) ? readFileSync(slackPath, "utf8").trim().split("\n") : [];
  return { lines, slack };
}

describe("io-watch.sh logging", () => {
  it("writes only the start line for healthy samples inside the heartbeat window", () => {
    const { lines, slack } = runIoWatch(["0.3", "0.4", "0.2", "0.3"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^# io-watch alkoi /);
    expect(slack).toEqual([]);
  });

  it("writes a heartbeat line per elapsed window while healthy", () => {
    const { lines } = runIoWatch(["0.3", "0.4", "0.2"], { IO_WATCH_HEARTBEAT: "0" });
    const beats = lines.filter((l) => l.endsWith("[heartbeat]"));
    expect(beats).toHaveLength(3);
    expect(beats[0]).toMatch(/r_await=1\.00ms w_await=0\.3ms aqu=0\.10 util=5\.00%/);
  });

  it("keeps full detail and posts to Slack across a pressure episode", () => {
    // 2 healthy (silent), 1 blip, 3 pressure (WARN after 2), 2 healthy (recovery).
    const { lines, slack } = runIoWatch(["1", "1", "500", "500", "500", "1", "1"]);
    expect(lines.filter((l) => l.includes("<<< paine (1/2"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("<<< WARN (vahvistettu)"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("<<< WARN (jatkuu)"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("<<< toipuu (1/2)"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("<<< OK (palautui)"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("-> SLACK"))).toHaveLength(2);
    // header + 5 flagged samples + 2 SLACK lines; the 2 leading healthy samples stay silent.
    expect(lines).toHaveLength(8);
    expect(slack).toHaveLength(2);
    expect(slack[0]).toContain("levy-IO-paine");
    expect(slack[1]).toContain("palautui normaaliksi");
  });

  it("logs a missing-iostat outage once, not once per sample", () => {
    const { lines } = runIoWatch(["", "", ""]);
    expect(lines.filter((l) => l.includes("(ei iostat-dataa)"))).toHaveLength(1);
  });
});
