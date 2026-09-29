# Pre-push typecheck (RK9-393)

`.githooks/pre-push` calls `scripts/pre-push-typecheck.sh` instead of `pnpm -r typecheck`.

- Scope: packages changed against `origin/master` plus their dependents (`--filter "...[origin/master]"`). Override the base with `PREPUSH_TYPECHECK_BASE`.
- `--workspace-concurrency=2`: native `tsc` peaks at 2-5 GB RSS per package.
- Server and runner skip the Rust work: no `prepare:runner-vendor` (`build:binary`, goldens) and no `typecheck:rust`. Server runs `tsc --noEmit` directly; runner runs `typecheck:typescript`.
- Fresh worktree: when `packages/paperclip-runner/dist/index.d.ts` is missing, the hook builds the runner TypeScript (`build:typescript`, no Rust) and runs plugin-sdk `ensure-build-deps`.
- Server in the checked set: the hook always rebuilds the runner TypeScript types first (`build:typescript`, no Rust), because server typechecks against `dist/index.d.ts` and a stale copy hides errors (RK9-394).
- Root files (`tsconfig*.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `patches/`, `scripts/`) belong to no package. pnpm's `[ref]` filter matches only the root project, which `pnpm -r` skips, so the hook checks every package when one of them changed against the merge-base.
- A listing or git error fails the hook (no `|| true`). pnpm prints "No projects matched" to stdout with exit 0, so the hook keeps only package-name lines before deciding "nothing to typecheck".
- Remote offload: when `pcp-remote-verify.sh` is on PATH (RK9 hosts; it lives in the operator's `~/.claude/bin`, not in this repo), the hook selects the packages locally with git and runs the typecheck on the remote worker. The remote copy has no usable `.git` (a worktree's `.git` is a pointer file), so the package names travel in `PREPUSH_TYPECHECK_PKGS` and the remote side filters by exact name. A type error on the worker fails the push. Exit 3, 90 or 91 (install failed, worker down, worker busy) falls back to the local run. The lock wait is 120 s (`PCP_REMOTE_LOCK_WAIT`), so a busy worker does not hold the push for the script's default 30 min. `PREPUSH_TYPECHECK_REMOTE=0` disables the offload.
- Test: `node --test scripts/pre-push-typecheck.test.mjs` (stubbed `git`, `pnpm` and `pcp-remote-verify.sh` on PATH; the offload is off unless a test stubs it, because the host PATH may hold the real script).
- CI is unchanged. It still runs the full `pnpm -r typecheck`, including the Rust runner build and `cargo check`.

Measured on paperclip-01 (load ~24, 4 cores), change in `cli/` only: cold worktree 4 min 42 s (includes the one-time runner TS and plugin-sdk builds), warm 2 min 58 s. The old hook took about 7 min or more for the same push.

Measured 29.9. with the offload, root-file change (every package checked): 64 s on worker-01, including rsync (3 s) and a fresh `pnpm install` (8 s). A second run with an injected type error failed the hook with exit 1.
