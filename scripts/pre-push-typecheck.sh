#!/usr/bin/env bash
# Fast local typecheck for .githooks/pre-push (RK9-393). CI keeps using `pnpm -r typecheck`.
#
# - Only packages changed against the base ref, plus their dependents.
# - At most 2 packages at once (native tsc peaks at 2-5 GB RSS each).
# - Skips the Rust runner build (build:binary) and typecheck:rust; CI covers those.
#   The runner TypeScript output (dist) is built once when it is missing.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BASE="${PREPUSH_TYPECHECK_BASE:-origin/master}"
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "pre-push: base '$BASE' not found; typechecking every package (slow)."
  FILTER=()
else
  FILTER=(--filter "...[$BASE]")
fi

RUNNER=@paperclipai/paperclip-runner
SERVER=@paperclipai/server
PNPM_R=(pnpm -r "${FILTER[@]}" --workspace-concurrency=2)

changed_pkgs="$("${PNPM_R[@]}" exec node -p 'require("./package.json").name' 2>/dev/null || true)"
if [ -z "$changed_pkgs" ]; then
  echo "pre-push: no package changed against $BASE; nothing to typecheck."
  exit 0
fi

if grep -qxE "$SERVER|$RUNNER|paperclipai" <<<"$changed_pkgs"; then
  if [ ! -f packages/paperclip-runner/dist/index.d.ts ]; then
    echo "pre-push: runner dist is missing; building the runner TypeScript once (no Rust)."
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
