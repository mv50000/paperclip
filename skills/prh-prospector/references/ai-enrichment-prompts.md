# AI-rikastuspromptit

`enrich-fetch.ts` palauttaa `enrichmentPrompt`-kentän, jonka agentti voi
suoraan kopioida Claude-konversaatioon yhdessä `prh` + `website.htmlTruncated`
-datan kanssa.

Tässä dokumentissa on:
1. Pää-rikastusprompti (sama kuin skriptissä)
2. Spesifiset promptit per yritys (eri analyysitarpeet)
3. Esimerkki-output-rakenne
4. Vianetsintä prompteille

---

## Pää-rikastusprompti (general)

```
You are analysing a Finnish B2B company's website. Based on the HTML, the
company name, and PRH register info, return a JSON object with the following
keys:

- techStack: string[]   // detected technology (CMS, e-commerce platform,
                         // analytics, frameworks). Examples: ["Shopify",
                         // "GA4", "WordPress", "Hubspot"]. Empty array if
                         // no signals.
- socialMedia: { linkedin?: string; facebook?: string; instagram?: string;
                 twitter?: string; youtube?: string; tiktok?: string }
- recruitmentSignals: { hasCareersPage: boolean; mentionedRoles: string[];
                        mentionedTech: string[] }
- eaaRelevance: "high" | "medium" | "low" | "none"
- eaaReasoning: string   // 1-2 sentences why
- industryTag: string    // short Vainu-style custom industry tag
- confidence: "high" | "medium" | "low"

GDPR: Do NOT extract personal data (names, emails of individuals, phone
numbers of specific persons). General company contact info (info@, sales@,
switchboard) is OK.

Return ONLY the JSON, no commentary.
```

## Yritys-spesifiset lisäpromptit

### Alli-Audit (EAA-prospektointi)

Lisää pääpromptin `eaaRelevance`-päättelyyn nämä Alli-Audit-erityiset kriteerit:

```
Additional EAA assessment for this prospect:
- "high" if: B2C webshop with ≥10 M€ estimated revenue, finance/banking
  customer-facing service, public administration website, education
  platform with student access, healthcare booking system.
- "medium" if: B2B SaaS with EU customer base + accessibility-impacted
  features, mid-size retail (<10 M€).
- "low" if: pure B2B internal tool, B2B services without consumer-facing
  digital products.
- "none" if: not consumer-facing or only physical service.

Estimate revenue magnitude from the website hints (footer "since X",
office count, language coverage, jobs page seniority).
```

### Saatavilla (palvelutoimialat)

Lisää pääpromptin lisäksi:

```
Additional Saatavilla classification:
- bookingPlatform: "phone-only" | "website-form" | "external-tool" | "selfservice"
- pricingTransparency: "fully-listed" | "ranges" | "consultation-only"
- estimatedScale: "solo" | "small (2-5 staff)" | "medium (6-20)" | "chain"
- specialties: string[]   // top 3 service categories from the website

Goal: identify candidates that would benefit from Saatavilla's booking-
management product (currently phone-only or external-tool, scale = small/medium).
```

### Ololla (matkailu)

Lisää pääpromptin lisäksi:

```
Additional Ololla classification:
- propertyType: "hotel" | "guesthouse" | "cabin-rental" | "campsite" |
                "agency" | "other"
- bookingChannel: "direct" | "booking.com" | "airbnb" | "multi-channel"
- languageCoverage: string[]   // detected languages from <html lang> + footer
- estimatedRoomCount: "<10" | "10-50" | "50+" | "unknown"

Goal: identify mid-size operators (10-50 rooms or 5+ properties) using
booking.com or self-managed without channel-management software.
```

## Esimerkki-output (Lindex)

Kun agentti ajoi pääpromptin Lindex Group Oyj:n datalle, output:

```json
{
  "techStack": ["Salesforce Commerce Cloud", "GA4", "Google Tag Manager", "Hotjar", "Algolia"],
  "socialMedia": {
    "facebook": "https://www.facebook.com/Lindex/",
    "instagram": "https://www.instagram.com/lindexofficial/",
    "tiktok": "https://www.tiktok.com/@lindexofficial",
    "youtube": "https://www.youtube.com/c/lindex"
  },
  "recruitmentSignals": {
    "hasCareersPage": true,
    "mentionedRoles": ["Visual Merchandiser", "Buying Assistant", "Store Manager"],
    "mentionedTech": []
  },
  "eaaRelevance": "high",
  "eaaReasoning": "B2C verkkokauppa, listattu yhtiö ja suuri liikevaihto (yli EAA:n 10M€-rajan). Kuluttajan saavutettavuus on keskeinen liiketoimintaprosessi.",
  "industryTag": "fashion-retail-multinational-publicly-listed",
  "confidence": "high"
}
```

## Promptien hyvä rakenne

1. **Aloita roolilla**: "You are analysing a Finnish B2B company's website..."
2. **Anna data**: PRH-perustiedot + HTML-katkoma + URL
3. **Pyydä JSON**: tiukasti rakenteinen output, `Return ONLY the JSON`
4. **GDPR-muistutus**: jokaisessa promptissa, älä sivuuta
5. **Confidence-kenttä**: pakota malli arvioimaan oman vasteensa luotettavuutta

## Vianetsintä

### Prompti palauttaa muuta kuin JSON
- Lisää `Return ONLY the JSON, no commentary` korostetusti
- Jos malli edelleen jaarittelee, käytä `response_format: { type: "json_object" }`
  Anthropic SDK:ssa kun siirrytään suorakutsuun

### Tech-stack on tyhjä
- Sivu on JS-renderöity SPA, HTML-katkoma ei sisällä alkuperäistä koodia
- Skripti palauttaa pelkän app-shellin, agentti ei näe Shopifya/Algoliaa
- **Ratkaisu v1:ssä**: hyväksy puute, merkitse `confidence: "low"`
- **Myöhempi parannus**: Playwright-fallback raskaille tapauksille (kustannus
  + ylläpitokuorma → ei nyt)

### EAA-relevanssi heiluu
- Annetaan promptiin lisätietoa: arvioitu liikevaihto-luokka, työntekijämäärä-
  signaali (jobs-sivu), maantieteellinen kattavuus (kielet, toimipisteet)

### Mallin asenne väärä (esim. liian "ystävällinen")
- Lisää: "Be terse, factual, and skeptical. Do not invent data not present
  in the HTML or PRH info."
