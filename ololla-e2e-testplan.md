# Ololla – Manuaalinen E2E-testaussuunnitelma

**Ympäristö:** https://ololla-dev.rk9.fi (dev) tai https://ololla.fi (prod)  
**Päivitetty:** 2026-05-11  
**Suorittaja:** ___________________  
**Suorituspäivä:** ___________________

---

## Merkinnät

| Symboli | Merkitys |
|---------|----------|
| ✅ | Hyväksytty |
| ❌ | Hylätty – kirjaa huomio |
| ⏭️ | Ohitettu / ei sovellu |
| 🔴 | Kriittinen – must pass |
| 🟡 | Tärkeä – should pass |
| 🟢 | Hyvä olla – nice to have |

---

## Sisällysluettelo

1. [Ympäristön tarkistus](#1-ympäristön-tarkistus)
2. [Autentikointi](#2-autentikointi)
3. [Haku ja suodattimet](#3-haku-ja-suodattimet)
4. [Mökki-sivu](#4-mökki-sivu)
5. [Varauksen teko](#5-varauksen-teko)
6. [Kirjautuneen käyttäjän toiminnot](#6-kirjautuneen-käyttäjän-toiminnot)
7. [Viestit](#7-viestit)
8. [Suosikit ja jonotuslista](#8-suosikit-ja-jonotuslista)
9. [Arvostelut](#9-arvostelut)
10. [Isäntä-ominaisuudet](#10-isäntä-ominaisuudet)
11. [Admin-toiminnot](#11-admin-toiminnot)
12. [Monikielisyys](#12-monikielisyys)
13. [Mobiiliresponsiivisuus](#13-mobiiliresponsiivisuus)
14. [GDPR ja tietosuoja](#14-gdpr-ja-tietosuoja)
15. [Eväste-suostumus](#15-eväste-suostumus)
16. [SEO-tarkistukset](#16-seo-tarkistukset)

---

## 1. Ympäristön tarkistus

### 1.1 Perusyhteys 🔴

**Toimenpiteet:**
1. Avaa selain ja navigoi osoitteeseen `https://ololla-dev.rk9.fi`
2. Tarkista, että sivu latautuu ilman HTTPS-virheitä
3. Avaa DevTools → Console – tarkista, ettei siellä ole punaisia virheitä
4. Tarkista, että sivun otsikko on oikea

**Odotettu tulos:** Sivu latautuu, ei JS-virheitä konsolissa, HTTPS-lukkokuvake näkyy

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 1.1.1 | Etusivu latautuu | | |
| 1.1.2 | Ei konsoli-virheitä | | |
| 1.1.3 | HTTPS toimii | | |
| 1.1.4 | Health endpoint vastaa: `/api/v1/health` palauttaa 200 | | |

---

## 2. Autentikointi

### 2.1 Magic link -kirjautuminen 🔴

**Edellytykset:** Pääsy sähköpostiin tai Resend-loggeihin testaushetkellä

**Toimenpiteet:**
1. Klikkaa "Kirjaudu sisään" / "Login" navigaatiopalkista
2. Syötä testisähköpostiosoite
3. Klikkaa "Lähetä kirjautumislinkki"
4. Avaa sähköposti (tai tarkista Resend-dashboard)
5. Klikkaa magic link -linkkiä
6. Tarkista, että sinut ohjataan takaisin sivustolle kirjautuneena

**Odotettu tulos:** Magic link toimii, sinut kirjataan sisään, navigaatiossa näkyy käyttäjävalikko

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 2.1.1 | Kirjautumislomake aukeaa | | |
| 2.1.2 | Sähköposti lähtee (Resend / postilaatikko) | | |
| 2.1.3 | Magic link ohjaa sivustolle | | |
| 2.1.4 | Käyttäjä on kirjautunut sisään | | |

### 2.2 Passkey-kirjautuminen 🟡

**Huom:** Vaatii selaintuen (Chrome, Edge, Safari) ja aiemmin rekisteröidyn avaintimen

**Toimenpiteet:**
1. Varmista, että sinulla on passkey rekisteröitynä (vaihe 2.3)
2. Kirjaudu ulos
3. Klikkaa "Kirjaudu sisään"
4. Valitse "Passkey"-vaihtoehto
5. Seuraa selaimen kehotuksia biometria- tai PIN-vahvistukseen

**Odotettu tulos:** Passkey-kirjautuminen onnistuu ilman salasanaa

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 2.2.1 | Passkey-vaihtoehto näkyy | | |
| 2.2.2 | Selaimen biometriakehote ilmestyy | | |
| 2.2.3 | Sisäänkirjautuminen onnistuu | | |

### 2.3 Passkey-rekisteröinti 🟡

**Edellytykset:** Kirjautuneena magic linkillä

**Toimenpiteet:**
1. Mene profiilisivulle (navigaatio → oma nimi → Profiili)
2. Etsi "Passkeyt" tai "Avaimet" -osio
3. Klikkaa "Lisää passkey"
4. Seuraa selaimen kehotuksia
5. Varmista, että passkey näkyy listassa rekisteröinnin jälkeen

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 2.3.1 | Passkey-osio löytyy profiilista | | |
| 2.3.2 | Rekisteröintiprosessi käynnistyy | | |
| 2.3.3 | Passkey ilmestyy listaan | | |
| 2.3.4 | Passkeyn voi poistaa | | |

### 2.4 Uloskirjautuminen 🔴

**Toimenpiteet:**
1. Klikkaa käyttäjävalikko
2. Valitse "Kirjaudu ulos"
3. Tarkista, että sinut ohjataan etusivulle tai kirjautumissivulle
4. Tarkista, ettei kirjautuneelle käyttäjälle tarkoitettuja sivuja pääse enää auki suoralla URL:lla

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 2.4.1 | Uloskirjautuminen onnistuu | | |
| 2.4.2 | Session päättyy (navigaatio muuttuu) | | |
| 2.4.3 | `/fi/profile` ohjaa kirjautumissivulle | | |

### 2.5 Nopeusrajoitukset (rate limiting) 🟡

**Toimenpiteet:**
1. Kirjautumissivulla yritä lähettää magic link 4 kertaa peräkkäin samaan osoitteeseen alle 1 minuutissa
2. Tarkista, tuleeko virheilmoitus tai esto

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 2.5.1 | Rate limit aktivoituu liiasta yrityksistä | | |
| 2.5.2 | Virheilmoitus on selkeä ja käyttäjäystävällinen | | |

---

## 3. Haku ja suodattimet

### 3.1 Perushaku 🔴

**Toimenpiteet:**
1. Navigoi etusivulle
2. Hakukentässä syötä sijainti esim. "Tampere" tai "Järvi"
3. Aseta sisäänkirjautumispäivä 2 viikon päähän
4. Aseta uloskirjautumispäivä 3 päivää myöhemmin
5. Aseta vierasmäärä: 4 henkilöä
6. Klikkaa Hae

**Odotettu tulos:** Hakutulokset näkyvät, mökit vastaavat hakukriteerejä

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 3.1.1 | Sijaintihaku toimii | | |
| 3.1.2 | Päivämäärähaku suodattaa oikein | | |
| 3.1.3 | Vierasmäärähaku toimii | | |
| 3.1.4 | Hakutulokset näkyvät listana | | |

### 3.2 Karttanäkymä 🟡

**Toimenpiteet:**
1. Hakutuloksissa vaihda "Kartta"-näkymään
2. Tarkista, että mökit näkyvät kartalla pisteinä/klustereina
3. Klikkaa yksittäistä pistettä – tarkista, aukeaako mökin esikatselu

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 3.2.1 | Karttanäkymä aukeaa | | |
| 3.2.2 | Mökkipisteet näkyvät | | |
| 3.2.3 | Klusterointi toimii (useita mökkejä samalla alueella) | | |
| 3.2.4 | Mökin klikkaus avaa esikatselun | | |

### 3.3 Mökkikohtaiset suodattimet 🔴

**Toimenpiteet:**
1. Tee perushaku ensin (3.1)
2. Avaa suodatinvalikko
3. Testaa jokainen alla oleva suodatin erikseen:

**Saunatyyppi:**
- [ ] Puusauna
- [ ] Sähkösauna
- [ ] Savusauna
- [ ] Ei saunaa

**Ranta:**
- [ ] Hiekkaranta
- [ ] Kivikkoranta
- [ ] Soraranta
- [ ] Laituri
- [ ] Ei rantaa

**Vesistö:**
- [ ] Järvi
- [ ] Meri
- [ ] Joki
- [ ] Lampi

**Etäisyys rannasta:**
- [ ] 0–50 m
- [ ] 50–200 m
- [ ] 200 m+

**Muut:**
- [ ] WiFi
- [ ] Lemmikkiystävällinen
- [ ] Veneellinen mökit (soutuvene, moottorivene, kanootti)
- [ ] Kalastuslajit (hauki, ahven, kuha, taimen)
- [ ] Hintahaitari
- [ ] Minimi yöpymisaika

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 3.3.1 | Saunatyypit suodattavat | | |
| 3.3.2 | Rantatyypit suodattavat | | |
| 3.3.3 | Vesistötyyppi suodattaa | | |
| 3.3.4 | Etäisyys rannasta toimii | | |
| 3.3.5 | WiFi-suodatin toimii | | |
| 3.3.6 | Lemmikkiystävällisyys toimii | | |
| 3.3.7 | Venesuodatin toimii | | |
| 3.3.8 | Hintahaitari suodattaa | | |
| 3.3.9 | Suodattimien nollaus toimii | | |

### 3.4 Lajittelu 🟡

**Toimenpiteet:**
1. Hakutulossivulla kokeile lajitteluvaihtoehtoja:
   - Suositeltu
   - Hinta: halvin ensin
   - Hinta: kallein ensin
   - Arvosana
   - Etäisyys

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 3.4.1 | Lajittelu hinnalla toimii (nouseva) | | |
| 3.4.2 | Lajittelu hinnalla toimii (laskeva) | | |
| 3.4.3 | Lajittelu arvosanalla toimii | | |

### 3.5 AI-haku 🟡

**Toimenpiteet:**
1. Etsi AI-hakukenttä (luonnollisen kielen haku)
2. Kirjoita vapaamuotoinen haku, esim. "mökki jossa on puusauna järven rannalla lapsille sopiva"
3. Tarkista, että hakutulokset vastaavat syötettä

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 3.5.1 | AI-haku kenttä näkyy | | |
| 3.5.2 | Luonnollisen kielen haku palauttaa tuloksia | | |
| 3.5.3 | Tulokset vastaavat hakukriteeriä | | |

---

## 4. Mökki-sivu

### 4.1 Mökki-sivun perussisältö 🔴

**Toimenpiteet:**
1. Klikkaa hakutuloksista jotain mökkiä auki
2. Tarkista kaikki alla olevat elementit

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 4.1.1 | Mökin nimi ja otsikko näkyvät | | |
| 4.1.2 | Kuvagalleria latautuu | | |
| 4.1.3 | Hintatiedot näkyvät | | |
| 4.1.4 | Ominaisuudet/amenities listattu | | |
| 4.1.5 | Sijainti näkyy (alue/järvi/kaupunki) | | |
| 4.1.6 | Varauskalenteri/saatavuus näkyy | | |
| 4.1.7 | Peruutuskäytäntö näkyy | | |
| 4.1.8 | Säätiedot näkyvät (jos saatavilla) | | |

### 4.2 Kuvagalleria 🟡

**Toimenpiteet:**
1. Klikkaa ensimmäistä kuvaa
2. Selaa kuvia nuolilla
3. Sulje galleria Esc-näppäimellä tai raksilla

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 4.2.1 | Galleria aukeaa klikkauksella | | |
| 4.2.2 | Kuvien selaus toimii | | |
| 4.2.3 | Galleria sulkeutuu | | |

### 4.3 Arvostelut 🟡

**Toimenpiteet:**
1. Vieritä mökki-sivulla arvostelu-osioon
2. Tarkista, että arvostelut näkyvät
3. Jos AI-tiivistelmä on käytössä, tarkista sen sisältö
4. Kokeile arvostelun kääntämistä (jos painike näkyy)

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 4.3.1 | Arvostelut näkyvät | | |
| 4.3.2 | Tähtiarvosana näkyy | | |
| 4.3.3 | AI-tiivistelmä näkyy (jos olemassa) | | |
| 4.3.4 | Käännöspainike toimii | | |

### 4.4 Vieraskirja (Guest Book) 🟢

**Toimenpiteet:**
1. Etsi sivulta "Vieraskirja" tai "Vinkit" -osio
2. Tarkista, että sisältö näkyy

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 4.4.1 | Vieraskirja-osio löytyy | | |
| 4.4.2 | Vinkit ovat luettavissa | | |

### 4.5 Samanlaisia mökkejä 🟢

**Toimenpiteet:**
1. Vieritä sivun alaosaan
2. Tarkista "Samankaltaiset mökit" -osio

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 4.5.1 | Suositukset näkyvät | | |
| 4.5.2 | Linkit toimivat oikein | | |

---

## 5. Varauksen teko

### 5.1 Vieraskäyttäjän varaus (ei kirjautumista) 🔴

**Edellytykset:** Kirjaudu ulos ennen testiä. Käytä testisähköpostia jota et käytä muuhun.

**Toimenpiteet:**
1. Mene mökki-sivulle
2. Valitse saatavilla olevat päivämäärät (käytä kalenteria)
3. Aseta vierasmäärä
4. Klikkaa "Varaa" tai "Jatka varaukseen"
5. Täytä lomake:
   - Etunimi
   - Sukunimi
   - Sähköpostiosoite
   - Puhelinnumero (jos pakollinen)
   - Erityistoiveet (vapaaehtoinen)
6. Tarkista hinnan yhteenveto ennen maksua
7. Klikkaa "Siirry maksamaan" / valitse maksutapa
8. **ÄLÄ suorita oikeaa maksua** – tarkista, että maksusivu (Paytrail/Stripe sandbox) aukeaa

**Odotettu tulos:** Varauksen flow toimii, hintatiedot ovat oikein, maksusivu aukeaa

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 5.1.1 | Päivämäärän valinta toimii kalenterissa | | |
| 5.1.2 | Ei-saatavilla olevat päivät on estetty | | |
| 5.1.3 | Vierasmäärä asettuu | | |
| 5.1.4 | Hintalaskelma näkyy (yöhinta × yöt + siivousmaksu jne.) | | |
| 5.1.5 | Peruutuskäytäntö näkyy uudelleen | | |
| 5.1.6 | Yhteystietolomake toimii | | |
| 5.1.7 | Maksutavat näkyvät (Paytrail/Stripe) | | |
| 5.1.8 | Maksusivu aukeaa (sandbox) | | |

### 5.2 Promokoodin syöttö 🟡

**Toimenpiteet:**
1. Varauksen yhteydessä etsi "Promookoodi" tai "Alennuskoodi" -kenttä
2. Syötä epäkelvollinen koodi → tarkista virheilmoitus
3. Syötä kelvollinen koodi (jos testitunnus saatavilla) → tarkista alennus

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 5.2.1 | Promokoodikenttä näkyy | | |
| 5.2.2 | Virheellinen koodi antaa selvän virheen | | |
| 5.2.3 | Kelvollinen koodi soveltaa alennuksen | | |

### 5.3 Minimi yöpymisaika 🟡

**Toimenpiteet:**
1. Etsi mökki jolla on minimi yöpymisaika (esim. 3 yötä)
2. Yritä valita vain 1 yö
3. Tarkista, että järjestelmä estää liian lyhyen varauksen ja näyttää selkeän virheen

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 5.3.1 | Minimimäärä estetään kalenterissa | | |
| 5.3.2 | Virheilmoitus on selkeä | | |

### 5.4 Varauksen tila kirjautuneena käyttäjänä 🔴

**Edellytykset:** Sinulla on aiempi varaus testikäyttäjällä

**Toimenpiteet:**
1. Kirjaudu sisään
2. Mene "Varaukseni"-sivulle
3. Tarkista, että varauksesi näkyy
4. Klikkaa yksittäistä varausta – tarkista tiedot

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 5.4.1 | Varaushistoria näkyy | | |
| 5.4.2 | Yksittäisen varauksen tiedot aukeavat | | |
| 5.4.3 | Varauksen tila on oikein (vahvistettu/odottaa/peruutettu) | | |

### 5.5 Varauksen peruutus 🟡

**Edellytykset:** Peruutettavissa oleva varaus (ei liian lähellä check-in-päivää)

**Toimenpiteet:**
1. Mene varaussivulle
2. Klikkaa "Peruuta varaus"
3. Vahvista peruutus
4. Tarkista, että varaustila muuttuu "Peruutettu"

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 5.5.1 | Peruuta-nappi näkyy | | |
| 5.5.2 | Vahvistusikkuna aukeaa | | |
| 5.5.3 | Tila muuttuu peruutetuksi | | |

---

## 6. Kirjautuneen käyttäjän toiminnot

### 6.1 Profiilisivu 🔴

**Toimenpiteet:**
1. Kirjaudu sisään
2. Navigoi profiilisivulle
3. Tarkista kaikki osiot

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 6.1.1 | Profiilisivu aukeaa | | |
| 6.1.2 | Käyttäjän tiedot näkyvät (nimi, sähköposti) | | |
| 6.1.3 | Passkey-osio näkyy | | |
| 6.1.4 | GDPR-tietojen lataus -painike löytyy | | |

### 6.2 Profiilitietojen muokkaus 🟡

**Toimenpiteet:**
1. Profiilisivulla muokkaa nimeä tai muuta tietoa
2. Tallenna muutokset
3. Lataa sivu uudelleen – tarkista, että muutos säilyi

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 6.2.1 | Muokkauskenttä aktivoituu | | |
| 6.2.2 | Tallennus onnistuu | | |
| 6.2.3 | Muutos säilyy sivun uudelleenlatauksessa | | |

---

## 7. Viestit

### 7.1 Viestipostilaatikko 🟡

**Edellytykset:** Kirjautuneena käyttäjänä jolla on yksi tai useampi varaus ja viesti

**Toimenpiteet:**
1. Navigoi "Viestit"-sivulle
2. Tarkista, että keskustelulistaus näkyy
3. Klikkaa yhtä keskustelua
4. Tarkista viestisyötteen sisältö

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 7.1.1 | Viestilista näkyy | | |
| 7.1.2 | Yksittäinen keskustelu aukeaa | | |
| 7.1.3 | Lukemattomat viestit merkitään | | |

### 7.2 Viestin lähettäminen 🟡

**Toimenpiteet:**
1. Avaa keskustelu
2. Kirjoita viesti tekstikenttään
3. Lähetä viesti
4. Tarkista, että viesti ilmestyy keskusteluun

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 7.2.1 | Tekstikenttä toimii | | |
| 7.2.2 | Viesti lähetetään onnistuneesti | | |
| 7.2.3 | Viesti näkyy lähetyksen jälkeen | | |

---

## 8. Suosikit ja jonotuslista

### 8.1 Suosikkien hallinta 🟡

**Edellytykset:** Kirjautuneena

**Toimenpiteet:**
1. Mökki-sivulla klikkaa sydän/tähti-ikonia (lisää suosikiksi)
2. Siirry "Suosikit"-sivulle
3. Tarkista, että mökki näkyy siellä
4. Poista suosikki

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 8.1.1 | Suosikinlisäys-ikoni näkyy mökki-sivulla | | |
| 8.1.2 | Lisäys onnistuu | | |
| 8.1.3 | Mökki näkyy suosikkilistalla | | |
| 8.1.4 | Poistaminen onnistuu | | |

### 8.2 Jonotuslista 🟢

**Edellytykset:** Varattu mökki jonka kaikki päivät on täynnä

**Toimenpiteet:**
1. Yritä varata täyteen varattu mökki
2. Etsi "Liity jonotuslistalle" -vaihtoehto
3. Liity listalle
4. Tarkista vahvistus

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 8.2.1 | Jonotuslista-vaihtoehto näkyy täytetylle ajanjaksolle | | |
| 8.2.2 | Liittyminen onnistuu | | |
| 8.2.3 | Vahvistus tulee (UI ja/tai sähköposti) | | |

---

## 9. Arvostelut

### 9.1 Arvostelun jättäminen 🟡

**Edellytykset:** Kirjautuneena, vahvistettu ja päättynyt varaus

**Toimenpiteet:**
1. Mene varaussivulle
2. Etsi "Jätä arvostelu" -painike
3. Täytä arvostelu (tähtiluokitus + teksti)
4. Lähetä
5. Tarkista, että arvostelu ilmestyy mökin sivulle

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 9.1.1 | Arvostelumahdollisuus näkyy päättyneelle varaukselle | | |
| 9.1.2 | Lomake täyttyy oikein | | |
| 9.1.3 | Arvostelu lähetetään | | |
| 9.1.4 | Arvostelu näkyy mökin sivulla | | |

---

## 10. Isäntä-ominaisuudet

### 10.1 Isännän kojelaudan pääsy 🔴

**Edellytykset:** Tili jolla on vähintään yksi mökki

**Toimenpiteet:**
1. Kirjaudu isäntätilillä
2. Navigoi isäntiensivulle (yleensä `/fi/admin`)
3. Tarkista, että kojelauta latautuu

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.1.1 | Isäntäkojelauta aukeaa | | |
| 10.1.2 | Mököt listataan | | |
| 10.1.3 | KPI-kortit (varaukset, tulot) näkyvät | | |

### 10.2 Saatavuuskalenteri 🔴

**Toimenpiteet:**
1. Valitse mökki
2. Avaa kalenteri-välilehti
3. Tarkista viikko- ja kuukausinäkymät
4. Kokeile päivien blokkausta
5. Kokeile päivien avaamista

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.2.1 | Kalenteri latautuu | | |
| 10.2.2 | Viikkonäkymä toimii | | |
| 10.2.3 | Kuukausinäkymä toimii | | |
| 10.2.4 | Päivän blokkaus onnistuu | | |
| 10.2.5 | Blokkauksen poisto onnistuu | | |
| 10.2.6 | Vahvistetut varaukset näkyvät (eri värillä) | | |

### 10.3 Hintaasetus 🟡

**Toimenpiteet:**
1. Mene mökin hallintasivulle
2. Avaa hinnoitteluosio
3. Muuta perushintataa
4. Tallenna
5. Tarkista, että muutos näkyy mökki-sivulla (julkinen näkymä)

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.3.1 | Hinnoitteluosio löytyy | | |
| 10.3.2 | Hinnan muuttaminen onnistuu | | |
| 10.3.3 | Muutos tallentuu | | |

### 10.4 Mökkitietojen muokkaus 🟡

**Toimenpiteet:**
1. Avaa mökin hallintasivu
2. Muokkaa kuvausta tai nimeä
3. Tallenna
4. Tarkista julkinen mökki-sivu

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.4.1 | Muokkauslomake aukeaa | | |
| 10.4.2 | Muutokset tallentuvat | | |
| 10.4.3 | Päivitys näkyy julkisella sivulla | | |

### 10.5 Varauslistaus isännälle 🟡

**Toimenpiteet:**
1. Isäntäkojelaudassa avaa varauslista
2. Testaa suodattimet (tila, päivämäärä)
3. Kokeile CSV-vientiä

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.5.1 | Varauslista näkyy | | |
| 10.5.2 | Suodattimet toimivat | | |
| 10.5.3 | CSV-vienti toimii | | |

### 10.6 Isäntäviestit 🟡

**Toimenpiteet:**
1. Mene isäntänäkymän viesteinboksiin
2. Tarkista vieraiden viestit
3. Lähetä vastaus

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.6.1 | Isäntäpostilaatikko aukeaa | | |
| 10.6.2 | Vierasviestit näkyvät | | |
| 10.6.3 | Vastauksen lähettäminen onnistuu | | |

### 10.7 iCal-synkronointi 🟢

**Toimenpiteet:**
1. Kanavahallinnan osio mökin asetuksissa
2. Generoi iCal-URL
3. Testaa URL avaamalla se selaimessa (pitäisi ladata `.ics` tiedosto)

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 10.7.1 | iCal-URL:n luonti onnistuu | | |
| 10.7.2 | URL lataa .ics tiedoston | | |
| 10.7.3 | .ics sisältää oikeat varaukset | | |

---

## 11. Admin-toiminnot

### 11.1 Admin-paneelin pääsy 🔴

**Edellytykset:** Järjestelmänvalvojan oikeudet

**Toimenpiteet:**
1. Kirjaudu admin-tilillä
2. Navigoi admin-paneeliin
3. Tarkista, että järjestelmänvalvojan näkymä aukeaa

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 11.1.1 | Admin-sivu aukeaa | | |
| 11.1.2 | Tavallinen käyttäjä ei pääse admin-sivulle | | |

### 11.2 Kiinteistöjen hallinta 🟡

**Toimenpiteet:**
1. Admin-paneelissa selaa kiinteistölista
2. Avaa yksittäisen kiinteistön hallintasivu
3. Tarkista välilehdet (tiedot, kuvat, varaukset, tilastot)

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 11.2.1 | Kiinteistölista näkyy | | |
| 11.2.2 | Kiinteistön hallintasivu aukeaa | | |
| 11.2.3 | Kaikki välilehdet toimivat | | |

### 11.3 AI-konfiguraatio 🟢

**Toimenpiteet:**
1. Mene `/fi/admin/ai-config`
2. Tarkista, että AI-asetussivu aukeaa

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 11.3.1 | AI-konfiguraatiosivu latautuu | | |

---

## 12. Monikielisyys

### 12.1 Kielen vaihto 🔴

**Toimenpiteet:**
1. Etusivulla etsi kielen vaihtomahdollisuus
2. Vaihda kieleksi ruotsi (sv)
3. Tarkista, että URL muuttuu (`/sv/...`) ja sisältö kääntyy
4. Vaihda kieleksi englanti (en)
5. Tarkista sama

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 12.1.1 | Kielen vaihtomahdollisuus löytyy | | |
| 12.1.2 | Suomi (fi) toimii | | |
| 12.1.3 | Ruotsi (sv) toimii | | |
| 12.1.4 | Englanti (en) toimii | | |
| 12.1.5 | URL vaihtuu kielen mukaan | | |

### 12.2 Hakutulokset eri kielillä 🟡

**Toimenpiteet:**
1. Tee haku englanniksi (`/en/search`)
2. Tarkista, että UI-elementit ovat englanniksi
3. Tee sama ruotsiksi

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 12.2.1 | Hakutulokset englanniksi UI:ssa | | |
| 12.2.2 | Hakutulokset ruotsiksi UI:ssa | | |

---

## 13. Mobiiliresponsiivisuus

**Ohjeet:** Käytä DevToolsia (F12 → Toggle device toolbar) tai fyysistä puhelinta

### 13.1 Mobiili-navigaatio 🔴

**Toimenpiteet:**
1. Avaa sivu mobiilikoossa (320px–428px)
2. Tarkista, että hamburger-valikko tai mobiilinavigaatio näkyy
3. Avaa valikko – tarkista linkit toimivat

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 13.1.1 | Mobiilinavigaatio näkyy | | |
| 13.1.2 | Hamburger-valikko avautuu | | |
| 13.1.3 | Linkit toimivat mobiilissa | | |

### 13.2 Mökki-sivu mobiilissa 🟡

**Toimenpiteet:**
1. Avaa mökki-sivu mobiilikoossa
2. Tarkista kuvagalleria
3. Tarkista, että varausnappi on saavutettavissa

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 13.2.1 | Sisältö mahttuu näytölle ilman vaakasuuntaista skrollausta | | |
| 13.2.2 | Galleria toimii kosketuselein | | |
| 13.2.3 | Varausnappi on näkyvillä | | |

### 13.3 Hakusuodattimet mobiilissa 🟡

**Toimenpiteet:**
1. Avaa hakusivu mobiilissa
2. Tarkista, että suodattimet aukeaa drawer/modal-tyyppisesti

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 13.3.1 | Suodattimet aukeaa mobiilissa | | |
| 13.3.2 | Suodattimet sulkeutuu oikein | | |

---

## 14. GDPR ja tietosuoja

### 14.1 Tietojen lataus 🔴

**Edellytykset:** Kirjautuneena

**Toimenpiteet:**
1. Mene profiilisivulle
2. Etsi "Lataa omat tietosi" tai "Tietojen vienti" -painike
3. Klikkaa painiketta
4. Tarkista, saatko tiedoston tai sähköpostivahvistuksen

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 14.1.1 | GDPR-tietovienti-painike löytyy | | |
| 14.1.2 | Tietojen lataus käynnistyy | | |

### 14.2 Tietosuojakäytäntö 🔴

**Toimenpiteet:**
1. Navigoi `/fi/legal/tietosuoja`
2. Tarkista, että sivu latautuu ja sisältää tietosuojakäytännön

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 14.2.1 | Tietosuojasivu latautuu | | |
| 14.2.2 | Sisältö on luettavissa | | |

### 14.3 Käyttöehdot 🔴

**Toimenpiteet:**
1. Navigoi `/fi/legal/kayttoehdot`
2. Tarkista, että sivu latautuu

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 14.3.1 | Käyttöehtosivulatautuu | | |

---

## 15. Eväste-suostumus

### 15.1 Evästebanneri 🔴

**Toimenpiteet:**
1. Avaa sivu incognito/yksityinen-ikkunassa
2. Tarkista, että evästebanneri ilmestyy
3. Hyväksy evästeet – tarkista, että banneri katoaa
4. Lataa sivu uudelleen – banneria ei pitäisi näkyä uudelleen

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 15.1.1 | Evästebanneri näkyy uudelle vierailijalle | | |
| 15.1.2 | Hyväksyminen poistaa bannerin | | |
| 15.1.3 | Valinta muistetaan uudelleenlatauksessa | | |
| 15.1.4 | Hylkäys toimii (vain välttämättömät evästeet) | | |

---

## 16. SEO-tarkistukset

### 16.1 Meta-tagit 🟡

**Toimenpiteet:**
1. Etusivulla DevTools → Elements → `<head>`
2. Tarkista `<title>` tagit
3. Tarkista `<meta name="description">` olemassaolo
4. Tarkista `<meta property="og:*">` Open Graph -tagit

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 16.1.1 | `<title>` on asianmukainen | | |
| 16.1.2 | Meta description on olemassa | | |
| 16.1.3 | Open Graph tagit löytyvät | | |

### 16.2 Kaupunki- ja aluepages 🟢

**Toimenpiteet:**
1. Navigoi jonkin alueen sivulle (esim. `/fi/alue/pirkanmaa` tai vastaava)
2. Tarkista, että sivu latautuu

| # | Testi | Tulos | Huomio |
|---|-------|-------|--------|
| 16.2.1 | Aluesivu latautuu | | |
| 16.2.2 | Mökkejä listataan alueella | | |

---

## Yhteenvetolomake

| Alue | Kriittiset (🔴) | Tärkeät (🟡) | Nice-to-have (🟢) | Hyväksytty | Hylätty | Ohitettu |
|------|----------------|--------------|-------------------|-----------|---------|---------|
| 1. Ympäristö | | | | | | |
| 2. Autentikointi | | | | | | |
| 3. Haku | | | | | | |
| 4. Mökki-sivu | | | | | | |
| 5. Varaus | | | | | | |
| 6. Käyttäjäprofiiili | | | | | | |
| 7. Viestit | | | | | | |
| 8. Suosikit | | | | | | |
| 9. Arvostelut | | | | | | |
| 10. Isäntä | | | | | | |
| 11. Admin | | | | | | |
| 12. Monikielisyys | | | | | | |
| 13. Mobiili | | | | | | |
| 14. GDPR | | | | | | |
| 15. Evästeet | | | | | | |
| 16. SEO | | | | | | |
| **YHTEENSÄ** | | | | | | |

---

## Huomiot ja löydökset

| # | Päivämäärä | Alue | Kuvaus | Vakavuus | Tila |
|---|-----------|------|--------|----------|------|
| | | | | | |
| | | | | | |
| | | | | | |

---

## Testin hyväksyntä

- **Suorittaja:** ___________________
- **Päivämäärä:** ___________________
- **Ympäristö:** ___________________
- **Tulos:** [ ] Hyväksytty [ ] Hylätty [ ] Hyväksytty puutteilla

**Kommentit:**

___________________________________________________________________________________

___________________________________________________________________________________
