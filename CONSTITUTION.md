# CONSTITUTION — mv50000/paperclip (RK9)

Pakolliset repo-säännöt agenteille ja worktree-executoreille. Rikkomukset ovat
aiheuttaneet reworkia. Lue ennen koodausta; tämä täydentää issue-kuvausta.
Distillattu RK9-vaultista 2026-08-14 (RK9-107).

## Merge-portit
- PR-checkien vihreys on AINOA merge-gate: GitHub Free ei tue branch
  protectionia privaattirepoissa. Älä mergeä punaisella.
- Gitleaks secret-scan on pr-checkien SISÄLLÄ — älä poista tai ohita sitä.
- Herkkä diffi (auth/secretit/SQL/maksut/migraatiot): avaa PR DRAFTINA ja
  pidä draftina kunnes itsenäinen verifier on puhdas.

## CI ja koneet
- EI buildeja GitHub-hosted-runnereille — vain builder/builder-fast.
- EI CI-buildeja paperclip-01-hostille (RAM-overcommit). Cargo/raskaat
  buildit: jobs cap 2.

## Tuotanto tällä koneella
- Prod (paperclip.rk9.fi) ajaa TÄSTÄ työhakemistosta systemd-palveluna.
  Server-muutos näkyy vasta: `sudo systemctl restart paperclip.service`.
  Logit: `sudo tail -f /var/log/paperclip.log`.
- DB on jaettu dev/prod: `psql -h 127.0.0.1 -U paperclip -d paperclip`.
  Destruktiivinen migraatio VAIN tuoreen `pnpm db:backup`in jälkeen.

## Koodikäytännöt
- pnpm-monorepo. Ennen PR:ää: `pnpm typecheck` ja `pnpm test`
  (= preflight + vitest-stable). E2E vain tarvittaessa: `pnpm test:e2e`.
- API-reitit validoidaan zod-skeemoilla `packages/shared/src/validators/` +
  `validate()`-middleware — uusi reitti ilman validointia ei kelpaa.
- Issue-luonti on company-scoped: `POST /companies/:companyId/issues`
  (EI `POST /api/issues`).

## Worktreet
- Worktree-kloonit: `/tmp/paperclip-worktrees/<PREFIX>/<nimi>/`. Yksi
  kirjoittaja per worktree — älä spawnaa rinnakkaisia file-writing-agentteja.
- Playwright: yksi selain per worktree (SingletonLock-lukko estää toisen).
