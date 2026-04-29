# TOL2008-toimialakoodit per yritys

Tämä lista sisältää PRH-API:n hakuun käytettävät TOL2008-koodit kullekin
kohdeyritykselle. **PRH-API odottaa 5-numeroista koodia ilman pisteitä**, joten
koodi 47.91 on API:ssa "47910".

Lähde: Tilastokeskus TOL2008 (https://www.stat.fi/meta/luokitukset/toimiala/001-2008/).

---

## Alli-Audit (cd8eacb5-e1c2-47ae-89ba-6abb26f20f7c)

**Kohderyhmä:** EAA-velvolliset yritykset — yli 10 M€ verkkokaupat,
julkishallinto, finanssi, koulutus, terveys.

### Verkkokaupat ja vähittäiskauppa
- `47910` — Postimyynti ja verkkokauppa
- `47990` — Muu vähittäiskauppa muualla kuin myymälöissä
- `47120` — Muu erikoistumaton vähittäiskauppa (esim. tavarataloketjut)
- `47210`-`47890` — erikoistuneet vähittäiskaupat (vaate, elektroniikka, kirja, jne.)

### Julkishallinto (kunnalliset/valtion organisaatiot, yhdistykset, säätiöt)
- `84110` — Julkinen hallinto
- `84120` — Sosiaali- ja terveydenhuollon hallinto
- `84130` — Talouden hallinto
- `84300` — Pakollinen sosiaaliturva

### Finanssi
- `64190` — Muu pankkitoiminta
- `64910`-`64990` — Sijoitustoiminta, leasing
- `65110`-`65300` — Vakuutustoiminta
- `66110`-`66290` — Rahoituspalvelujen tukitoiminta

### Koulutus
- `85100` — Esiopetus
- `85200`-`85320` — Perusopetus, yleissivistävä keskiaste, ammatillinen
- `85410`-`85430` — Korkea-aste
- `85510`-`85590` — Muu koulutus

### Terveydenhuolto
- `86101`-`86109` — Terveyspalvelut (sairaalat, vastaanotot)
- `86210`-`86230` — Lääkäri- ja hammaslääkäripalvelut
- `87100`-`87900` — Sosiaalipalvelut asuinkäytössä
- `88100`-`88990` — Sosiaalipalvelut

### Käyttöesimerkki
```bash
# Helsinki, postimyynti+verkkokauppa
tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47910 --city=HELSINKI

# Erikoistumattomat vähittäiskaupat (isot ketjut)
tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 47120 --max=200
```

---

## Saatavilla (9a1c05e0-cca0-40a5-9db6-0073478a25a4)

**Kohderyhmä:** Pienpalveluntarjoajat — kampaamot, hierojat, kauneudenhoito,
hierontapalvelut. TOL-koodit ovat selkeitä ja luokat ovat homogeenisia.

### Kauneus- ja hyvinvointipalvelut
- `96021` — Parturit ja kampaamot
- `96022` — Kauneudenhoitopalvelut
- `96030` — Hautaustoimistot ja hautausmaat (ei kohteena, mainittu vain TOL96-luokan tunnistamiseksi)
- `96040` — Kylpylä- ja saunatoiminta, fyysisen hyvinvoinnin palvelut

### Terveydenhuoltoon liittyvä hieronta
- `86902` — Fysioterapeutit (hieronta luokitellaan tähän)

### Käyttöesimerkki
```bash
# Helsinkiläiset parturit-kampaamot
tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 96021 --city=HELSINKI
```

---

## Ololla (187edb54-daf5-4b83-848d-25bbf8dda5db)

**Kohderyhmä:** Matkailu/vuokraus PK-yritykset (yritysasiakkaat).
**Tärkeää:** Yksityishenkilöiden mökit eivät ole kohteena — ei henkilörekisteriä.

### Majoitus
- `55101` — Hotellit
- `55109` — Motellit, matkustajakodit, retkeilymajat
- `55201` — Retkeilymajat ja vastaava majoitus
- `55202` — Loma- ja majoitustoiminta (loma-asunnot, mökit yritysasiakkaiden vuokraamana)
- `55300` — Leirintä, matkailuvaunualueet

### Matkanjärjestäjät ja -toimistot
- `79110` — Matkatoimistot
- `79120` — Matkanjärjestäjien toiminta
- `79900` — Muut matkailupalvelut

### Käyttöesimerkki
```bash
# Rovaniemen hotellit
tsx skills/prh-prospector/scripts/prh-search-by-tol.ts 55101 --city=ROVANIEMI
```

---

## Yleiset huomiot

### Pisterajat → 5-numeroinen koodi
| Tilastokeskuksen muoto | PRH-API muoto |
|------------------------|---------------|
| 47.91 | 47910 |
| 96.021 (alaluokka) | 96021 |
| 86.21 | 86210 |
| 84.11 | 84110 |

### Jos halutaan koko TOL-luokka (esim. 47.x)
PRH-API ei tue prefix-hakua — on ajettava hakuja yksittäin per 5-numeroinen
koodi ja yhdistettävä tulokset skriptin tasolla.

### Sijaintirajaukset

PRH-API:n `location`-parametri **ei toimi** kuntakoodilla — palauttaa aina 0
tulosta. Käytä joko:
- `--city=NIMI` (client-side-suodatus skripti-tasolla, kaupungin nimi
  isoilla kirjaimilla, esim. `HELSINKI`, `TAMPERE`, `ROVANIEMI`)
- `--postcode=00100` (PRH-API:n natiivi `postCode`-parametri, tasan yksi
  postinumero)

Yleensä `--city=...` on helpoin. Postinumeron voi tarvita kun yhdellä
kaupungilla halutaan rajata vain tiettyyn alueeseen.
