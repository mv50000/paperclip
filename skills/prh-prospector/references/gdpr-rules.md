# GDPR-säännöt PRH-Prospector-skillille

Tämä skill on suunniteltu **B2B-tasoiseksi**. Se ei käsittele henkilötietoja
muutoin kuin PRH:n julkisesta vastuuhenkilörekisteristä luettavia tietoja.

## Säännöt — kategorisesti kielletty

### 1. EI henkilötietojen rikastusta
- Älä yhdistä rekisterin nimitietoa (esim. toimitusjohtaja) ulkoiseen dataan
  kuten LinkedIniin, sähköposti-arvauksiin, henkilönimi-Google-hakuun.
- PRH-rekisterin julkinen vastuuhenkilörekisteri (toimitusjohtaja, hallituksen
  jäsenet, prokuristit) on julkinen tieto, mutta sitä **ei profiloida**.
- Älä tee `<yritys.fi>/yhteystiedot` -skrapesta kontaktipoimintaa nimellä,
  sähköpostilla tai puhelinnumerolla. Skrape jää **vain firma-tason** tietoon
  (yleinen info@-osoite, vaihteen puhelin OK, mutta ei kohdennettu).

### 2. EI LinkedIn-skrapeä
- LinkedIn ToS kieltää scraping:n. Oikeustila on epäselvä (hiQ Labs vs LinkedIn).
- Käytä manuaalista Sales Navigatoria tarvittaessa erikseen (ei tämän skillin
  kautta).

### 3. EI massasähköpostilistoja
- PECR (sähköisen viestinnän tietosuoja-asetus) edellyttää opt-in:iä cold-spamiin.
- Tämä skill tuottaa **prospektointitietoa, ei spammäystyökaluja**.

### 4. Lasten/herkkien ryhmien data
- Kohdeyrityksissä on koulutus- ja terveydenhuoltoyrityksiä. **Älä yhdistä
  oppilas- tai potilastietoja** mihinkään (ei pitäisi PRH:sta löytyäkään,
  mutta varotoimena).

## Säännöt — sallittua

### 1. PRH-rekisterin perustiedot
- Y-tunnus, nimi, osoite, kotipaikka, perustamispvm, yhtiömuoto, toimialakoodi,
  ALV/Ennakkoperintä-status — kaikki PRH:n julkista avoindataa, **vapaa käyttö**.

### 2. Yritystason verkkosivuanalyysi
- Etusivun fetch, footer (yhteystiedot, social media -linkit firma-tason
  tilille), tech-stack -detect, urat-sivun avainsana-analyysi (kysymys: "onko
  rekrytointi-aktiviteettia", ei "ketkä työntekijät").

### 3. Julkiset ilmoitukset
- Hilma-julkaisut, viranomaisten päätökset, KHO/HHO-päätökset jossa firma on
  asianosainen — kaikki julkista hallinto-oikeustietoa.

### 4. Sosiaalisen median tilit firmatasolla
- LinkedInin _company page_ URL on OK (ei henkilöprofiilit).
- Instagram-tili (firma), Facebook-sivu (firma), TikTok (firma).

## Lokitus ja audit

- Jokainen haku tallennetaan jsonl-lokiin
  `/var/lib/paperclip/prh-prospector/leads/{companyId}/{Y-tunnus}.jsonl`.
- Lokeja **ei pushata git-repoon** — `.gitignore` blokeeraa.
- Lokit säilytetään **enintään 6 kk** — yritysten leadhausstatuksen
  refresh-syklin pituuden aika.
- Säilytysajan jälkeen agentti voi ajaa cleanup-skriptin: poistaa yli 6 kk:n
  vanhat tiedostot.

## Yhteyshenkilön (DPO/Tietosuojavastaava) rooli

Jos käyttäjä tarvitsee:
1. Henkilökontaktien rikastusta (johtajat sähköposteilla)
2. Sales Navigator -integraatiota
3. Liiketoimintapäätöksen rakentamista profiloidulle päättäjäkohderyhmälle

→ **Pyydä DPIA-päivitys** Lakiagentilta/Tietosuojavastaavalta ENNEN
toiminnallisuuden lisäämistä tähän skilliin. Älä rakenna ohitusta.

## Riskit jos sääntöjä rikotaan

- **Rikemerkintä, hallinnollinen sakko** (Tietosuojavaltuutettu) — voi olla
  4 % liikevaihdosta tai 20 M€ ylärajalla.
- **Maineenmenetys** — pieni B2B-toimija ei selviä julkisesta tietosuojaongelma-
  kohusta, jos joutuu Tivin/Helsingin Sanomien otsikoihin.
- **LinkedIn ToS-rikkomus** — käyttäjätilin sulkeminen + mahdollinen
  oikeudellinen vaade (hiQ-tapaus jatkuu).

## Tarkastuslista jokaiselle uudelle ominaisuudelle

Ennen kuin lisäät uutta dataa rikastuspipelineen, kysy:

- [ ] Onko tämä B2B-tason tietoa (yritys, ei henkilö)?
- [ ] Onko lähde julkista avoindataa tai sallittu B2B-API?
- [ ] Onko ToS-rajoituksia? (LinkedIn = ei)
- [ ] Tallennetaanko datapiste lokiin? Ja jos kyllä, kuluuko sen säilytys
      automaattisesti 6 kk:n päästä?
- [ ] Onko data uniikkia tunnistettavaa henkilöä? (sähköposti, puh, syntymäaika
      → kyllä → pysähdy ja eskaloi)
