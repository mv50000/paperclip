# rk9-ses-forwarder

AWS Lambda function that routes mail received via SES (for `sunspot.fi`,
`ololla.fi`, `saatavilla.fi`) per recipient address: to Aava's mailbox
(`aava@rk9.fi`) or to S3 only ([RK9-874](/RK9/issues/RK9-874)). Runs as a Lambda *action* on
each domain's SES receipt rule, after the S3 action — so the raw `.eml` is
always in `s3://rk9-ses-inbound` (under the domain's key prefix) before this
function ever runs, and a failure here never loses the message.

Until [RK9-236](/RK9/issues/RK9-236) this source lived only as a deployed AWS
zip plus a one-off manual backup — no repo, no diff, no review, no tests.
This directory is now the source of truth; the deployed code and this
directory must be kept in sync (see **Deploying** below).

## Runtime

- Node.js 20.x (`nodejs20.x`), handler `index.handler`.
- Region: `eu-north-1` (`AWS_REGION` env var, defaults to it if unset).
- Code: `index.mjs` (handler, rewrite), `routing.mjs` (routing table logic,
  no AWS dependencies), `routes.json` (the routing table). All three go into
  the zip.
- Env vars:
  - `BUCKET` (default `rk9-ses-inbound`).
  - `ROUTED_DOMAINS`: rollout switch. Unset, empty or `*` means every domain
    uses `routes.json` (the final state). A comma list (`sunspot.fi,ololla.fi`)
    means only those domains do.
  - `FORWARD_TO`: legacy only. A domain that is *not* in `ROUTED_DOMAINS`
    still forwards everything to this comma-separated list. It has no default
    any more: if it is empty for such a domain, the message stays in S3 and
    the Lambda logs an error. Remove it once all three domains are routed.
- Receipt rule's S3 action `ObjectKeyPrefix` must match the `PREFIX` map in
  `index.mjs` (empty for `sunspot.fi`, `ololla/` and `saatavilla/` for the
  other two domains).

## What it does

1. Reads the SES receipt event's spam/virus verdicts. An explicit `FAIL`
   drops the message (it stays in S3, never forwarded). Anything else —
   `PASS`, `GRAY`, `PROCESSING_FAILED`, or `DISABLED` (scanning off) —
   forwards, so a config change elsewhere can never start silently
   swallowing mail.
2. Fetches the raw `.eml` from S3.
3. Rewrites the envelope: strips the inbound hop's own authentication/SES
   bookkeeping headers (`Authentication-Results`, `Received-SPF`,
   `X-SES-*`, ARC headers), replaces `From`/`Reply-To` with a
   DKIM-verified identity
   `"<original name or address> via <domain>" <forwarder@<domain>>`
   (RFC 2047-encoded when the name is not ASCII), sets `Reply-To` and
   `X-Original-From` to the original `From`, and sets `X-Original-To` to the
   address(es) the message arrived at. The sender's own `Reply-To` (for
   example a contact form's customer address) is kept as
   `X-Original-Reply-To`. SES gives the forwarded copy a new `Message-ID`,
   so the original one is kept as `X-Original-Message-ID` (angle brackets
   included) for reply threading ([RK9-930](/RK9/issues/RK9-930)). It is
   copied only when the message has exactly one `Message-ID` whose value fits
   one line, has the form `<left@right>` (printable ASCII, no whitespace) and
   is at most 975 characters (the header line stays within 998 octets);
   otherwise it is left out and the message is still forwarded.
   `In-Reply-To` and `References` pass through unchanged. Every inbound
   `X-Original-*` header (`X-Original-To`, `X-Original-Message-ID`, …) is
   dropped, so a sender cannot fake one: only the forwarder writes that family.
   Every copied value is stripped of CR/LF.
4. Looks up each recipient in `routes.json` (see **Routing** below) and sends
   one rewritten copy per target via SES `SendRawEmail`. Recipients routed to
   `s3-only` are logged (`S3-ONLY …`) and not forwarded.

See the file-header comment in `index.mjs` for the change history
(2026-08-08 spam-poisoning fix, 2026-09-17 dangling-boundary fix,
2026-11-15 per-address routing).

## Routing

`routes.json` maps an address to a target:

```json
{
  "targets": { "aava": ["aava@rk9.fi"] },
  "default": "aava",
  "routes": { "hei@sunspot.fi": "aava", "tls-rpt@ololla.fi": "s3-only", "dmarc*@ololla.fi": "s3-only" }
}
```

- A target name maps to destination addresses. `s3-only` is reserved: keep
  the raw `.eml` in S3 and forward nothing.
- Lookup order: exact address, the address without its `+tag`, the longest
  `prefix*@domain` match, then `default`. Matching ignores case.
- Keys that start with `$` are comments.
- `routing.mjs` `parseRoutes()` rejects the whole table on any defect: an
  unknown target, a malformed address, a route for a domain this Lambda does
  not serve, two keys that differ only by case, or a destination on one of the three SES domains
  (mail loop). A rejected or missing table never falls back to any address:
  each routed message fails with `FAIL … routing:` in CloudWatch and stays in
  S3. `deploy.sh` and the tests validate the table before it ships.
  `JSON.parse` keeps the last of two identical keys without an error, so
  `deploy.sh` and the tests also reject a key that occurs twice
  (`findDuplicateKeys()`).
- `forwarder@<domain>` is `s3-only`: it is the envelope sender of every
  forwarded copy, so a bounce from the destination lands there. Forwarding
  it would loop while the destination bounces.
- The apps' sender addresses (`noreply@saatavilla.fi`, `no-reply@sunspot.fi`,
  `noreply@ololla.fi`, `no-reply@ololla.fi`) route to Aava, so a bounce of a
  failed customer email is seen: Aava's watcher bundles bounces into the
  morning digest (RK9-888). This cannot loop: the forwarded copy's envelope
  sender is `forwarder@<domain>`, so a bounce from Aava's mailbox lands in S3.
