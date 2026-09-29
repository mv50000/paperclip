# Pre-push typecheck (RK9-393)

`.githooks/pre-push` calls `scripts/pre-push-typecheck.sh` instead of `pnpm -r typecheck`.

- Scope: packages changed against `origin/master` plus their dependents (`--filter "...[origin/master]"`). Override the base with `PREPUSH_TYPECHECK_BASE`.
- `--workspace-concurrency=2`: native `tsc` peaks at 2-5 GB RSS per package.
- Server and runner skip the Rust work: no `prepare:runner-vendor` (`build:binary`, goldens) and no `typecheck:rust`. Server runs `tsc --noEmit` directly; runner runs `typecheck:typescript`.
- Fresh worktree: when `packages/paperclip-runner/dist/index.d.ts` is missing, the hook builds the runner TypeScript once (`build:typescript`, no Rust) and runs plugin-sdk `ensure-build-deps`.
- CI is unchanged. It still runs the full `pnpm -r typecheck`, including the Rust runner build and `cargo check`.

Measured on paperclip-01 (load ~24, 4 cores), change in `cli/` only: cold worktree 4 min 42 s (includes the one-time runner TS and plugin-sdk builds), warm 2 min 58 s. The old hook took about 7 min or more for the same push.
