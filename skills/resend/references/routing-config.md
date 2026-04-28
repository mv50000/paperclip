# Routing configuration

Inbound email is routed to a specific agent based on the local-part (the
portion before `@`) and the domain. Configuration lives in the `email_routes`
table.

## Per-company setup

Each row maps `(company_id, local_part, domain)` to a route. Example for Ololla:

| local_part | domain     | route_key  | assigned_agent | auto_reply_template_id  | escalate_after_hours |
|------------|------------|------------|----------------|-------------------------|----------------------|
| `tuki`     | ololla.fi  | support    | aski-uuid      | tpl-auto-reply-support  | 24                   |
| `kaisa`    | ololla.fi  | accounting | kaisa-uuid     | tpl-auto-reply-accounting | 48                 |
| `noreply`  | ololla.fi  | noreply    | (null)         | (null)                  | (n/a)                |
| `*`        | ololla.fi  | catch-all  | aski-uuid      | (null)                  | 24                   |

Notes:
- `local_part = '*'` is a catch-all for the domain. Place specific routes
  before the catch-all (the matcher prefers exact matches).
- `route_key` is what agents pass to `/email/send` to set the `From:` address.
  Server builds `From:` as `${route_key}@${sending_domain}`.
- `assigned_agent_id = NULL` means "no inbound; outbound only" (for `noreply`).
- If `escalate_after_hours` elapses without the issue being resolved, the
  escalation cron sends a notification to the company CEO.

## Adding a new route

Use the Paperclip API (when implemented in Vaihe 2) or insert directly:

```sql
INSERT INTO email_routes
  (company_id, local_part, domain, route_key, assigned_agent_id, escalate_after_hours)
VALUES
  ($1, 'sales', 'askelmerkki.fi', 'sales', $sales_agent_id, 24);
```

## Domain configuration prerequisites

Before any route works:
1. The domain must exist as a verified Resend domain (Dashboard → Add Domain
   → set up DKIM/SPF/DMARC TXT records and an MX record pointing to Resend's
   inbound endpoint).
2. `company_email_config` must have a row for the company with
   `status='verified'` and the matching `primary_domain`.
3. `resend.api_key` and `resend.signing_secret` must be present in
   `company_secrets` for the company.

See `/doc/RESEND-SETUP.md` for the step-by-step process.
