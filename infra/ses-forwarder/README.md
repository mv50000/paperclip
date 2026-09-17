# rk9-ses-forwarder

AWS Lambda function that forwards mail received via SES (for `sunspot.fi`,
`ololla.fi`, `saatavilla.fi`) to a real mailbox. Runs as a Lambda *action* on
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
- Env vars: `BUCKET` (default `rk9-ses-inbound`), `FORWARD_TO` (comma-separated
  destination addresses, default `mikko-ville.lahti@rk9.fi`).
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
   DKIM-verified `forwarder@<domain>` identity carrying the original
   sender in the display name, and adds `X-Original-From` /
   `X-Original-To`.
4. Sends the rewritten message via SES `SendRawEmail` to `FORWARD_TO`.

See the file-header comment in `index.mjs` for the two changes'
history (2026-08-08 spam-poisoning fix, 2026-09-17 dangling-boundary fix).

## Deploying

```bash
cd infra/ses-forwarder
./deploy.sh
```

This zips `index.mjs` alone and runs `aws lambda update-function-code`. No
`node_modules` are bundled — the `nodejs20.x` Lambda runtime already provides
`@aws-sdk/client-s3` and `@aws-sdk/client-ses` (confirmed against the
currently deployed zip, which likewise contains only `index.mjs`). The
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
