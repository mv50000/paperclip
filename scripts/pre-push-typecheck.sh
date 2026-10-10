#!/usr/bin/env bash
# Fast local typecheck for .githooks/pre-push (RK9-393). CI keeps using `pnpm -r typecheck`.
#
# - Only packages changed against the base ref, plus their dependents.
# - At most 2 packages at once (native tsc peaks at 2-5 GB RSS each).
# - Skips the Rust runner build (build:binary) and typecheck:rust; CI covers those.
#   The runner TypeScript output (dist) is rebuilt whenever server is checked (else only when missing).
# - A changed root file (tsconfig.base.json, lockfile, package.json, patches/, scripts/) checks every package.
# - Optional offload: when `pcp-remote-verify.sh` is on PATH (RK9 hosts), the typecheck runs on the
#   remote worker. Its exit 3/90/91 (install failed, worker down, worker busy) and 137 (worker OOM: the
#   server typecheck does not fit in worker-01's 6 GB, RK9-473) fall back to a local run.
#   PREPUSH_TYPECHECK_REMOTE=0 disables the offload.
set -euo pipefail

RUNNER=@paperclipai/paperclip-runner
SERVER=@paperclipai/server

# Sets FILTER and changed_pkgs from git. Exits 0 when no package changed.
select_changed_packages() {
  cd "$(git rev-parse --show-toplevel)"

  BASE="${PREPUSH_TYPECHECK_BASE:-origin/master}"
  # Root files belong to no workspace package: pnpm's `[ref]` filter matches only the root project,
  # which `pnpm -r` skips. A change to one of them can affect every package, so typecheck everything.
  ROOT_RE='^(tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|patches/|scripts/)'
  FILTER=()
  if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
    echo "pre-push: base '$BASE' not found; typechecking every package (slow)."
  else
    # A failing git call must fail the hook (set -e), not skip the typecheck.
    merge_base="$(git merge-base "$BASE" HEAD)"
    changed_files="$(git diff --name-only "$merge_base")"
    if grep -qE "$ROOT_RE" <<<"$changed_files"; then
      echo "pre-push: a root file changed against $BASE; typechecking every package (slow)."
    else
      FILTER=(--filter "...[$BASE]")
    fi
  fi

  # No `2>/dev/null || true`: a listing failure (pnpm missing, git error) must fail the hook.
  # pnpm prints "No projects matched ..." to stdout with exit 0, so keep only package-name lines.
  listing="$(pnpm -r "${FILTER[@]}" exec node -p 'require("./package.json").name')"
  changed_pkgs="$(grep -E '^(@[a-z0-9._-]+/)?[a-z0-9._-]+$' <<<"$listing" || true)"
  if [ -z "$changed_pkgs" ]; then
    echo "pre-push: no package changed against $BASE; nothing to typecheck."
    exit 0
  fi
}

if [ -n "${PREPUSH_TYPECHECK_PKGS:-}" ]; then
  # Remote run: the caller selected the packages, because the remote copy has no usable .git.
  changed_pkgs="$(tr ' ' '\n' <<<"$PREPUSH_TYPECHECK_PKGS" | grep -v '^$' || true)"
  FILTER=()
  for pkg in $changed_pkgs; do FILTER+=(--filter "$pkg"); done
else
  select_changed_packages

  if [ "${PREPUSH_TYPECHECK_REMOTE:-1}" != 0 ] && command -v pcp-remote-verify.sh >/dev/null 2>&1; then
    echo "pre-push: typechecking on the remote worker (pcp-remote-verify.sh)..."
    set +e
    # A short lock wait: a busy worker must not hold the push for the default 30 min.
    PCP_REMOTE_LOCK_WAIT="${PCP_REMOTE_LOCK_WAIT:-120}" pcp-remote-verify.sh . -- \
      env PREPUSH_TYPECHECK_REMOTE=0 PREPUSH_TYPECHECK_PKGS="$(tr '\n' ' ' <<<"$changed_pkgs")" \
      bash scripts/pre-push-typecheck.sh
    rc=$?
    set -e
    case "$rc" in
      3|90|91) echo "pre-push: remote worker unavailable (exit $rc); typechecking locally." ;;
      137) echo "pre-push: remote worker ran out of memory (exit 137, RK9-473); typechecking locally." ;;
      *) exit "$rc" ;;
    esac
  fi
fi

PNPM_R=(pnpm -r "${FILTER[@]}" --workspace-concurrency=2)

if grep -qxE "$SERVER|$RUNNER|paperclipai" <<<"$changed_pkgs"; then
  # server typechecks against the runner's dist/index.d.ts, so a stale copy hides type errors.
  if grep -qx "$SERVER" <<<"$changed_pkgs" || [ ! -f packages/paperclip-runner/dist/index.d.ts ]; then
    echo "pre-push: building the runner TypeScript types (no Rust)."
    pnpm --filter "$RUNNER" build:typescript
  fi
  # server and cli import plugin-sdk/shared build output (lock-guarded, idempotent).
  pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
fi

echo "pre-push: typechecking changed packages (concurrency 2, Rust runner build skipped)..."
"${PNPM_R[@]}" --filter "!$SERVER" --filter "!$RUNNER" typecheck

if grep -qx "$RUNNER" <<<"$changed_pkgs"; then
  pnpm --filter "$RUNNER" typecheck:typescript
fi
if grep -qx "$SERVER" <<<"$changed_pkgs"; then
  pnpm --filter "$SERVER" exec tsc --noEmit
fi
