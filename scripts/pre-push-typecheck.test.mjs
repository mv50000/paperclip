import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-push-typecheck.sh");

// Stub `git` and `pnpm` on PATH. Behaviour is driven by FAKE_* env vars; pnpm calls go to $CALLS.
const GIT_STUB = `#!/usr/bin/env bash
case "$1" in
  rev-parse) if [ "$2" = "--show-toplevel" ]; then echo "$FAKE_ROOT"; fi; exit 0 ;;
  merge-base) echo abc123; exit 0 ;;
  diff) if [ -n "\${FAKE_GIT_DIFF_FAIL:-}" ]; then echo "fatal: bad revision" >&2; exit 128; fi
        printf '%s' "$FAKE_DIFF"; exit 0 ;;
esac
exit 0
`;
const PNPM_STUB = `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
if [[ " $* " == *" exec node -p "* ]]; then
  if [ -n "\${FAKE_LIST_FAIL:-}" ]; then echo "pnpm: list failed" >&2; exit 1; fi
  printf '%s' "$FAKE_PKGS"
fi
exit 0
`;

// Stands in for the RK9 host script; records its arguments and exits with $FAKE_REMOTE_RC.
const REMOTE_STUB = `#!/usr/bin/env bash
echo "REMOTE PCP_REMOTE_LOCK_WAIT=$PCP_REMOTE_LOCK_WAIT $*" >> "$CALLS"
exit "\${FAKE_REMOTE_RC:-0}"
`;

// `remote`: undefined disables the offload (the host PATH may hold the real pcp-remote-verify.sh);
// a number stubs pcp-remote-verify.sh with that exit code.
function run({ diff = "", pkgs = "", listFail = false, gitDiffFail = false, distExists = true, remote, env = {} }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prepush-"));
  try {
    const bin = path.join(dir, "bin");
    const root = path.join(dir, "repo");
    const calls = path.join(dir, "calls.log");
    spawnSync("mkdir", ["-p", bin, path.join(root, "packages/paperclip-runner/dist")]);
    if (distExists) writeFileSync(path.join(root, "packages/paperclip-runner/dist/index.d.ts"), "");
    const stubs = [["git", GIT_STUB], ["pnpm", PNPM_STUB]];
    if (remote !== undefined) stubs.push(["pcp-remote-verify.sh", REMOTE_STUB]);
    for (const [name, body] of stubs) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(calls, "");
    const res = spawnSync("bash", [script], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...(remote === undefined ? { PREPUSH_TYPECHECK_REMOTE: "0" } : { FAKE_REMOTE_RC: String(remote) }),
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_ROOT: root,
        FAKE_DIFF: diff,
        FAKE_PKGS: pkgs,
        CALLS: calls,
        ...(listFail ? { FAKE_LIST_FAIL: "1" } : {}),
        ...(gitDiffFail ? { FAKE_GIT_DIFF_FAIL: "1" } : {}),
      },
    });
    return { ...res, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("root-only change runs the full typecheck without a ref filter", () => {
  for (const file of ["tsconfig.base.json", "pnpm-lock.yaml", "package.json", "patches/x.patch", "scripts/foo.sh"]) {
    const res = run({ diff: `${file}\n`, pkgs: "@paperclipai/shared\n@paperclipai/server\n" });
    assert.equal(res.status, 0, `${file}: ${res.stderr}`);
    assert.match(res.stdout, /root file changed/);
    assert.doesNotMatch(res.calls, /--filter \.\.\.\[/, file);
    assert.match(res.calls, /typecheck/, file);
  }
});

test("package-only change keeps the ref filter", () => {
  const res = run({ diff: "cli/src/a.ts\n", pkgs: "paperclipai\n" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.calls, /--filter \.\.\.\[origin\/master\]/);
});

test("listing error exits non-zero and typechecks nothing", () => {
  const res = run({ diff: "cli/src/a.ts\n", listFail: true });
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.calls, /typecheck/);
});

test("git diff error exits non-zero", () => {
  const res = run({ gitDiffFail: true });
  assert.notEqual(res.status, 0);
});

test("'No projects matched' output is treated as nothing to typecheck", () => {
  const res = run({ diff: "doc/a.md\n", pkgs: "No projects matched the filters in \"/x\"\n" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /nothing to typecheck/);
  assert.doesNotMatch(res.calls, /typecheck/);
});

test("server in the set rebuilds runner TS types even when dist exists", () => {
  const res = run({ diff: "server/src/a.ts\n", pkgs: "@paperclipai/server\n", distExists: true });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.calls, /--filter @paperclipai\/paperclip-runner build:typescript/);
});

test("cli-only change does not rebuild runner types when dist exists", () => {
  const res = run({ diff: "cli/src/a.ts\n", pkgs: "paperclipai\n", distExists: true });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.calls, /build:typescript/);
});

test("remote worker success skips the local typecheck", () => {
  const res = run({ diff: "cli/src/a.ts\n", pkgs: "paperclipai\n@paperclipai/shared\n", remote: 0 });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.calls, /^REMOTE PCP_REMOTE_LOCK_WAIT=120 \. -- env PREPUSH_TYPECHECK_REMOTE=0 PREPUSH_TYPECHECK_PKGS=paperclipai @paperclipai\/shared  bash scripts\/pre-push-typecheck\.sh$/m);
  assert.doesNotMatch(res.calls, /typecheck$/m);
});

test("remote type errors fail the hook without a local rerun", () => {
  const res = run({ diff: "cli/src/a.ts\n", pkgs: "paperclipai\n", remote: 2 });
  assert.equal(res.status, 2);
  assert.doesNotMatch(res.calls, /^-r .* typecheck$/m);
});

test("worker down, busy, out of memory or failed install falls back to the local typecheck", () => {
  for (const rc of [3, 90, 91, 137]) {
    const res = run({ diff: "cli/src/a.ts\n", pkgs: "paperclipai\n", remote: rc });
    assert.equal(res.status, 0, `${rc}: ${res.stderr}`);
    assert.match(res.stdout, /typechecking locally/, String(rc));
    assert.match(res.calls, /--filter \.\.\.\[origin\/master\] --workspace-concurrency=2 --filter !@paperclipai\/server --filter !@paperclipai\/paperclip-runner typecheck/, String(rc));
  }
});

test("nothing changed skips the remote call", () => {
  const res = run({ diff: "doc/a.md\n", pkgs: "No projects matched the filters in \"/x\"\n", remote: 0 });
  assert.equal(res.status, 0);
  assert.doesNotMatch(res.calls, /REMOTE/);
});

test("remote side typechecks the given packages without git", () => {
  const res = run({
    gitDiffFail: true,
    env: { PREPUSH_TYPECHECK_PKGS: "paperclipai @paperclipai/server " },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.calls, /exec node -p/);
  assert.match(res.calls, /^-r --filter paperclipai --filter @paperclipai\/server --workspace-concurrency=2 --filter !@paperclipai\/server --filter !@paperclipai\/paperclip-runner typecheck$/m);
  assert.match(res.calls, /--filter @paperclipai\/server exec tsc --noEmit/);
});
