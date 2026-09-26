#!/usr/bin/env bash
# lib-repo-git.sh — kirjasto: aja git repon omistajana, ei kutsujana (RK9-307).
# Syy: /opt/paperclip on käyttäjän paperclip omistama, ja agentit kirjoittavat sen .git/config-tiedostoa.
# Repon konfiguraatio voi ajaa koodia (core.fsmonitor, diff.external, include.path, hookit). Operaattorin
# oma git-kutsu ("safe.directory") antaisi agentille koodinajon operaattorina, ja root-kutsu rootina.
# Operaattorin päätös 12.9.2026 (hosts/paperclip/README.md): rk9admin ei luota paperclip-omisteisiin
# repoihin. Siksi omistajan ollessa eri käyttäjä kutsu kulkee `sudo -n -u <omistaja> git`.
#
#   . scripts/lib-repo-git.sh
#   repo_git <repo> <git-argumentit...>
# REPO_GIT_AS=<käyttäjä> pakottaa käyttäjän (testit). Lisäksi jokaisessa kutsussa poistetaan käytöstä
# core.fsmonitor ja hookit.
repo_git() {
  local repo=$1; shift
  local owner=${REPO_GIT_AS:-$(stat -c %U "$repo" 2>/dev/null || true)}
  local -a pre=(git)
  if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then pre=(sudo -n -u "$owner" git); fi
  "${pre[@]}" -C "$repo" -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}
