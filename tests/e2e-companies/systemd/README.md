# systemd-asennus E2E-companies-rutiinille

## Asenna

```bash
sudo cp tests/e2e-companies/systemd/paperclip-e2e-companies.service /etc/systemd/system/
sudo cp tests/e2e-companies/systemd/paperclip-e2e-companies.timer /etc/systemd/system/

# Env-tiedosto API-tunnukselle (luo myöhemmin kun PAPERCLIP_API_KEY saatavilla)
sudo tee /etc/default/paperclip-e2e-companies > /dev/null <<'EOF'
# PAPERCLIP_API_KEY=...      # Aseta tämä ennen kuin issuet luodaan oikeasti
# E2E_COMPANIES_REPORT_URL=https://nginx.rk9.fi/e2e-reports/latest
EOF

# Persist-hakemiston omistus rk9adminille (joka unit ajaa)
sudo install -d -o rk9admin -g rk9admin /var/www/e2e-reports

sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-e2e-companies.timer
sudo systemctl status paperclip-e2e-companies.timer
```

## Aja käsin (debug)

```bash
sudo systemctl start paperclip-e2e-companies.service
sudo journalctl -u paperclip-e2e-companies.service -f
```

## Ajoaikataulu

`OnCalendar=Mon *-*-* 05:00:00 Europe/Helsinki` — joka maanantai 05:00 Suomen aikaa, +random 0-10 min.
`Persistent=true` — jos kone on ollut alhaalla ajohetkellä, se ajaa heti boot-up jälkeen.

## Poisto

```bash
sudo systemctl disable --now paperclip-e2e-companies.timer
sudo rm /etc/systemd/system/paperclip-e2e-companies.{service,timer}
sudo rm /etc/default/paperclip-e2e-companies
sudo systemctl daemon-reload
```