- The current table follows the RK9-870 inventory, section 1, except the
  four app sender addresses above (RK9-888). The operator's personal
  address is not a destination for any address.
- Open before the ololla.fi switch: the inventory marks the prod value of
  `kaisa@ololla.fi` (migration 082) as unverified. It routes to Aava by
  default here; check it on rk9-prod before adding `ololla.fi` to
  `ROUTED_DOMAINS`.

## Rollout (one domain at a time) and rollback

The parent session deploys after merge. The code is not deployed by the PR.
Use `AWS_PROFILE=rk9-admin` (the `default` profile needs `aws login`).

`update-function-configuration --environment` replaces the whole variable
map, so always merge into the current one:

```bash
F=rk9-ses-forwarder
set_env() {  # usage: set_env '{"ROUTED_DOMAINS":"sunspot.fi"}'
  aws lambda get-function-configuration --function-name $F --query Environment.Variables --output json \
    | jq -c --argjson add "$1" '{Variables: (. + $add)}' > /tmp/fwd-env.json
  aws lambda update-function-configuration --function-name $F --environment file:///tmp/fwd-env.json > /dev/null
  aws lambda wait function-updated --function-name $F
}
```

1. Set the switch first, while the old code still runs (it ignores the
   variable): `set_env '{"ROUTED_DOMAINS":"sunspot.fi"}'`. Keep `FORWARD_TO`.
2. Deploy the code: `./deploy.sh`. It validates `routes.json` and saves the
   old zip and configuration to `~/rk9-mail-backup/<timestamp>/` first.
3. Send a test message to every routed address of that domain. Confirm it
   arrives in Aava's inbox and that CloudWatch shows
   `OK forwarded … target=aava -> aava@rk9.fi`; an `s3-only` address shows
   `S3-ONLY …`.
4. Add the next domain: `set_env '{"ROUTED_DOMAINS":"sunspot.fi,ololla.fi"}'`,
   test again, then `saatavilla.fi`.
5. Final state: `set_env '{"ROUTED_DOMAINS":"*"}'`, then drop `FORWARD_TO`:

   ```bash
   aws lambda get-function-configuration --function-name $F --query Environment.Variables --output json \
     | jq -c '{Variables: (del(.FORWARD_TO))}' > /tmp/fwd-env.json
   aws lambda update-function-configuration --function-name $F --environment file:///tmp/fwd-env.json > /dev/null
   aws lambda wait function-updated --function-name $F
   ```

