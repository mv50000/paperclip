# Migraatiolukko ja `migrate:paperclip` (RK9-635, epic RK9-620)

Tila 2.11.2026: toteutettu. Pääasiakirja on claude-config-repossa (`docs/implementation-notes/coord-gate-migrate-host.md`): siellä ovat entrypoint-inventaario, lukkojärjestys ja moodien promootio. Tämä note kertoo vain Paperclip-repon osuuden.

## Mitä muuttui

- `applyPendingMigrations` (`packages/db/src/client.ts`) ottaa Postgresin advisory lockin ennen migraatioita (`packages/db/src/rk9-migration-lock.ts`). Avain on kiinteä (`0x726b396d6967`, "rk9mig"), yksi per tietokanta.
- Kaikki migraatiopolut kulkevat saman funktion kautta: palvelimen käynnistys (`server/src/index.ts`), dev-runnerin `pnpm db:migrate` restartissa sekä käsin ajettu `pnpm db:migrate` tai `tsx src/migrate.ts`.
- Lukko on session-tason lukko omalla yhden yhteyden clientillä (`max: 1`, ei idle- eikä lifetime-ajastinta). Lukitus, haltijan haku ja vapautus kulkevat saman backendin kautta. `finally` ajaa `pg_advisory_unlock`in ja sulkee yhteyden sekä onnistumisessa että virheessä.
- Ajantasainen skeema palaa ilman lukkoa. Käynnistys ei siksi odota, kun edellinen migraatio on jo valmis.

## Odotus ja restart

- Odotus on rajattu: `PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S` (oletus 120 s, enintään 3600 s). Aikakatkaisussa heitetään `Rk9MigrationLockTimeoutError`, eikä mitään migratoida. Virhe nimeää haltijan (pid, sovellus, aloitusaika).
- `paperclip.service` on `Restart=always`, `RestartSec=10`. Epäonnistunut käynnistys yrittää uudelleen enintään kerran per 130 s. Kun haltija on valmis, seuraava käynnistys näkee ajantasaisen skeeman ja menee läpi. Testi `rk9-migration-lock.test.ts` näyttää, että jokainen yritys odottaa aikakatkaisun verran eikä silmukka pyöri kuumana.
- Embedded PostgreSQL (DATABASE_URL puuttuu; vanha `pglite`-moodi ohjataan siihen `runtime-config.ts`:ssä) on oikea Postgres-palvelin paikallisessa portissa, joten erillinen lukkoyhteys toimii myös siinä.

## Coord-lease

`rk9 gate migrate:paperclip -- pnpm db:migrate` (claude-config) ottaa coord-leasen näkyvyyttä ja jonoa varten. Palvelin ei kysy coord-APIa omassa käynnistyksessään, koska API on palvelin itse (epic-sopimus: "Paperclip cannot gate itself"). Jos wrapperin enforce-odotus aikakatkeaa, ajo jatkuu ja advisory lock sarjallistaa sen ("gate timeout, serialized by db lock").

## Paperclip-prodin päivitysmenettely

1. Ota lease ennen palvelimen pysäytystä: `rk9 gate migrate:paperclip --reason "<syy>" -- <päivitys- ja restart-komento, joka odottaa, kunnes /api/health vastaa>`.
2. Uusi palvelin migratoi käynnistyksessä advisory lockin alla.
3. Lease vapautuu, kun wrapperin komento päättyy eli kun uusi palvelin vastaa.

Ajastettu `paperclip-update.sh` (root-cron) ei käytä coord-APIa. Sen migraatiot sarjallistaa sama advisory lock.
