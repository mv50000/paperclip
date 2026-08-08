# Amazon SES -sähköpostin käyttöönotto (per yritys)

Paperclipin sähköposti kulkee provider-abstraktion läpi (`server/src/services/email/provider.ts`).
Yritys ajaa joko Resendillä tai SES:llä `company_email_config.mail_provider`-sarakkeen mukaan
(default `resend`). Tämä dokumentti kuvaa SES-polun. Resend-polku: [RESEND-SETUP.md](./RESEND-SETUP.md).

**Ajurit SES:lle:** GDPR/datan EU-sijainti (region eu-north-1), kustannus, ei vendor-lock-in.
**Agenttinäkymä ei muutu:** agentit ja `/api/companies/:id/email/*`-API ovat provider-neutraaleja.

## Arkkitehtuuri lyhyesti

- **Ulospäin:** `SesProvider` (`ses-client.ts`) → SESv2 `SendEmail` Raw-MIME:llä (`mime.ts`). Creditit
  ympäristöstä (yksi RK9:n AWS-tili kaikille yrityksille).
- **Sisäänpäin:** SES receipt rule tallentaa raakan MIME:n S3:een + julkaisee SNS-notifikaation →
  `POST /api/webhooks/ses` (`ses-inbound.ts`) → SNS-allekirjoitus verifioidaan (`sns-verify.ts`) →
  MIME parsitaan (`ses-inbound-adapter.ts`, mailparser) → normalisoidaan samaan tapahtumamuotoon kuin
  Resend → `inbound-router.handleEvent`. Bounce/complaint tulevat samaa reittiä SNS:llä.
- **Tenant-resoluutio:** vastaanottajadomainilla (inbound) / lähettäjädomainilla (bounce/complaint),
  ei per-tenant-secretiä kuten Resend/Svix.

## Esiehdot (kerran)

1. AWS-tili, region **eu-north-1 (Tukholma)** — EU/GDPR + tukee sekä lähetystä että vastaanottoa.
2. **SES production access** (pois sandboxista) — SES-konsoli → Account dashboard → Request production
   access (~24h review). Sandbox: 200 mailia/24h, vain verifioituihin osoitteisiin.
3. IAM-creditit appille (least-priv): `ses:SendEmail`, `ses:SendRawEmail`, `ses:GetEmailIdentity`,
   `s3:GetObject` (inbound-bucket). Aseta `paperclip.service`-env:iin (systemd drop-in, **ei gitiin**):
   - `SES_REGION=eu-north-1`
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (tai IAM-rooli)

## Per yritys — lähetys

1. **Luo SES domain identity + Easy DKIM (RSA_2048)** (konsoli tai):
   ```bash
   aws sesv2 create-email-identity --email-identity <sending-domain> \
     --dkim-signing-attributes NextSigningKeyLength=RSA_2048 --region eu-north-1
   aws sesv2 put-email-identity-mail-from-attributes --email-identity <sending-domain> \
     --mail-from-domain mail.<sending-domain> --behavior-on-mx-failure USE_DEFAULT_VALUE --region eu-north-1
   ```
2. **Rekisteröi config + tulosta DNS-tietueet:**
   ```bash
   # Dev (workspace-juuri): DATABASE_URL otetaan loadConfig-fallbackista jos ei asetettu.
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip \
     pnpm tsx scripts/install-ses.ts \
     --company-id <uuid> --primary-domain <domain> --sending-domain <domain> \
     --region <eu-region> --default-from-name "<Nimi>"
   ```
   Tämä luo `company_email_config` (`mail_provider=ses`, status=pending), seedaa templatet ja tulostaa
   julkaistavat DNS-tietueet. `--region` = sama region jossa SES-identiteetti on verifioitu (esim.
   `eu-north-1`). Tuotannossa `/opt/paperclip`:ssa aja `./server/node_modules/.bin/tsx scripts/install-ses.ts`
   ja anna `DATABASE_URL` + `SES_REGION`/`AWS_*` env eksplisiittisesti (ks. [[reference_paperclip_deployment]]).
3. **Julkaise DNS-tietueet** domainin **julkiseen** auktoritatiiviseen zoneen (ei sisäverkon Piholeen):
   - DKIM: 3× `CNAME` `<token>._domainkey.<domain>` → `<token>.dkim.amazonses.com`
   - MAIL FROM: `MX mail.<domain>` → `10 feedback-smtp.eu-north-1.amazonses.com`
   - MAIL FROM SPF: `TXT mail.<domain>` → `v=spf1 include:amazonses.com ~all`
   - DMARC: `TXT _dmarc.<domain>` → `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` (kiristä myöhemmin)
4. **Verifioi** kun DKIM näkyy SES:ssä:
   ```bash
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip \
     pnpm tsx scripts/install-ses.ts --company-id <uuid> --region <eu-region> --verify
   ```
   Flippaa `status=verified` → lähetys sallittu.

## Per yritys — vastaanotto (inbound)

> Tee vasta kun lähetys verifioitu. Inbound-MX:n vaihto ohjaa saapuvan postin SES:iin.

1. **S3-bucket** (eu-north-1) raakaa MIME:ä varten, esim. `rk9-ses-inbound`. Bucket policy: salli SES
   `s3:PutObject`.
2. **SNS-topic** `ses-events` (eu-north-1).
3. **Receipt rule set** — rule per yritys-domain → action: deliver to S3 (`rk9-ses-inbound`) + publish
   to SNS (`ses-events`). Aktivoi rule set.
4. **Vastaanotto-MX** domainille: `MX <domain>` → `10 inbound-smtp.eu-north-1.amazonaws.com`.
5. **Bounce/complaint:** SES configuration set → event destination → sama SNS-topic (Bounce, Complaint).
6. **SNS HTTPS-subscription** topiciin → `https://paperclip.rk9.fi/api/webhooks/ses`. Endpoint vahvistaa
   `SubscriptionConfirmation`-handshaken automaattisesti.

## Cutover Resendistä SES:iin

1. Verifioi SES-identiteetti (yllä) ja aja smoke-testi (alla) ennen DNS-vaihtoa.
2. Flippaa provider: `install-ses.ts` asettaa `mail_provider=ses`. (Resend-secretit voivat jäädä;
   niitä ei käytetä kun provider on ses.)
3. Vaihda DNS (DKIM/SPF/MX) Resendistä SES:iin.
4. **Rollback:** `UPDATE company_email_config SET mail_provider='resend' WHERE company_id=...` + palauta
   DNS. Dual-provider-malli tekee tästä turvallista — ei big-bang-vaihtoa.

## Smoke-testi

```bash
curl -X POST "$PAPERCLIP_API_URL/api/companies/<uuid>/email/send" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"routeKey":"noreply","to":["test@example.com"],"subject":"SES smoke","bodyMarkdown":"Hei"}'
# → 202 + { messageId, providerMessageId }
```
Tarkista: mail-tester.com 9/10+, Gmail "show original" SPF/DKIM/DMARC = PASS. Inbound: lähetä mail
domainiin → issue + auto-reply syntyy. Bounce: lähetä invalidiin → suppression-listalle.
