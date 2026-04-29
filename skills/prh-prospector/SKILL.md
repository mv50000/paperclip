---
name: prh-prospector
description: >
  Hae ja rikastu B2B-yritystietoa Suomesta PRH:n avoimesta YTJ-rajapinnasta
  (Patentti- ja rekisterihallitus). Tukee yksittäishakua Y-tunnuksella, nimellä
  tai toimialakoodilla. Täydentyy AI-pohjaisella verkkosivuanalyysilla
  (tech-stack, sosiaalinen media, rekrytointi, EAA-relevanssi). GDPR-tiukka:
  ainoastaan B2B-tason tietoa, ei henkilötietoja, ei LinkedIn-skrapeä.
---

# PRH-Prospector — B2B-leadihakuskill

Vainu-vaihtoehtoinen leadhaku Suomen avoindatasta. Tarkoitettu kolmeen yritykseen:
**Alli-Audit** (EAA-velvolliset), **Saatavilla** (palvelutoimialat),
**Ololla** (matkailu/vuokraus). Tarjoaa noin 60-70 % Vainun FI-katalogin
arvosta murto-osalla työstä — perustiedot suoraan rekisteristä, syvempi
kontekstuaalinen tieto AI-rikastuksen kautta.

## Milloin käytä

- Tarvitset B2B-prospektilistan toimialaluokalla (TOL2008-koodi)
- Sinulla on Y-tunnus ja haluat täydet rekisteritiedot
- Etsit yritystä nimellä tai osatunnisteella
- Tarvitset rikastetun analyysin: onko verkkokauppa, tech-stack, sosiaalinen media

## Milloin EI käytä

- **Henkilökontaktien etsintään.** Tämä skill ei palauta päättäjien nimiä,
  sähköposteja tai puhelinnumeroita. Käytä erillisiä B2B-kontaktipalveluja
  vasta DPIA-päivityksen jälkeen.
- **Konsernirakenteiden analyysiin.** PRH:n avoindata ei sisällä omistajatietoja
  syvätasolla. Käytä tähän PRH:n maksullista rajapintaa erikseen.
- **Tilinpäätösten massahakuun.** Yksittäisen tilinpäätöksen voi hakea, mutta
  kymmenien tuhansien massahaku ohjaa erilliseen YTJ-dumppiin.
- **Cold-spam-listoihin.** Marketing-sähköpostien lähettäminen näille leadeille
  ilman opt-in:iä on PECR-rikkomus.

## Datalähteet

| Lähde | URL | Auth | Kattavuus |
|-------|-----|------|-----------|
| **PRH YTJ v3** | `https://avoindata.prh.fi/opendata-ytj-api/v3/companies` | Ei | ~700 000 yritystä, perusrekisteri |
| **Tilastokeskus TOL2008** | hardcoded `references/tol2008-codes.md` | – | Toimialakoodit per yritystyyppi |
| **AI-rikastus** | Claude (agentin oma malli) | – | Verkkosivun analyysi |

Tarkat endpointit ja query-parametrit: `references/prh-api-reference.md`.

## Skriptien käyttö

Skriptit ajetaan `tsx`:llä Paperclipin juurihakemistosta:

```bash
# Yksittäishaku Y-tunnuksella
tsx skills/prh-prospector/scripts/prh-lookup.ts 0114162-2

# Toimialahaku (5-numeroinen TOL2008)
tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910

# AI-rikastus yhdelle yritykselle
tsx skills/prh-prospector/scripts/enrich-with-ai.ts 0114162-2
```

Output on JSON stdoutiin sekä jsonl-loki polkuun
`/var/lib/paperclip/prh-prospector/leads/{companyId}/{Y-tunnus}.jsonl`.

## Output-rakenne

Skripti palauttaa kaksi namespacea: `prh.*` (suora rekisteridata) ja `ai.*`
(rikastus). Tämä mahdollistaa Vainu-vertailuajot ilman, että rikastusta täytyy
ajaa joka kerta erikseen.

```json
{
  "businessId": "0114162-2",
  "prh": {
    "name": "Lindex Group Oyj",
    "mainBusinessLine": { "code": "47120", "description": "Muu erikoistumaton vähittäiskauppa" },
    "addresses": [{ "type": "visiting", "street": "Aleksanterinkatu 52 B", "postCode": "00100", "city": "HELSINKI" }],
    "registers": [{ "name": "Kaupparekisteri", "registrationDate": "1919-01-20" }],
    "companyForm": "Julkinen osakeyhtiö",
    "status": "rekisterissä",
    "founded": "1978-03-15"
  },
  "ai": {
    "websiteUrl": "https://lindex.com",
    "techStack": ["Shopify Plus", "GA4", "Hotjar"],
    "socialMedia": { "linkedin": "...", "instagram": "..." },
    "recruitmentSignals": [],
    "eaaRelevance": "high (verkkokauppa, listattu)",
    "industryTag": "fashion-retail-multinational"
  },
  "fetchedAt": "2026-04-29T18:30:00Z"
}
```

