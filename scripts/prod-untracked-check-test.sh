#!/usr/bin/env bash
# Testi scripts/prod-untracked-check.sh:lle (RK9-307). Git-fixture, ei kosketa /opt/paperclipiin.
# Kattaa: luokiteltu -> exit 0; luokittelematon polku -> exit 1; törmäys kohde-refin kanssa ->
# exit 1; versioitu paikallinen muutos -> exit 1, tolerated-tiedosto ei; --backup tallentaa
# patchin ja tarin (0600) ilman generated-polkuja; `git fetch`-tyylinen reset --hard jättää
# versioimattomat tiedostot paikoilleen (kuivaharjoitus: sama polku kuin runbookin vaihe 4).
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUT="$HERE/prod-untracked-check.sh"
TMP=$(mktemp -d /tmp/rk9-307-untr.XXXXXX); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1: '$3' puuttuu: $(printf '%s' "$2" | head -c 500)"; fi }
G() { git -C "$R" -c user.name=t -c user.email=t@t "$@"; }

R="$TMP/repo"; git init -q "$R"; G branch -M master
mkdir -p "$R/.claude" "$R/server" "$R/ui"; echo u >"$R/ui/app.ts"
echo base >"$R/keep.txt"; echo lock >"$R/.claude/scheduled_tasks.lock"; echo v1 >"$R/server/a.sh"
G add -A; G commit -q -m base
# kohde-ref: lisää tiedoston, jonka nimellä prodissa on versioimaton tiedosto
echo new >"$R/wh.psd1.template"; G add wh.psd1.template; G commit -q -m target; G branch target
G reset -q --hard HEAD~1

mkdir -p "$R/voice-gateway" "$R/ui/dist" "$R/data"
echo vg >"$R/voice-gateway/v.mjs"; echo secret >"$R/decrypt-secret.cjs"; echo x >"$R/ui/dist/i.js"; echo d >"$R/data/d"
echo img >"$R/qua-x.png"

echo "== luokiteltu, ei törmäystä"
OUT=$("$SUT" --repo "$R" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "exit 0" || bad "exit $RC: $OUT"
has "voice-gateway preserve" "$OUT" "preserve: voice-gateway/"
has "decrypt-secret secret" "$OUT" "secret: decrypt-secret.cjs"

echo "== luokittelematon"
echo z >"$R/mystery.txt"
OUT=$("$SUT" --repo "$R" 2>&1); RC=$?
[ "$RC" = 1 ] && ok "exit 1" || bad "exit $RC"
has "LUOKITTELEMATON" "$OUT" "LUOKITTELEMATON: mystery.txt"
rm "$R/mystery.txt"

echo "== törmäys kohteen kanssa"
echo local >"$R/wh.psd1.template"
OUT=$("$SUT" --repo "$R" --target target 2>&1); RC=$?
[ "$RC" = 1 ] && ok "exit 1" || bad "exit $RC"
has "TÖRMÄYS" "$OUT" "TÖRMÄYS: wh.psd1.template"
OUT=$("$SUT" --repo "$R" --target master 2>&1); RC=$?
[ "$RC" = 0 ] && ok "ei törmäystä master-refiä vasten" || bad "exit $RC: $OUT"

echo "== versioitu paikallinen muutos"
echo v2 >"$R/server/a.sh"; echo lock2 >"$R/.claude/scheduled_tasks.lock"
OUT=$("$SUT" --repo "$R" 2>&1); RC=$?
[ "$RC" = 1 ] && ok "exit 1" || bad "exit $RC"
has "muutos raportoitu" "$OUT" "PAIKALLINEN MUUTOS: server/a.sh"
has "tolerated ohitettu" "$OUT" "tolerated: .claude/scheduled_tasks.lock"
case "$OUT" in *"PAIKALLINEN MUUTOS: .claude"*) bad "tolerated ei saa olla löydös" ;; *) ok "tolerated ei ole löydös" ;; esac

echo "== varmuuskopio"
B="$TMP/bk"
"$SUT" --repo "$R" --backup "$B" >/dev/null 2>&1
has "patch sisältää muutoksen" "$(cat "$B/local-changes.patch")" "+v2"
TARL=$(tar -tf "$B/untracked-preserved.tar")
has "tarissa voice-gateway" "$TARL" "voice-gateway/v.mjs"
has "tarissa decrypt-secret" "$TARL" "decrypt-secret.cjs"
has "tarissa data" "$TARL" "data/d"
case "$TARL" in *ui/dist*|*qua-x.png*) bad "generated/artifact ei kuulu tariin" ;; *) ok "generated ja artifact pois tarista" ;; esac
[ "$(stat -c %a "$B/untracked-preserved.tar")" = 600 ] && [ "$(stat -c %a "$B")" = 700 ] && ok "oikeudet 700/600" || bad "oikeudet"

echo "== reset --hard -kuivaharjoitus: versioimattomat säilyvät, versioitu muutos häviää"
rm "$R/wh.psd1.template"
G reset -q --hard master
[ -f "$R/voice-gateway/v.mjs" ] && [ -f "$R/decrypt-secret.cjs" ] && [ -f "$R/data/d" ] && [ -f "$R/qua-x.png" ] && ok "versioimattomat tiedostot paikoillaan" || bad "reset poisti versioimattoman tiedoston"
[ "$(cat "$R/server/a.sh")" = v1 ] && ok "versioitu muutos hävisi (siksi --backup ja PAIKALLINEN MUUTOS -varoitus)" || bad "muutos säilyi"

echo "yhteensä: $PASS ok, $FAIL virhettä"
[ "$FAIL" = 0 ]
