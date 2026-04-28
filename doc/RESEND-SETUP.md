# Resend-integraatio — käyttöönotto

Paperclip-yritykset käyttävät Resendiä outbound- ja inbound-sähköpostiin. Tämä
dokumentti kuvaa per-yritys-käyttöönoton: domain-verifikaatio, secretit,
reititys, smoke-testi.

> **Status:** Vaihe 1 (outbound + skill) on koodattu, smoke-testi tekemättä.
> Vaihe 2 (inbound multi-tenant router) tulossa.

Vaiheet 1–4 tehdään yhdessä. Vaihe 5 ajetaan kun kaikki muu on kunnossa.

## 1. Lisää domain Resendiin (per yritys)

Per yritys, jonka domain ei ole vielä Resendissä:

1. Mene https://resend.com/domains → **Add Domain** → syötä `<yritys>.fi`
2. Resend antaa kolme DNS-tietuetta: DKIM (TXT), SPF (TXT), DMARC (TXT) ja
   yhden MX-tietueen inbound-vastaanotolle (Vaihe 2).
3. Lisää tietueet domainin DNS-zoneen. Verifikaatio kestää 5–60 min.
4. Kun status vihreä → kopioi domainin `id` (esim. `01abcd...`); tallenna se
   `company_email_config.resend_domain_id` -kenttään (alla).

DNS-checklist (lähetä `mail-tester.com` -testi kun verifioitu):
- `dig MX <domain>` → Resendin endpoint
- `dig TXT <kdkim-selector>._domainkey.<domain>` → DKIM-allekirjoitus näkyy
- `dig TXT _dmarc.<domain>` → DMARC-policy `quarantine` tai `reject`
- mail-tester.com → vähintään 9/10
- Lähetä testi Gmailiin, paina "show original" → SPF=PASS, DKIM=PASS, DMARC=PASS

## 2. Tallenna secretit per yritys

Jokaiselle yritykselle tarvitaan kaksi secretia:

```bash
# Resend API-avain — outboundin lähetykseen
curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/secrets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "resend.api_key",
    "provider": "local_encrypted",
    "value": "re_..."
  }'

# Svix signing secret — inbound-webhookien verifiointiin (Vaihe 2)
curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/secrets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "resend.signing_secret",
    "provider": "local_encrypted",
    "value": "whsec_..."
  }'
```

> Huom: Ololla:lla on tällä hetkellä Resend Rust-backendissä, NOT Paperclipissä.
> Vaiheessa 5 (Ololla:n migraatio) sama API-avain kopioidaan Paperclipiin
> rinnakkaisajon ajaksi.

## 3. Luo `company_email_config`-rivi

Helpoiten install-skriptillä — se on idempotentti ja ei kosketa olemassa olevia
secretejä.

```bash
cd /home/rk9admin/paperclip
pnpm tsx scripts/install-resend-skill.ts \
  --company-id $COMPANY_ID \
  --primary-domain ololla.fi \
  --sending-domain ololla.fi \
  --resend-domain-id <Resendin antama id> \
  --default-from-name "Aski"
```

Skripti:
1. Asentaa `resend`-skillin yritykselle (jos ei ole)
2. Luo/päivittää `company_email_config`-rivin (status alkaa `pending`)
3. EI kosketa `company_secrets`:iä (ne tehdään käsin yllä)

Verifikaation jälkeen aja:
```bash
pnpm tsx scripts/install-resend-skill.ts --company-id $COMPANY_ID --verify
```
joka pollaa Resendin domain-statuksen ja flippaa `status='verified'` kun DKIM/
SPF/DMARC ovat kaikki passattuja.

## 4. Konfiguroi reititys (`email_routes`)

Vaihe 1:ssä reititystaulu on jo olemassa, mutta sitä käytetään vasta Vaihe 2
inboundissa. Outboundin `routeKey` viittaa silti tämän taulun riveihin
(`tuki`, `kaisa`, `noreply` jne.) — `From:`-osoite rakennetaan
`${routeKey}@${sending_domain}`-kaavalla.

Esimerkki Ololla:lle:

```sql
INSERT INTO email_routes (company_id, local_part, domain, route_key, assigned_agent_id, escalate_after_hours)
VALUES
  ($1, 'tuki',    'ololla.fi', 'support',    $aski_id,    24),
  ($1, 'kaisa',   'ololla.fi', 'accounting', $kaisa_id,   48),
  ($1, 'noreply', 'ololla.fi', 'noreply',    NULL,        24),
  ($1, '*',       'ololla.fi', 'catch-all',  $aski_id,    24);
```

(`*`-rivi on Vaihe 2 inbound-fallback. Outboundin kannalta ei tarvita.)

## 5. Smoke-testi (Vaihe 1 outbound)

Kun yritys on vihreänä (`company_email_config.status='verified'`),
`resend.api_key` tallennettu, ja `email_routes`-rivit asetettu:

```bash
curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/email/send \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Paperclip-Run-Id: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "routeKey": "noreply",
    "to": ["mv@rk9.fi"],
    "subject": "Resend Vaihe 1 smoke",
    "bodyMarkdown": "Hei,\n\nTämä on smoke-testi Vaiheen 1 jälkeen.\n\nTerveisin\nPaperclip"
  }'
```

Vastaus 202 + `{ messageId, providerMessageId }` ⇒ smoke OK.

Tarkista tietokannasta:
```sql
SELECT direction, status, subject, to_addresses, sent_at
FROM email_messages
WHERE company_id = $1 AND direction = 'outbound'
ORDER BY created_at DESC LIMIT 5;

SELECT status, error_code, suppression_hit, rate_limit_hit
FROM email_outbound_audit
WHERE company_id = $1
ORDER BY created_at DESC LIMIT 5;
```

## Adversarial-testit (suositeltu ennen tuotantoa)

```bash
# Header injection — pitäisi palauttaa 400 + reason: header_injection
curl -X POST .../email/send -d '{
  "routeKey": "noreply",
  "to": ["a@b.fi"],
  "subject": "OK\r\nBcc: leak@evil.com",
  "bodyMarkdown": "..."
}'

# Suppression hit — lisää osoite ensin, sitten yritä
curl -X POST .../email/suppression -d '{"address":"blocked@example.com","reason":"manual"}'
curl -X POST .../email/send -d '{
  "routeKey": "noreply",
  "to": ["blocked@example.com"], ...
}'  # 403 + reason: suppressed

# Rate limit — käy 51 send-kutsua → 51. blokataan
```

## Inbound (Vaihe 2 — tulossa)

Kun Vaihe 2 valmis, MX-tietueen oikein konfigurointi tarkoittaa, että saapuvat
sähköpostit `tuki@<domain>` luovat automaattisesti taskin asianomaiselle
agentille, ja agentit lukevat bodyn vain `<untrusted_email_body>`-tagien sisältä.
Lisätietoa: `skills/resend/references/security.md`.
