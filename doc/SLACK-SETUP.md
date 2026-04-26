# Slack-integraatio — käyttöönotto

Paperclip-yritykset voidaan kytkeä yhteen Slack-workspaceen niin, että jokainen yritys saa oman kanavansa ja `#rk9-board`-kanava saa cross-company-tason yhteenvedot (kuten budjettiylitykset). Tässä dokumentissa on Vaihe 0:n manuaalinen setup, joka tehdään ennen kuin Paperclip-puolen koodi alkaa lähettää viestejä.

> **Status:** Vaihe 1 (outbound notifications) ja Vaihe 2 (interaktiiviset approval-napit) on toteutettu. Vaihe 3 (slash-komennot) tulossa myöhemmin.

## 1. Luo Slack App

1. Mene osoitteeseen https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Valitse RK9-workspace
3. Liitä alla oleva manifest YAML-välilehdelle:

```yaml
display_information:
  name: Paperclip
  description: AI-companies control plane
  background_color: "#0f172a"
features:
  bot_user:
    display_name: Paperclip
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - users:read
      - users:read.email
      - channels:read
      - im:write
      - reactions:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  interactivity:
    is_enabled: true
    request_url: https://paperclip.rk9.fi/api/slack/interactions
```

> Vaiheessa 3 lisätään `commands`-scope ja slash-URL:t samaan App ID:hen. Vaihe 2:n interactivity vaatii sekä yllä olevan manifest-toggle että `users:read.email`-scopen, jotta voimme matchaa Slack-käyttäjän Paperclip-käyttäjään sähköpostin avulla.

4. Vahvista (`Create`) → **Install to Workspace**
5. Kopioi **Bot User OAuth Token** (`xoxb-...`). Tätä käytetään `slack.bot_token`-secretinä.
6. Kopioi **Signing Secret** (App Credentials -välilehdeltä). Tätä käytetään myöhemmin Vaiheessa 2 inbound-pyyntöjen verifiointiin (`slack.signing_secret`).

## 2. Luo kanavat

Luo RK9-workspaceen:

| Kanava | Käyttö |
|--------|--------|
| `#rk9-board` | Cross-company-yhteenvedot (esim. budjettiylitykset), daily digest (myöhemmin) |
| `#alli-audit` | Alli-Auditin per-company-eventit |
| `#ololla` | Ololla-yrityksen eventit |
| `#yhtio-3`, `#yhtio-4`, `#yhtio-5` | Loput yritykset |

Kutsu Paperclip-bot kuhunkin kanavaan: `/invite @Paperclip` kanavassa.

Hae jokaisen kanavan **Channel ID**: kanavan nimen vieressä → arrow → `About` → alimpana on `Channel ID: C0XXX...`

## 3. Tallenna secretit per yritys

Slack-integraatio lukee per-company-secretit `company_secrets`-taulusta. Tallenna **kullekin yritykselle**:

| Secret name | Arvo |
|-------------|------|
| `slack.bot_token` | Sama Bot User OAuth Token kaikille yrityksille (`xoxb-...`) |
| `slack.channel_id` | Yrityksen oma kanavan ID (esim. `C0AAA111` Alli-Auditille) |
| `slack.board_channel_id` | `#rk9-board`-kanavan ID (sama kaikille yrityksille) |
| `slack.signing_secret` | Signing Secret (Vaiheessa 2 käytössä, voi tallentaa nyt) |

### Tallennus admin-API:n kautta

```bash
# Yhdistä psql-istunto Paperclip-DB:hen
psql "$DATABASE_URL"

# Hae company_id:t
SELECT id, name FROM companies ORDER BY name;
```

Tallenna käyttäen `secretService.create()`-API:a Paperclip-UI:n Secrets-sivulla, **TAI** suoraan SQL:llä testivaiheessa:

```bash
# Esimerkki yhdelle yritykselle (toista jokaiselle)
COMPANY_ID=00000000-0000-0000-0000-000000000001
BOT_TOKEN='xoxb-your-token-here'
CHANNEL_ID=C0AAA111
BOARD_CHANNEL_ID=C0RK9BOARD

curl -X POST "$PAPERCLIP_PUBLIC_URL/api/companies/$COMPANY_ID/secrets" \
  -H "Content-Type: application/json" \
  --cookie-jar /tmp/board-cookies.txt \
  -d "{\"name\":\"slack.bot_token\",\"provider\":\"local_encrypted\",\"value\":\"$BOT_TOKEN\"}"

curl -X POST "$PAPERCLIP_PUBLIC_URL/api/companies/$COMPANY_ID/secrets" \
  -H "Content-Type: application/json" \
  --cookie-jar /tmp/board-cookies.txt \
  -d "{\"name\":\"slack.channel_id\",\"provider\":\"local_encrypted\",\"value\":\"$CHANNEL_ID\"}"

curl -X POST "$PAPERCLIP_PUBLIC_URL/api/companies/$COMPANY_ID/secrets" \
  -H "Content-Type: application/json" \
  --cookie-jar /tmp/board-cookies.txt \
  -d "{\"name\":\"slack.board_channel_id\",\"provider\":\"local_encrypted\",\"value\":\"$BOARD_CHANNEL_ID\"}"
```

