---
title: Multi-User Board Access
summary: Invite additional humans to a company and manage their roles
---

A Paperclip company can host multiple human board users. Each user signs in with their own email/password, gets a session cookie, and sees only the companies they have a membership in. This page covers the operator-facing flow; the technical model is in [Architecture](#architecture) below.

## Roles

Four human roles are defined in `HUMAN_COMPANY_MEMBERSHIP_ROLES`:

| Role     | Capabilities (permission grants)                                              |
|----------|-------------------------------------------------------------------------------|
| `owner`  | `agents:create`, `users:invite`, `users:manage_permissions`, `tasks:assign`, `joins:approve` |
| `admin`  | `agents:create`, `users:invite`, `tasks:assign`, `joins:approve`              |
| `operator` | `tasks:assign`                                                              |
| `viewer` | read-only (no mutating permissions)                                           |

Roles are stored on `company_memberships.membership_role`. The owner of a company is the user who accepted the bootstrap CEO invite (or any user later promoted by an existing owner).

## Inviting another user

In the web UI, open **Company → Access → Invites** and click **New invite**. Choose:

- **Allowed join type** — `human` for a board user (use `agent` to onboard an agent, `both` for either)
- **Human role** — the role granted on accept (`admin`, `operator`, `viewer`; an `owner` invite requires an existing owner)
- **Expires** — invites default to a short-lived window

The invite returns an `inviteUrl`. Share it with the invitee. They:

1. Open the URL → land on `/invite/:token` (`InviteLanding`)
2. Sign up or sign in (`/auth` — better-auth email/password)
3. Confirm the join → membership row is created with the chosen role and `status: "active"`

After acceptance the new user sees the company in their sidebar and can act according to their role.

## Managing members

**Company → Access → Members** lists all human and agent principals for the company. From here an owner/admin can:

- Change a member's role (`PATCH /api/companies/:companyId/members/:userId`)
- Deactivate a member (sets `status: "inactive"` — login still works but the company drops from `req.actor.companyIds`)
- Remove a member (deletes the membership row; the user retains their auth account)

The last active `owner` cannot be removed or demoted — `getProtectedMemberReason` enforces this.

## Architecture

### Data model

| Table                  | Purpose                                              |
|------------------------|------------------------------------------------------|
| `auth_users`           | Identity record (id, email, name, emailVerified)     |
| `auth_sessions`        | Better-auth session tokens (cookie-backed)           |
| `company_memberships`  | `(companyId, principalType, principalId)` — links a user (or agent) to a company with a role and active/inactive status |
| `permissions`          | Per-membership permission grants (derived from role) |
| `instance_admins`      | Cross-company instance-level admins                  |

### Authentication

- **Sessions** — `server/src/auth/better-auth.ts` wires better-auth with email/password. Session cookies are prefixed `paperclip-{instanceId}` so multiple instances on the same host stay isolated.
- **Board API keys** — `pcp_board_*` tokens (`server/src/services/board-auth.ts`) for CLI/programmatic use; bound to a single user.
- **Agent JWTs** — agents authenticate via short-lived JWTs (`PAPERCLIP_API_KEY` in agent env); orthogonal to human auth.

### Authorization

Every company-scoped route calls `assertCompanyAccess(req, companyId)` (`server/src/routes/authz.ts`):

- For board users, it checks `req.actor.companyIds` (populated from active memberships on each request).
- For mutations it additionally requires `status === "active"` and `membershipRole !== "viewer"`.
- Sensitive actions call `assertCompanyPermission(req, companyId, "<permission-key>")` for fine-grained checks (e.g. `users:invite`).

`req.actor` carries `userId`, `userEmail`, `companyIds`, `memberships[]`, and `isInstanceAdmin` — sufficient for any handler to decide what the current user may do.

### Invite flow

1. `POST /api/companies/:companyId/invites` — creates an invite row, returns a one-time token (hashed at rest).
2. `GET /api/invites/:token` — public summary used by `InviteLanding`.
3. `POST /api/invites/:token/accept` — authenticated user accepts; the server creates a `joinRequests` row and (for human/auto-approved invites) immediately upserts the `company_memberships` row with the role from `invite.defaultsPayload.human.role`.
4. Activity is logged via `activityLog` with `actorType: "user"`.

### UI surface

| Page                       | Purpose                                       |
|----------------------------|-----------------------------------------------|
| `Auth.tsx`                 | Sign in / sign up                             |
| `BoardClaim.tsx`           | First-run bootstrap (claims instance + first owner) |
| `CompanyAccess.tsx`        | Members list, role changes, removals          |
| `CompanyInvites.tsx`       | Create / list / revoke invites                |
| `InviteLanding.tsx`        | Public invite-acceptance page                 |
| `JoinRequestQueue.tsx`     | Owner/admin approves pending join requests    |
| `InstanceAccess.tsx`       | Instance admin: cross-company user directory  |

## Known limitations

These should be tracked as follow-ups when the feature is promoted from spike to GA:

1. **No SSO / OAuth** — only email+password today.
2. **No password reset UI** — better-auth exposes the endpoint but the UI is unwired.
3. **No granular permission editor** — roles are coarse-grained presets; per-permission overrides exist in the schema but are not surfaced in the UI.
4. **Activity attribution** — most user-attributed `createdByUserId` fields exist, but a few legacy endpoints still write `actorType: "user"` with the literal `"board"` id when no session is present (local-implicit mode).
5. **Real-time presence** — no UI indicator of which other users are currently viewing the same issue/board.
6. **Audit-log filter by user** — `activityLog` stores `actorId` per entry but the UI lacks a filter chip.

See child issues of SEC-90 for the punch list.
