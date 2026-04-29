#!/usr/bin/env bash
# Yhdistetty viikoittainen E2E-companies smoke-ajo:
# 1. Aja Playwright kaikkia 4 yritystä vasten
# 2. Aja report-skripti (luo Paperclip-tiketit failureista)
# 3. Säilytä HTML-raportti aikaleimalla nginxin alle (LAN-only)
# 4. Pidä oma kirjaus persist-dirin alla (run.log)
#
# Ajetaan systemd-timerillä (paperclip-e2e-companies.timer).
# Voi ajaa myös käsin: bash scripts/e2e-companies-run.sh

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PERSIST_BASE="${E2E_COMPANIES_PERSIST_DIR:-/var/www/e2e-reports}"
PERSIST_DIR="${PERSIST_BASE}/${TIMESTAMP}"
LATEST_LINK="${PERSIST_BASE}/latest"

mkdir -p "$PERSIST_DIR"
LOG_FILE="${PERSIST_DIR}/run.log"

# Kahdenna stdout+stderr lokitiedostoon (näkyy myös systemd:n stdoutissa).
exec > >(tee -a "$LOG_FILE") 2>&1

cd "$REPO_ROOT"

echo "==> [$(date -u +%FT%TZ)] E2E-companies smoke-ajo alkaa (timestamp=$TIMESTAMP)"
echo "==> repo=$REPO_ROOT, persist=$PERSIST_DIR"

# 1. Playwright-ajo. Älä faila exit-koodiin tässä — report tarvitsee ajaa silti.
set +e
pnpm test:e2e:companies
PLAYWRIGHT_EXIT=$?
set -e
echo "==> Playwright exit code: $PLAYWRIGHT_EXIT"

# 2. Report-skripti — luo issuet per-yritys-tokeneilla (PAPERCLIP_API_KEY_<SLUG>).
# Skripti päättelee dry-runin tokenien puuttumisesta; ei tarvitse if/elseä.
pnpm e2e:companies:report || echo "WARNING: report-skripti epäonnistui"

# 3. Persistoi HTML-raportti ja test-results.
REPORT_SRC="$REPO_ROOT/tests/e2e-companies/playwright-report"
RESULTS_SRC="$REPO_ROOT/tests/e2e-companies/test-results"
if [ -d "$REPORT_SRC" ]; then
  cp -r "$REPORT_SRC" "$PERSIST_DIR/playwright-report"
fi
if [ -d "$RESULTS_SRC" ]; then
  cp -r "$RESULTS_SRC" "$PERSIST_DIR/test-results"
fi
ln -sfn "$PERSIST_DIR" "$LATEST_LINK"
echo "==> Raportit tallennettu: $PERSIST_DIR (latest -> $LATEST_LINK)"
echo "==> URL: https://paperclip.rk9.fi/e2e-reports/${TIMESTAMP}/playwright-report/ (LAN/Tailscale only)"

# 4. Exit-koodi: failataan jos testit failasivat (näkyy systemd-statusissa).
echo "==> Valmis. Playwright exit=$PLAYWRIGHT_EXIT"
exit "$PLAYWRIGHT_EXIT"
