#!/usr/bin/env bash
# Fast local typecheck for .githooks/pre-push (RK9-393). CI keeps using `pnpm -r typecheck`.
#
# - Only packages changed against the base ref, plus their dependents.
# - At most 2 packages at once (native tsc peaks at 2-5 GB RSS each).
# - Skips the Rust runner build (build:binary) and typecheck:rust; CI covers those.
#   The runner TypeScript output (dist) is rebuilt whenever server is checked (else only when missing).
# - A changed root file (tsconfig.base.json, lockfile, package.json, patches/, scripts/) checks every package.
set -euo pipefail

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

RUNNER=@paperclipai/paperclip-runner
SERVER=@paperclipai/server
PNPM_R=(pnpm -r "${FILTER[@]}" --workspace-concurrency=2)

# No `2>/dev/null || true`: a listing failure (pnpm missing, git error) must fail the hook.
# pnpm prints "No projects matched ..." to stdout with exit 0, so keep only package-name lines.
listing="$("${PNPM_R[@]}" exec node -p 'require("./package.json").name')"
changed_pkgs="$(grep -E '^(@[a-z0-9._-]+/)?[a-z0-9._-]+$' <<<"$listing" || true)"
if [ -z "$changed_pkgs" ]; then
  echo "pre-push: no package changed against $BASE; nothing to typecheck."
  exit 0
fi

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