Before step 1, confirm that `FORWARD_TO` is set in the live configuration
(`aws lambda get-function-configuration --function-name $F --query
Environment.Variables`). A domain outside `ROUTED_DOMAINS` with no
`FORWARD_TO` fails loudly and keeps its mail in S3. Also send one test
message straight to `aava@rk9.fi` first: a bouncing destination stops all
forwarding.

Rollback:

- One domain: remove it from `ROUTED_DOMAINS`. It goes back to `FORWARD_TO`
  with no redeploy (`FORWARD_TO` must still be set).
- Everything: `aws lambda update-function-code --function-name $F --zip-file
  fileb://~/rk9-mail-backup/<timestamp>/lambda-code-BEFORE.zip`, then restore
  the variables (the old code ignores a leftover `ROUTED_DOMAINS`). Lambda
  refuses a configuration update while the code update runs, so wait first:

  ```bash
  aws lambda wait function-updated --function-name $F
  jq -c '{Variables: .Environment.Variables}' ~/rk9-mail-backup/<timestamp>/lambda-config-BEFORE.json > /tmp/fwd-env.json
  aws lambda update-function-configuration --function-name $F --environment file:///tmp/fwd-env.json > /dev/null
  aws lambda wait function-updated --function-name $F
  ```

Messages forwarded nowhere during a fault are not lost: replay them from
`s3://rk9-ses-inbound/<prefix><messageId>`.

## Spam and virus scanning (`ScanEnabled`)

The code never changes SES rules. The vault note
`sunspot/areas/ses_forwarder_shared_from_poisons_sender_reputation.md` says
scanning was turned on for all three rules on 2026-08-08. Check it:

```bash
aws ses describe-active-receipt-rule-set --region eu-north-1 \
  --query 'Rules[].{Name:Name,ScanEnabled:ScanEnabled,Recipients:Recipients}'
```

If a rule shows `false`, enable it (repeat per rule name):

```bash
RULE=<rule name>
aws ses describe-receipt-rule --region eu-north-1 --rule-set-name rk9-inbound --rule-name "$RULE" --query Rule \
  | jq '.ScanEnabled = true' > /tmp/rule-scan.json
aws ses update-receipt-rule --region eu-north-1 --rule-set-name rk9-inbound --rule file:///tmp/rule-scan.json
```

## Deploying

```bash
cd infra/ses-forwarder
./deploy.sh
```

This validates `routes.json`, backs up the deployed code and configuration,
zips `index.mjs`, `routing.mjs` and `routes.json`, and runs
`aws lambda update-function-code`. No
`node_modules` are bundled — the `nodejs20.x` Lambda runtime already provides
`@aws-sdk/client-s3` and `@aws-sdk/client-ses` (confirmed against the
deployed zip before RK9-874, which contained only `index.mjs`). The
`dependencies` in `package.json` exist so `npm test` can run the same
imports locally. Requires an authenticated AWS session
(`aws sts get-caller-identity`) with permission to update the function.

To pull the *currently deployed* code back down for comparison (e.g. to
check this directory hasn't drifted from prod):

```bash
aws lambda get-function --function-name rk9-ses-forwarder --query Code.Location --output text | xargs curl -s -o /tmp/deployed.zip
unzip -p /tmp/deployed.zip index.mjs | diff - index.mjs
```

## Testing

```bash
npm install
npm test
```

`fixtures/virus-quarantine-dsn.eml` is a redacted real bounce (AWS internal
receipt/signature tokens replaced with placeholders) that reproduced
[RK9-236](/RK9/issues/RK9-236): SES's virus quarantine truncates a DSN's
embedded `message/rfc822` copy down to bare headers, leaving a
`Content-Type: multipart/mixed; boundary="raja1"` declaration whose boundary
never actually appears. Forwarding that verbatim made SES's own
`SendRawEmail` reject the whole message with
`InvalidParameterValue: Missing start boundary` — the bounce was silently
dropped (never delivered, though still recoverable from S3).