## GDPR-säännöt

Tarkemmat säännöt: `references/gdpr-rules.md`. Lyhyesti:

1. **EI henkilötietoja**: emme tallenna nimien, sähköpostien, puhelinnumeroiden
   tai LinkedIn-profiilien tietoja. Vastuuhenkilöt (toimitusjohtaja, hallitus)
   ovat julkista rekisteritietoa, mutta niitä **ei rikasteta** muulla datalla.
2. **EI LinkedInia**: skraping rikkoo ToSia ja oikeustila on epäselvä
   (hiQ Labs vs LinkedIn). Käytä vain LinkedInin julkaisemaa Sales Navigatoria
   manuaalisesti, ei skriptien kautta.
3. **Vain sivuston public-sisältö**: AI-rikastuksessa skripti hakee vain
   `robots.txt`:n sallimat polut, kunnioittaa `Crawl-Delay`:tä, ja jättää
   evästekysynnän + login-sivut väliin.
4. **Audit log**: jokainen haku tallennetaan jsonl-lokiin per yritys.
   Logia ei pushata git-repoon (`.gitignore`-sääntö).

## Per-yritys-konfiguraatio

Eri yritykset hakevat eri tyyppisiä leadeja. Konfiguraatio on
`references/tol2008-codes.md`:ssa, ja agentin tulee lukea se ennen hakua.

| Yritys | Companies-ID | Kohderyhmä | Pää-TOL-koodit |
|--------|--------------|------------|----------------|
| Alli-Audit | `cd8eacb5-e1c2-47ae-89ba-6abb26f20f7c` | EAA-velvolliset (verkkokaupat, julkishallinto, finanssi, koulutus, terveys) | 47.91-, 64.-, 65.-, 85.-, 86.-, 86200 |
| Saatavilla | `9a1c05e0-cca0-40a5-9db6-0073478a25a4` | Pienpalveluntarjoajat (kampaamot, hierojat, kauneudenhoito) | 96021, 96022, 96040, 86902 |
| Ololla | `187edb54-daf5-4b83-848d-25bbf8dda5db` | Matkailu/vuokraus PK-yritykset | 55101, 55109, 55201, 55202, 55300, 79110, 79120 |

## Vainu-kattavuusvertailu

Skill on suunniteltu kattamaan ~280-320 / 455 (62-70 %) Vainun FI-katalogin
datapisteistä. Erityisesti seuraavat Vainu-namespacet **eivät kuulu** tämän
skillin v1:een ja vaativat erillisen integraation:

- `contacts.*` (28 kenttää) — GDPR-syistä pois
- `real_estates.*` (43 kenttää) — eri rekisteri (MML)
- `vehicles.*` (27 kenttää) — Traficom
- `payment_delays.*` (11 kenttää) — Asiakastieto/luottotiedot, maksullinen
- `group_data.*` (11 kenttää) — PRH:n maksullinen syvätaso

Tarkemmat vastaavuudet: `references/vainu-coverage-mapping.md`.

## Vianetsintä

- **Skripti palauttaa `404 Not Found`** → Y-tunnus väärin, tarkista muoto
  `\d{7}-\d`
- **`totalResults: 0` toimialakoodilla** → TOL2008 5-numeroinen, ei pisteitä.
  Esim. "47.91" → "47910", "47.99" → "47991".
- **Rate-limit (HTTP 429)** → PRH ei dokumentoi tarkkaa rajaa, mutta käytä
  `1 req/s` peruskäytössä, exponential backoff `429`:n osuessa.
- **Verkkosivun fetch epäonnistuu** → JS-renderöity SPA. AI-rikastus
  voi langeta takaisin vain HTML-meta-tageihin. Älä käynnistä Playwrightia
  rikastusvirheissä — kustannussyy.

## Linkit

- Vainu-vertailudata: `/var/lib/paperclip/prh-prospector/vainu-baseline/vainu-final-fi.json`
- Strategia ja konteksti: muisti `project_prh_prospector.md`
- Suunnitelma: `/home/rk9admin/.claude/plans/olisi-aika-implementoida-prh-deep-corbato.md`
