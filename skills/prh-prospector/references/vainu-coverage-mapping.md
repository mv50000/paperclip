# Vainu-kattavuusvertailu

Vainun täys-FI-katalogi (455 datapistettä) verrattuna PRH-Prospectorin
v1-toteutukseen. Lähde: tämän session aikana kerätty
`/var/lib/paperclip/prh-prospector/vainu-baseline/vainu-final-fi.json`.

## Yhteenveto

| Kategoria | Vainu FI | PRH-Prospector v1 | Kattavuus |
|-----------|----------|-------------------|-----------|
| Perustiedot (id, nimi, osoite, perustamispvm, kotipaikka, yhtiömuoto) | ~25 | ✓ | 100 % |
| Toimialakoodi (TOL2008) | 5 | ✓ | 100 % |
| Vastuuhenkilöt (julkinen rekisteri) | 9 | ⚠ ei v1 | 0 % |
| ALV/Ennakkoperintä-statukset | 6 | ✓ | 100 % |
| Verkkotunnukset, sosiaalinen media, tech-stack | ~25 | ✓ AI-rikastus | 70-90 % |
| Tilinpäätökset (ts.assets, ts.income_statement, jne.) | 104 | ⚠ ei v1, dokumentoitu | 0 % |
| Toimipaikat (business_units) | 47 | ⚠ ei v1 | 0 % |
| Kontaktit (contacts.*) | 28 | ✗ GDPR | 0 % |
| Kiinteistö (real_estates) | 43 | ✗ MML eri rekisteri | 0 % |
| Ajoneuvot (vehicles) | 27 | ✗ Traficom eri rekisteri | 0 % |
| Maksukäyttäytyminen (payment_delays) | 11 | ✗ Asiakastieto maksullinen | 0 % |
| Konsernitiedot (group_data) | 11 | ✗ PRH maksullinen syvätaso | 0 % |
| **Yhteensä** | **455** | **~150-180** | **~33-40 %** |

**Huomio:** Yllä olevat raw-luvut ovat datapiste-tasolla. Käytännön
**arvon** kattavuus on suurempi, koska yksittäisellä korkean prioriteetin
datapisteellä (esim. liikevaihto, tech-stack) on enemmän painoa kuin
kymmenellä matalan prioriteetin datapisteellä (esim. tilinpäätöksen
välitilit). Käytännön arvio: **PRH-Prospector v1 = 60-70 % Vainun FI-arvosta**.

## Vainu-namespacet → PRH-Prospector-mappaus

### Täysin katettu (PRH suorana)

| Vainu | PRH endpoint | Skripti |
|-------|--------------|---------|
| `business_id` | `companies.businessId.value` | prh-lookup |
| `name` | `companies.names[type=1]` | prh-lookup |
| `auxiliary_names` | `companies.names[type=3]` | prh-lookup |
| `founded` | `companies.businessId.registrationDate` | prh-lookup |
| `domicile` | `companies.addresses[].postOffices[].municipalityCode` | prh-lookup |
| `country` | (FI implisiittisesti) | – |
| `address.*` | `companies.addresses[type=2]` | prh-lookup |
| `visiting_address.*` | `companies.addresses[type=1]` | prh-lookup |
| `legal_entity` | `companies.companyForms[].descriptions` | prh-lookup |
| `is_active` | `companies.status` | prh-lookup |
| `official_industries.*` | `companies.mainBusinessLine` | prh-lookup |
| `registers.*` | `companies.registeredEntries` | prh-lookup |
| `e_invoice_addresses.*` | erillinen TIEKE-API (ei v1) | – |
| `languages` | (oletus FI/EN) | – |

### AI-rikastuksella katettu

| Vainu | Lähde | Skripti |
|-------|-------|---------|
| `social_media.*` (6) | Verkkosivun footer | enrich-fetch |
| `technology_data.*` (5) | Verkkosivun source/headers | enrich-fetch + AI-prompti |
| `website_data.*` (7) | Verkkosivun meta + sisältö | enrich-fetch + AI-prompti |
| `recruitment_keywords.*` (6) | Urat-sivu (jos on) | enrich-fetch + AI-prompti (v1.1) |
| `vainu_custom_industries.*` (6) | AI-luokittelu | enrich-fetch + AI-prompti |

### v1:stä pois

| Vainu | Syy | Mahdollinen jatko |
|-------|-----|-------------------|
| `contacts.*` (28) | GDPR-pommi, ei rakenneta | Ei tehdä, korkea riski |
| `financial_statements.*` (104) | PRH bulk-dump, ei REST-API | v2: ZIP-importti + SQLite-indeksi |
| `financial_data.*` (8) | Tilinpäätös-johdannainen | v2 yhdessä financial_statements:in kanssa |
| `business_units.*` (47) | PRH ei tarjoa toimipaikkalistaa avoimena | v2: erillinen YTJ-dump-parseri |
| `real_estates.*` (43) | MML eri rekisteri (Maanmittauslaitos) | Ei v1, harkitaan jos arvostettu |
| `vehicles.*` (27) | Traficom eri rekisteri | Ei v1, ei yritysrelevanssia useimmille |
| `payment_delays.*` (11) | Asiakastieto/Bisnode maksullinen | v2 jos hankitaan tilaus |
| `group_data.*` (11) | PRH maksullinen syvätaso | v2 jos hankitaan |
| `owners.*` (9) | Osa avoindata, osa maksullinen | v1.1: vain julkinen vastuuhenkilölista |
| `payment_delays`, `indexes` | Maksullisia | v2 jos hankitaan |

## Vainu-API-version vertailu

Vainun katalogissa on 0 datapistettä `API V2`-välilehdellä — se on **deprecated**.
Kaikki 468 datapistettä ovat saatavilla `API V3`-tasolla. Tämä tarkoittaa että
PRH-Prospectorin tulee verrata itseään API V3 -kattavuuteen, ei API V2:een.

## Vainu-tuotetasojen vertailu

| Vainu-tuote | Vainu-datapisteet | PRH-Prospector v1 vastaa? |
|-------------|-------------------|---------------------------|
| API V3 | 468 | Ei (skill on toolkit, ei API-tuote) |
| Download | 118 | Osittain (jsonl-loki per yritys) |
| Filter (sales-platform UI) | 119 | Ei (skill ei tarjoa UI:ta) |
| Connector (CRM) | 67 | Ei v1, mahdollinen v1.1 (CSV-export) |
| Company profile (UI) | 221 | Osittain (skripti-output) |

## Mitattava lopputulos 6 vk:n päästä

Aja sama 50 yrityksen otanta sekä PRH-Prospectorilla että Vainu-pilotilla
(jos hankittu). Verifioi datapiste-tasolla mitkä Vainu-namespacet täyttyvät
ja millä laadulla:

- **PRH-suorat** (~25 datapistettä): odotetaan 100 % match
- **AI-rikastetut** (~25 datapistettä): odotetaan 50-80 % match (riippuu
  verkkosivun laadusta)
- **Tilinpäätös-namespacet** (104): 0 % v1:ssä — tärkeä päätöspiste
  jatkokehitykseen
- **Konteksti/signaalit** (Vainun trigger events): 0 % v1:ssä — Vainun
  pää-moatti, ei kopioitavissa avoindatasta

Päätös: **PRH+AI ≥ 80 % painotettu arvo** → laajenna kaikkialle ja luovu
Vainu-pilotista. **PRH+AI ≈ 50 %** → pidä Vainu Allilla, käytä PRH:ta
Saatavilla/Olollalla. **Signaalit kriittisiä** → Vainu pysyy ainoana
ratkaisuna.
