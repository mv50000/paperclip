#!/usr/bin/env bash
# prod-untracked-check.sh — luokittelee /opt/paperclipin versioimattomat tiedostot ja varoittaa
# resetin vaaroista (RK9-307). Vain luku, paitsi --backup, joka kirjoittaa vain annettuun hakemistoon.
#
# Käyttö:
#   scripts/prod-untracked-check.sh [--repo /opt/paperclip] [--target <ref>] [--manifest <tiedosto>]
#                                   [--backup <hakemisto>]
#
#   --target    ref, johon reset aiotaan (esim. origin/master). Törmäys = versioimaton polku, joka on
#               kohteessa versioituna: reset --hard ylikirjoittaisi sen.
#   --backup    tallentaa hakemistoon (0700): local-changes.patch (versioidut paikalliset muutokset,
#               jotka reset --hard hävittäisi) ja untracked-preserved.tar (luokat preserve, secret,
#               runtime; tar 0600).
#
# Poistumiskoodi: 0 = kaikki luokiteltu, ei törmäyksiä eikä versioituja paikallisia muutoksia;
#                 1 = luokittelematon polku, törmäys tai versioitu paikallinen muutos; 2 = käyttövirhe.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=/opt/paperclip
TARGET=""
MANIFEST="$HERE/prod-untracked.manifest"
BACKUP=""
LOGTAG="[prod-untracked-check]"

die() { echo "$LOGTAG VIRHE: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;;
    --target) TARGET=${2:-}; shift 2 ;;
    --manifest) MANIFEST=${2:-}; shift 2 ;;
    --backup) BACKUP=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "tuntematon valitsin: $1" ;;
  esac
done
[ -f "$MANIFEST" ] || die "manifest puuttuu: $MANIFEST"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO ei ole luettavissa git-hakemistona (dubious ownership? ks. runbook)"

declare -a CLASS PATTERN
while IFS=$'\t' read -r cls pat _; do
  case "$cls" in ''|'#'*) continue ;; esac
  CLASS+=("$cls"); PATTERN+=("$pat")
done <"$MANIFEST"

class_of() { # <polku> -> luokka tai tyhjä
  local p=$1 i
  for i in "${!PATTERN[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$p" == ${PATTERN[$i]} ]]; then echo "${CLASS[$i]}"; return 0; fi
  done
  return 0
}

FAILS=0
mapfile -t UNTRACKED < <(git -C "$REPO" ls-files --others --exclude-standard --directory --no-empty-directory)
KEEP=()
for p in "${UNTRACKED[@]}"; do
  c=$(class_of "$p")
  if [ -z "$c" ]; then
    echo "$LOGTAG LUOKITTELEMATON: $p (lisää scripts/prod-untracked.manifest-tiedostoon)" >&2
    FAILS=$((FAILS + 1)); continue
  fi
  echo "$LOGTAG $c: $p"
  case "$c" in preserve|secret|runtime) KEEP+=("$p") ;; esac
done

if [ -n "$TARGET" ]; then
  git -C "$REPO" rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || die "--target $TARGET ei ratkea"
  for p in "${UNTRACKED[@]}"; do
    hit=$(git -C "$REPO" ls-tree -r --name-only "$TARGET" -- "$p" | head -n 1)
    if [ -n "$hit" ]; then
      echo "$LOGTAG TÖRMÄYS: $p on versioitu kohteessa $TARGET ($hit); reset --hard ylikirjoittaisi sen" >&2
      FAILS=$((FAILS + 1))
    fi
  done
fi

mapfile -t MODIFIED < <(git -C "$REPO" diff --name-only HEAD)
for p in "${MODIFIED[@]}"; do
  [ -n "$p" ] || continue
  if [ "$(class_of "$p")" = tolerated ]; then echo "$LOGTAG tolerated: $p"; continue; fi
  echo "$LOGTAG PAIKALLINEN MUUTOS: $p (git reset --hard hävittäisi tämän; vie muutos masteriin tai hylkää tietoisesti)" >&2
  FAILS=$((FAILS + 1))
done

if [ -n "$BACKUP" ]; then
  umask 077
  mkdir -p "$BACKUP"; chmod 700 "$BACKUP"
  git -C "$REPO" diff --binary HEAD >"$BACKUP/local-changes.patch"
  if [ "${#KEEP[@]}" -gt 0 ]; then
    tar -C "$REPO" -cf "$BACKUP/untracked-preserved.tar" -- "${KEEP[@]}"
  else
    head -c 10240 /dev/zero >"$BACKUP/untracked-preserved.tar"  # tyhjä tar (GNU tar ei luo tyhjää itse)
  fi
  chmod 600 "$BACKUP/local-changes.patch" "$BACKUP/untracked-preserved.tar"
  echo "$LOGTAG varmuuskopio: $BACKUP ($(stat -c %s "$BACKUP/local-changes.patch") tavua muutoksia, ${#KEEP[@]} polkua tarissa)"
fi

if [ "$FAILS" -gt 0 ]; then echo "$LOGTAG $FAILS ongelmaa; älä aja resettiä ennen kuin ne on ratkaistu" >&2; exit 1; fi
echo "$LOGTAG OK: ${#UNTRACKED[@]} versioimatonta polkua luokiteltu, ei törmäyksiä, ei versioituja paikallisia muutoksia"