> Suosittu tapa: Paperclip-UI:n **Secrets**-osio jokaiselle yritykselle.

## 4. Varmista että bot kuuluu kanavalle

Slack `chat.postMessage` ei toimi kanavissa joihin botti ei ole liittynyt. Varmista jokaisesta kanavasta:

```text
/invite @Paperclip
```

## 5. Smoke-testi

Käynnistä server uudelleen (`pnpm dev` tai docker restart):

```
[INFO] slack event forwarder started
```

Kun jokin näistä eventeistä tapahtuu, viesti pitäisi näkyä Slackissä:

| Event | Mistä | Mihin kanavaan |
|-------|-------|----------------|
| `activity.logged` type=`budget.exceeded` | Budjetti ylittyy | `#yritys-kanava` + `#rk9-board` |
| `agent.status` → terminated/error | Agentti kaatuu | `#yritys-kanava` |
| `heartbeat.run.status` failed (3+ peräkkäin) | Agent runs failavat | `#yritys-kanava` |

Risk Management -järjestelmän eventit (`risk.entry.created`, `risk.incident.created`) lisätään myöhemmässä PR:ssä, kun Risk Management -koodi on master:ssa.

## 6. Vianetsintä

| Oire | Tarkista |
|------|----------|
| Ei lokia "slack event forwarder started" | Server ei käynnistynyt uudelleen, tai `index.ts`-init-koodi blokkautuu aiempaan vaiheeseen |
| Loki "slack postMessage failed" `errorCode: not_in_channel` | Kutsu botti kanavaan: `/invite @Paperclip` |
| Loki `errorCode: invalid_auth` | Bot token vanhentunut tai väärä — uusi `slack.bot_token`-secret |
| Loki `errorCode: channel_not_found` | Channel ID väärin tallennettu, tarkista `slack.channel_id` |
| Ei mitään lokia eikä viestejä | Secret puuttuu (`slack.channel_id` tai `slack.bot_token`) → forwarder skip-aa quietisti |

## 7. Disabled-tila

Slack-integraatio voidaan disabloida yritykseltä yksinkertaisesti **poistamalla `slack.bot_token`-secret** kyseiseltä yritykseltä. Forwarder havaitsee puuttuvan tokenin ja skip-aa kaikki viestit kyseiselle yritykselle (ei virhettä).

## Mikä Vaihe 1 toteuttaa

- ✅ Outbound notifications eventeistä → Slack-kanaviin
- ✅ Per-company channel routing
- ✅ Cross-company `#rk9-board` budjettiylityksille
- ✅ Heartbeat-failure threshold (3 peräkkäistä failureä ennen ilmoitusta)
- ✅ Debounce 30s sama event ei tuplaviestiä

## Mikä Vaihe 2 toteuttaa

- ✅ `approval.created` → company-kanavaan 3 napilla (Approve / Reject / Request revision) + "Open in Paperclip" -linkki
- ✅ Approve klikkaus toimii suoraan; Reject ja Request revision avaavat modaalin pakollisella perustelulla
- ✅ `approval.decided` päivittää alkuperäisen viestin (`chat.update`) napit "Approved by Mauri 14:32 — _decision note here_" -tekstiksi
- ✅ Slack user → Paperclip user matchataan sähköpostilla (`users.info` → `authUsers.email`)
- ✅ HMAC-SHA256-signature-verify Slackin standardin mukaan (`SLACK_SIGNING_SECRET`)
- ✅ Idempotency: `X-Slack-Retry-Num` -retry palauttaa 200 OK ilman duplikaattikäsittelyä

### Käyttöönotto Vaiheessa 2

1. **Manifest-päivitys**: Slack App-asetuksissa → **App Manifest** → lisää yllä oleva `interactivity`-blokki ja `users:read.email`-scope (vaatii reinstallin jos uusi scope)
2. **`SLACK_SIGNING_SECRET` env-var**: kopioi App Credentials-välilehdeltä **Signing Secret** ja lisää server-prosessin env-muuttujiin. Tuotannossa env-varit asetetaan `/usr/local/bin/paperclip-start.sh`-tiedostossa:
   ```bash
   export SLACK_SIGNING_SECRET=abcdef0123456789abcdef0123456789
   ```
   Restart paperclip.service jälkeen route `/api/slack/interactions` aktivoituu. Ilman tätä endpoint vastaa 503.
3. **Sama Signing Secret** on hyvä tallentaa myös company-secrettinä `slack.signing_secret`-nimellä Vaihe 1:n yhteydessä — env-var on Vaiheessa 2 ensisijainen, mutta secret pidetään yhteensopivuuden vuoksi.
4. **Endpoint**: route on `POST /api/slack/interactions` kaikissa deployment-tiloissa. Tuotannossa Slack hittaa `https://paperclip.rk9.fi/api/slack/interactions` → server-prosessi.

## Mikä Vaihe 3-4 lisää (myöhemmin)

- **Vaihe 3**: `/paperclip <command>` slash-komennot (status, assign, pause-agent, ...)
- **Vaihe 4**: Daily digest `#rk9-board`-kanavalla aamuisin (cross-company KPI:t)
