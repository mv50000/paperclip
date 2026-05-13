# E2E-smoke docker.rk9.fi-yrityksille

Viikoittainen selainpohjainen smoke-testaus 5 yritykselle: ololla, alli-audit, quantimodo, saatavilla, sunspot.

## Mitä tämä on

CI-putki rakentaa ja deployaa, mutta selaimen kautta tapahtuvat regressiot (UI rikki, login ei aukea, dashboard valkoinen) menevät läpi ilman että kukaan huomaa. Tämä suite ajaa Playwrightilla minimismoken kaikkia 4 yritystä vasten viikoittain ja luo Paperclip-tiketin failureista.

## Ajaminen

```bash
# Kaikki yritykset
pnpm test:e2e:companies

# Yksittäinen yritys
pnpm test:e2e:companies --project=ololla
pnpm test:e2e:companies --project=alli-audit
pnpm test:e2e:companies --project=quantimodo
pnpm test:e2e:companies --project=saatavilla
pnpm test:e2e:companies --project=sunspot

# Headed-moodi (näkee selaimen, debug)
pnpm test:e2e:companies:headed
```

## Yritykset

| Project | Dev-URL | Owner agent |
|---------|---------|-------------|
| ololla | https://ololla-dev.rk9.fi | ololla-tech-lead |
| alli-audit | https://alli-audit-dev.rk9.fi | alli-audit-tech-lead |
| quantimodo | https://quantimodo-dev.rk9.fi | quantimodo-tech-lead |
| saatavilla | https://saatavilla-dev.rk9.fi | saatavilla-tech-lead |
| sunspot | https://sunspot-dev.rk9.fi | sunspot-tech-lead |

URL- tai owner-muutokset: päivitä `fixtures/companies.ts`.

## Testikattavuus (alkuvaihe)

Per yritys minimismoke:
- Etusivu vastaa (HTTP 2xx tai 3xx, ei 4xx/5xx)
- HTML renderöityy (`<html>` ja `<title>` löytyvät)
- Ei kriittisiä console-erroreita ladattaessa
- (Jos auth-redirect) /login-sivu latautuu ja sisältää lomakkeen

Happy-pathit (booking-flow, audit-luonti, dashboard, lasku-flow) lisätään myöhemmin yritysten Tech Lead -agenttien kanssa, kun smoke vakaa.

## Failure → Paperclip-tiketti

`scripts/e2e-companies-report.ts` lukee `test-results/junit.xml`:n ja:
- Onnistunut ajo: lyhyt Slack-yhteenveto
- Failure: Paperclip-tiketti yritykselle (`high` prio, owner agent assignee, tag `e2e-failure`)
- 2 perättäistä failuria → Risk Management -insidentti

## Ajoitus

Routines-rutiini `e2e-companies-weekly`: cron `0 5 * * 1` (maanantai 05:00). Manuaalinen trigger Paperclip API:lla.

## Raportit

HTML-raportti: `playwright-report/index.html`. Tuotantoajot kopioidaan `https://nginx.rk9.fi/e2e-reports/<timestamp>/` jotta agentit voivat linkittää tiketteihin.
