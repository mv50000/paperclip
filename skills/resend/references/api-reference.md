# Resend skill — API reference

All endpoints scoped to `/api/companies/:companyId/email/...` and require:
`Authorization: Bearer $PAPERCLIP_API_KEY` and (for mutations)
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`.

## POST /email/send

Send a new outbound email.

Request:
```json
{
  "routeKey": "support",
  "to": ["customer@example.com"],
  "cc": [],
  "subject": "...",
  "bodyMarkdown": "...",
  "replyTo": "tuki@ololla.fi",
  "templateKey": null,
  "templateVars": {},
  "escalateToCeo": false
}
```

Response (202):
```json
{ "messageId": "uuid", "providerMessageId": "em_msg_..." }
```

Errors:
- 403 `{reason: "domain_not_verified"}` — DKIM/SPF/DMARC not all passing
- 403 `{reason: "suppressed", addresses: ["..."]}` — recipient on suppression list
- 403 `{reason: "rate_limit", scope: "agent" | "company"}` — daily quota exceeded
- 400 `{reason: "header_injection", field: "subject"}` — CRLF detected
- 400 `{reason: "unknown_route_key"}` — route not configured for this company

## POST /email/reply

Reply in an existing thread. Reuses the original sender, subject (with `Re:` prefix
if needed), and message-id headers for threading.

Request:
```json
{
  "inReplyToMessageId": "uuid",
  "bodyMarkdown": "...",
  "escalateToCeo": false
}
```

Response: same as `/send`.

## GET /email/messages/:messageId

Returns the metadata-only view (no body, no attachments).

```json
{
  "id": "uuid",
  "direction": "inbound" | "outbound",
  "providerMessageId": "...",
  "fromAddress": "...",
  "toAddresses": ["..."],
  "subject": "...",
  "status": "received" | "sent" | "bounced" | "complained" | "failed",
  "receivedAt": "...",
  "sentAt": "...",
  "attachmentCount": 2,
  "bodyLength": 1842,
  "issueId": "uuid"
}
```

## GET /email/messages/:messageId/body

Returns the body wrapped in `<untrusted_email_body>` tags. ACL: caller must be
the assigned agent or the company CEO. See `security.md` for the contract.

```json
{
  "messageId": "uuid",
  "providerMessageId": "...",
  "wrapped": "<untrusted_email_body ...>...</untrusted_email_body>",
  "format": "text",
  "attachments": [{ "id": "uuid", "filename": "...", "contentType": "...", "sizeBytes": N }]
}
```

## GET /email/attachments/:attachmentId

Streams the attachment binary. Same ACL as body. Vaihe 6 lisää ClamAV-tarkistuksen
ennen palautusta.

## GET /email/suppression

List the company's suppression entries.

## POST /email/suppression

Add an address to the suppression list.

```json
{ "address": "customer@example.com", "reason": "manual" }
```

## DELETE /email/suppression/:id

Remove an entry (rare; use sparingly — the address probably hard-bounced for a reason).

## POST /email/escalate

Escalate an inbound issue to the CEO.

```json
{
  "messageId": "uuid",
  "reason": "Asiakas vaatii hyvitystä, oma autonomia ei riitä",
  "ccCustomer": false
}
```

Sends a copy of the metadata + your justification to the company's configured
CEO email (mv@rk9.fi by default).
