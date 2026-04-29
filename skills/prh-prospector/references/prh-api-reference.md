# PRH YTJ v3 API -referenssi

Kaikki PRH-haut menevät v3-rajapintaan:
**`https://avoindata.prh.fi/opendata-ytj-api/v3/companies`**

Auth: ei tarvita. Rate-limit: ei virallista, käytä 1 req/s + exponential backoff.

## Endpointit

### Yksittäishaku Y-tunnuksella

```
GET /opendata-ytj-api/v3/companies?businessId=0114162-2
```

Palauttaa täydet rekisteritiedot. **Tämä on ensisijainen lookup-tapa.**

### Hae nimellä

```
GET /opendata-ytj-api/v3/companies?name=Stockmann
```

Substring-matchaus. Palauttaa enintään 100 / sivu. Käytä paginoinnilla
(`&page=N`) jos `totalResults > 100`.

### Hae toimialakoodilla (TOL2008)

```
GET /opendata-ytj-api/v3/companies?mainBusinessLine=47910
```

**HUOMIO**: TOL2008-koodi on PRH-API:ssa 5-numeroinen ilman pisteitä.
Esim. käyttäjä tuntee koodin "47.91", mutta API odottaa "47910".

### Hae kunnan koodilla

```
GET /opendata-ytj-api/v3/companies?location=091
```

`location` = 3-numeroinen kuntakoodi (Tilastokeskus). Esim. 091 = Helsinki.

### Yhdistelmähaut

Parametrit yhdistetään AND-logiikalla:

```
GET /opendata-ytj-api/v3/companies?mainBusinessLine=47910&location=091
```

### Paginointi

```
GET /opendata-ytj-api/v3/companies?mainBusinessLine=47910&page=2
```

Sivut alkavat 1:stä. `totalResults` kentässä koko hakutulos.

## Vasteen rakenne

```json
{
  "totalResults": 63,
  "companies": [
    {
      "businessId": { "value": "0114162-2", "registrationDate": "1978-03-15", "source": "3" },
      "euId": { "value": "FIFPRO.0114162-2", "source": "1" },
      "names": [
        { "name": "Lindex Group Oyj", "type": "1", "registrationDate": "2024-03-22", "version": 1 },
        { "name": "Stockmann Oyj Abp", "type": "1", "registrationDate": "1998-05-11", "endDate": "2024-03-22", "version": 2 }
      ],
      "mainBusinessLine": {
        "type": "47120",
        "descriptions": [
          { "languageCode": "1", "description": "Muu erikoistumaton vähittäiskauppa" },
          { "languageCode": "3", "description": "Other non-specialised retail sale" }
        ],
        "typeCodeSet": "TOIMI4"
      },
      "companyForms": [
        { "type": "17", "descriptions": [{ "languageCode": "1", "description": "Julkinen osakeyhtiö" }] }
      ],
      "registeredEntries": [
        { "type": "1", "descriptions": [...], "register": "1", "authority": "2", "registrationDate": "1919-01-20" },
        { "type": "80", "descriptions": [{ "languageCode": "1", "description": "Liiketoiminnasta arvonlisäverovelvollinen" }], "register": "6" }
      ],
      "addresses": [
        { "type": 1, "street": "Aleksanterinkatu", "buildingNumber": "52", "entrance": "B",
          "postCode": "00100", "postOffices": [{ "city": "HELSINKI", "languageCode": "1", "municipalityCode": "091" }] },
        { "type": 2, "postCode": "00101", "postOffices": [...], "postOfficeBox": "220" }
      ],
      "tradeRegisterStatus": "1",
      "status": "2",
      "registrationDate": "1919-01-20",
      "lastModified": "2026-04-02T12:45:49"
    }
  ]
}
```

## Kenttäselitykset

### `names[].type`
- `1` = päänimi (yritys-virallinen)
- `2` = vieraskielinen rinnakkaisnimi
- `3` = aputoiminimi
- `endDate` jos historiallinen (entinen nimi)

### `addresses[].type`
- `1` = käyntiosoite (visiting)
- `2` = postiosoite (postal)

### `registeredEntries[].register`
- `1` = Kaupparekisteri
- `4` = LEI / EU
- `5` = Ennakkoperintärekisteri
- `6` = Arvonlisäverovelvollisten rekisteri
- `7` = Työnantajarekisteri

### `registeredEntries[].type`
- `1` = Rekisterissä
- `55` = Ennakkoperintärekisterissä
- `80` = ALV-velvollinen liiketoiminnasta
- `82` = ALV-velvollinen kiinteistöstä
- `41` = Työnantajarekisterissä

### `companyForms[].type` (yhtiömuoto)
- `16` = Osakeyhtiö (Oy)
- `17` = Julkinen osakeyhtiö (Oyj)
- `18` = Kommandiittiyhtiö (Ky)
- `19` = Avoin yhtiö
- `20` = Toiminimi
- `21` = Osuuskunta
- (täydellinen lista: PRH:n koodisto)

### `status`
- `1` = aktiivinen
- `2` = poistunut/lopettanut

### `languageCode` (i18n)
- `1` = suomi
- `2` = ruotsi
- `3` = englanti

## Esimerkkikutsut

```bash
# Iso lukko
curl -sS "https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=0114162-2" | jq

# Helsingin verkkokaupat (47.91 = postimyynti)
curl -sS "https://avoindata.prh.fi/opendata-ytj-api/v3/companies?mainBusinessLine=47910&location=091" | jq '.totalResults'

# Stockmann-haku
curl -sS "https://avoindata.prh.fi/opendata-ytj-api/v3/companies?name=Stockmann" | jq '.companies[0]'
```

## Tilinpäätökset (PRH, ei REST per yritys)

PRH:lla on tilinpäätösdata avoimena, mutta **EI** REST-rajapintana yksittäin.
Vain bulk-dumppina:

- Lataussivu: https://avoindata.prh.fi/tilinpaatosdata.html
- Sisältö: ZIP-paketti, tilikausittain, sisältää XBRL-muotoiset tilinpäätökset
- Päivitys: jatkuva (tilinpäätös rekisteröidään → mukaan seuraavaan dumppiin)

### Käyttötapa skillissä (jos halutaan tukea)

1. Lataa viimeisin ZIP cron-skriptillä (esim. kerran kuussa)
2. Pura paikallisesti: `/var/lib/paperclip/prh-prospector/tilinpaatokset/{vuosi}/`
3. Indeksoi Y-tunnuksen mukaan SQLite-kantaan: `businessId → file path`
4. Skripti `prh-tilinpaatos.ts` lukee XBRL:n ja palauttaa normalisoidun JSON:in

**v1:ssä tämä jätetään pois.** Käyttäjä voi pyytää tilinpäätöstä manuaalisesti
PRH:n virresubsiteltä (Virre Online, ~6 €/dokumentti) tai Asiakastieto-API:lta
(maksullinen tilaus).

## Mitä rajapinnasta EI saa
- Liikevaihtoa, henkilöstömäärää — ei avoindatassa
- Päättäjien nimiä yhteystietoineen — vastuuhenkilörekisterissä on nimi +
  rooli, ei sähköpostia/puhelinnumeroa
- Konsernirakenteita yli yhden tason — vaatii maksullisen API:n
- Verkkosivun URLia — PRH-rekisterissä on harvoin, joudutaan etsimään muusta
  lähteestä (Google, oletus `<yritysnimi>.fi`)

## Päivitystaajuus

PRH päivittää YTJ:n yön yli. API palauttaa `lastModified`-aikaleiman
yritystasolla. Skripti voi käyttää tätä cache-invalidointiin jos rakennetaan
välimuisti.
