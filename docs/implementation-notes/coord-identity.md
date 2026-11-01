# Coord actor identity, scoped credentials and tailnet route (ADR, RK9-621)

Part of epic [RK9-620](/RK9/issues/RK9-620), wave 1, key `coord-identity`.
This ADR decides who may write to the coordination API and as which actor.
It freezes the names that every later child of the epic uses.

**Operator approval:** 2026-11-01, Mikko-Ville Lahti (operaattori; kirjattu orkestroijan kautta Claude-sessiosta), ehdolla: operator-kind vain verified-istunnolla (toteutettu tässä PR:ssä).

> coord-schema ([RK9-623](/RK9/issues/RK9-623)) must not merge before the
> operator approval line above is filled in. The operator fills it in with a
> separate commit. Nobody else edits that line.

## Status and scope

- Status: accepted with a condition, 2026-11-01 (see the approval line above).
- This child (RK9-621) ships the ADR, the shared contract module, the coord
  router skeleton and the actor middleware.
- RK9-623 ships the `rk9_coord_tokens` table and the migration. It also ships
  the `rk9_coord_` bearer resolution in `server/src/middleware/auth.ts`, the
  token service, the issue/rotate/revoke command and the global
  deny-by-default guard. The scope correction on RK9-621 (1.11.2026) moved
  that work.
- RK9-621 proves the token rules against this contract only. The middleware
  already resolves a token principal, and tests cover it with a stub
  principal (`server/src/__tests__/rk9-coord-auth.test.ts`).

## Context

- Every interactive session on paperclip-01 uses the same `pcp_board_` key:
  the operator's instance-admin board key. The server cannot tell those
  sessions apart.
- Board keys are per user. Any signed-in user can mint one
  (`POST /api/board-api-keys`). A board key alone therefore proves neither
  operator authority nor the host it is used on.
- Paperclip agents authenticate with agent keys or run JWTs.
- Other hosts, rk9claude (skynet, CT 342) and Grok have no Paperclip
  principal.
- The board key is a full-control operator credential. It must never leave
  paperclip-01 (epic RK9-323, SoD/POLP).

## Decision summary

1. Every coord call names one **actor** with an `actor_id` from a closed
   grammar. The server resolves the actor from the credential and the
   `X-RK9-Actor` header.
2. The server derives the actor wherever the credential allows it. Agent
   callers are always `agent_run:<runId>`: verified with a run JWT,
   attributed with an agent key. A signed-in admin session is always
   `operator`. A service token is always its own service.
   **`operator` exists only behind a signed-in instance-admin session**
   (trust `verified`). This is the condition of the operator's approval
   (2026-11-01). AI sessions always act as their own kind.
3. Only an instance-admin board key may call coord routes. When
   `RK9_COORD_BOARD_KEY_IDS` is set, the key id must also be on that list
   (recommended: the id of the operator key the paperclip-01 sessions use).
   The server logs `rk9_coord_board_key_pin_unset` at startup while the pin
   is unset.
   Board-key callers may claim `cc`, `worktree`, `headless` and `orch` only.
   Board key + `X-RK9-Actor: operator` is 403
   (`rk9_coord_operator_requires_session`). Board-key claims are
   **attributed**: the server attributes them to paperclip-01 by policy and
   trusts the session part as stated.
4. Remote hosts get a **per-host coord token** bound to one company and one
   host. They reach `:3100` directly over the tailnet. Grok reaches the API
   only through the vault-mcp proxy, which holds the `grok` service token.
   This is operator decision Q1.
5. Company scope comes only from an authenticated principal. It never comes
   from a loopback caller, a 127.0.0.1 fallback or `local_trusted` mode
   (RK9-616).

## Frozen names

The machine-readable copy lives in `packages/shared/src/rk9-coord.ts`. Change
a name only in both places, and never after RK9-623's migration has been
applied anywhere: fork migrations are hash-pinned.

### Tables

All tables are RK9-only, 9000-series, and created by RK9-623 alone.

| Table | Purpose |
|---|---|
| `rk9_coord_actors` | Presence: one row per actor |
| `rk9_coord_leases` | TTL leases with fencing tokens |
| `rk9_coord_lease_waiters` | FIFO wait queue per resource |
| `rk9_coord_events` | Append-only journal; `bigserial` id is the cursor |
| `rk9_coord_cursors` | Per-actor last seen event id |
| `rk9_coord_inbox` | Messages for actors that are not live |
| `rk9_coord_tokens` | Hashed coord tokens (column list below) |
| `rk9_coord_escalations` | Telegram escalation ledger |

`rk9_coord_tokens` columns (RK9-623 implements exactly these):

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `company_id` | uuid NOT NULL | FK `companies(id)` ON DELETE cascade |
| `principal_kind` | text NOT NULL | CHECK in (`host`, `service`) |
| `principal_name` | text NOT NULL | host: DNS label `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`; service: `rk9claude` or `grok` |
| `token_hash` | text NOT NULL UNIQUE | sha256 hex of the full token; plaintext is never stored |
| `token_prefix` | text NOT NULL | first 14 characters (`rk9_coord_` + 4), for display only |
| `scope` | text NOT NULL DEFAULT `coord` | CHECK in (`coord`) |
| `label` | text | free text, ≤ 200 |
| `created_by_user_id` | text | board user that issued it |
| `rotated_from_token_id` | uuid | FK `rk9_coord_tokens(id)` ON DELETE set null |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `last_used_at` | timestamptz | updated on use |
| `expires_at` | timestamptz | null = no expiry |
| `revoked_at` | timestamptz | non-null = revoked |

Index: a partial unique index on (`company_id`, `principal_kind`,
`principal_name`) WHERE `revoked_at IS NULL`. Each host or service has at most
one active token.

### Actor kinds and actor_id grammar

Kind enum (closed): `cc | worktree | headless | agent_run | orch | remote |
rk9claude | grok | operator`.

| Kind | actor_id | Part grammar |
|---|---|---|
| cc | `cc:<host>:<sessionId>` | host = lower-case DNS label ≤ 63; sessionId = `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` |
| worktree | `worktree:<issue>` | issue = `[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}` (e.g. `RK9-621`) |
| headless | `headless:<run>` | run = same as sessionId |
| agent_run | `agent_run:<runId>` | runId = lower-case UUID (heartbeat run id) |
| orch | `orch:<name>` | name = `[a-z0-9][a-z0-9._-]{0,62}` |
| remote | `remote:<host>` | host = lower-case DNS label |
| rk9claude | `rk9claude` | literal |
| grok | `grok` | literal |
| operator | `operator` | literal |

- An actor_id is at most 200 characters.
- The server compares it verbatim. Surrounding whitespace, upper-case hosts
  and a comma-joined list (two headers) are malformed.
- The header is `X-RK9-Actor`. It is not a secret and stays visible in logs.

### Other frozen names

- Lease resource prefixes: `prod | migrate | repo | vault | host`, as
  `<prefix>:<name>`. Hard-gate prefixes are `prod`, `migrate` and `host`.
- Event types: `decision | deploy | handoff | blocker | done | ask-operator |
  lease | phase | break-glass | decision-vaulted | escalated`.
- Route prefix: `/api/companies/:companyId/rk9/coord/*`.
- Coord token: `rk9_coord_` + 43 base64url characters (32 random bytes).
- Reserved header `X-RK9-Coord-Token`: the server never reads it. The HTTP
  logger redacts it in case a client sends the token there.
- Trust levels: `verified | attributed | unverified`.

## Actor types

| Kind | Identity source | Auth principal | Liveness source | Trust | Host |
|---|---|---|---|---|---|
| cc (paperclip-01) | Claude Code session id from the hook input | board key + `X-RK9-Actor` | `rk9 status` and hook heartbeats; pid on paperclip-01 | attributed | `paperclip-01` |
| cc (other host) | Claude Code session id | host coord token + `X-RK9-Actor` | hook heartbeats over the tailnet, TTL | attributed | token host |
| worktree | issue identifier of the `/implement` worktree | board key + `X-RK9-Actor` | tmux window of the worktree session; heartbeats | attributed | `paperclip-01` |
| headless | run id of `pcp-headless-run.sh` | board key + `X-RK9-Actor` | headless process; heartbeats | attributed | `paperclip-01` |
| agent_run | `heartbeat_runs.id`, derived server-side | run JWT (signed `run_id`), or standard-scope agent key (run id from `X-Paperclip-Run-Id`, checked against `heartbeat_runs`); the run must be `running` | `heartbeat_runs.status` | verified (JWT) / attributed (agent key) | none (null) |
| orch | orchestrator name | board key + `X-RK9-Actor` | orchestrator heartbeat, TTL | attributed | `paperclip-01` |
| remote | tailnet host name | host coord token | CLI heartbeat, TTL | unverified | token host |
| rk9claude | the rk9claude service | `rk9claude` service token | service heartbeat, TTL | verified | `rk9claude` |
| grok | Grok behind vault-mcp | `grok` service token, held only by vault-mcp | TTL from the last request | unverified | `grok` |
| operator | the human operator | signed-in instance-admin session only; board key + `X-RK9-Actor: operator` is 403 | none: always reachable through Telegram | verified | none (null) |

Local `cc`, `worktree`, `headless` and `orch` actors are **attributed, not
authenticated per session**. They all share the board key. The server can
bind the host claim only for coord tokens. For the board key, the host is a
policy, not a proof: the operator key never leaves paperclip-01, and the
server narrows who can use the route with the instance-admin check and the
optional key-id pin.

## Trust model

- `verified`: the server derived the identity from a credential bound to it.
- `attributed`: the server knows the host but not the session, or the agent
  but not the run. These actors coordinate in good faith. `operator` is
  never attributed: it is always `verified`.
- `unverified`: advisory only. `grok` and every `remote:*` actor are
  unverified.
- Hard-gate leases (`prod:*`, `migrate:*`, `host:*`) need `verified` or
  `attributed` trust. An unverified actor cannot hold one without operator
  escalation. The lease engine uses `rk9CoordTrustCanHoldHardGate()` from
  `@paperclipai/shared`.
- A `cc:<host>:<sessionId>` claim through a host token is attributed: the
  token proves the host, not which session on it.
- Q5 still applies: rk9claude emergency actions are never blocked by
  `host:<node>`. They are logged only.

## Resolution rules

`server/src/middleware/rk9-coord-actor.ts` runs in front of every coord
route, including sibling sub-routers. It applies these rules in order.

1. `companyId` must be a UUID (400).
2. **RK9-616:** an anonymous request and the implicit local board of
   `local_trusted` mode are rejected with 401 before the company check.
   `assertCompanyAccess` lets the implicit local board through, so the order
   matters. Being on loopback or 127.0.0.1 never gives company scope.
3. Company access: `assertCompanyAccess` for board and agent callers.
   For a coord token, the token's `company_id` must equal `:companyId` (403).
   The company check runs before the header check for every principal.
4. A present but malformed `X-RK9-Actor` is 400 on every method.
5. A mutation (any method except GET, HEAD and OPTIONS) without an actor id
   is 400 for the board key and coord tokens. Agent and session callers have
   a derived id.
6. Per principal:
   - **Agent key or run JWT:** only a standard-scope credential qualifies;
     task-bridge and skill-test keys are 403. The run id must exist in
     `heartbeat_runs` for the same agent and company, with status `running`.
     An agent key's run id comes from `X-Paperclip-Run-Id`, which `auth.ts`
     only format-checks, so the lookup is required. The status check stops
     one key from acting as a finished run. It cannot stop a sibling run of
     the same agent that runs at the same time (up to 5 per agent), because
     the key belongs to the agent, not to one run. Agent-key actors are
     therefore `attributed`; run-JWT actors, whose `run_id` is signed, are
     `verified`. The actor is `agent_run:<runId>`. A header that differs from
     the derived id is 403 (`rk9_coord_actor_spoof`). A missing key scope is
     rejected (fail closed).
   - **Session:** only an instance admin, always `operator` (verified). Any
     other claim is 403. This is the only way to act as `operator`.
   - **Board key:** the key's user must be an instance admin, and the key id
     must be on `RK9_COORD_BOARD_KEY_IDS` when that is set (403 otherwise).
     Kinds `cc`, `worktree`, `headless` and `orch`. `operator` is 403
     (`rk9_coord_operator_requires_session`): 403, not 422, because the
     claim is well-formed and only this credential is not allowed to make it.
     A `cc` claim must name the board host (`RK9_COORD_BOARD_HOST`, default
     `paperclip-01`). Kinds `agent_run`, `remote`, `rk9claude` and `grok` are
     403. A read without a claim resolves to a null actor.
   - **Host coord token:** kinds `cc` and `remote`. The claim's host must be
     the token host (403 otherwise). A read without a claim defaults to
     `remote:<host>`.
   - **Service coord token:** only its own literal (`rk9claude` or `grok`).
   - **Any other source** (cloud tenant, cloud control, none): 401.
7. A coord token combined with another credential is 403.

Error codes in the JSON `code` field:

| Code | Status | Meaning |
|---|---|---|
| `rk9_coord_company_invalid` | 400 | `companyId` is not a UUID |
| `rk9_coord_actor_malformed` | 400 | header outside the grammar |
| `rk9_coord_actor_required` | 400 | mutation without an actor id |
| `rk9_coord_untrusted_principal` | 401 / 403 | anonymous, local implicit, non-admin session or board key, or unknown source |
| `rk9_coord_board_key_not_allowed` | 403 | board key not on `RK9_COORD_BOARD_KEY_IDS` |
| `rk9_coord_scoped_key` | 403 | task-bridge or skill-test agent key |
| `rk9_coord_actor_spoof` | 403 | claim differs from the derived actor |
| `rk9_coord_kind_not_allowed` | 403 | this credential cannot act as that kind |
| `rk9_coord_operator_requires_session` | 403 | `operator` claimed with a board key |
| `rk9_coord_host_mismatch` | 403 | claim names another host |
| `rk9_coord_agent_run_required` | 403 | agent call outside a run |
| `rk9_coord_agent_run_unbound` | 403 | run belongs to another agent or company |
| `rk9_coord_agent_run_not_live` | 403 | run is not `running` |
| `rk9_coord_wrong_company` | 403 | coord token bound to another company |
| `rk9_coord_mixed_credentials` | 403 | coord token plus another credential |
| `rk9_coord_not_found` | 404 | no such coord sub-route |

`GET /api/companies/:companyId/rk9/coord/whoami` returns the resolved actor:

```json
{
  "companyId": "<uuid>",
  "actor": { "kind": "cc", "actorId": "cc:paperclip-01:<sid>", "host": "paperclip-01",
             "trust": "attributed", "canHoldHardGate": true },
  "principal": { "source": "board_key", "agentId": null, "runId": null, "tokenHost": null }
}
```

## RK9-616: loopback decision

[RK9-616](/RK9/issues/RK9-616) found an agent that fell back to
`http://127.0.0.1:3100`. The investigation of that ticket is still open.
The coord bus takes this explicit decision now:

- Coord routes trust no actor because of where the request comes from. The
  `local_implicit` board actor is rejected with 401, also in `local_trusted`
  mode.
- Company scope comes only from `:companyId` plus a credential bound to that
  company.
- A caller may still use `http://127.0.0.1:3100` as a transport on
  paperclip-01. It must send its own credential like any other caller.

The test `rejects an unauthenticated loopback request in local_trusted mode`
runs the real `actorMiddleware` in `local_trusted` mode and proves the 401.

## Tailnet route to :3100

**Decision (Q1):** remote CLIs call `http://paperclip:3100` (the tailnet name
of paperclip-01) directly, each with its own per-host coord token. Grok goes
only through the vault-mcp proxy, which holds the `grok` service token.

Facts observed on paperclip-01 on 2026-11-01 (read-only):

- The service listens on `0.0.0.0:3100`, so the tailnet address
  (100.120.245.107) already reaches it. No new bind is needed.
- The tailnet name of the machine is `paperclip`.

Justification against RK9-323 (SoD/POLP):

- **Least privilege:** a coord token can call only the coord routes of one
  company. RK9-623's global guard returns 403 for every other route. A
  stolen token exposes presence, leases and the journal of one company. It
  does not expose issues, agents, secrets or board mutations.
- **Separation of duties:** the operator's board key (operator authority)
  stays on paperclip-01, and `RK9_COORD_BOARD_KEY_IDS` can pin coord access
  to that one key. Remote hosts, rk9claude and Grok each hold a separate,
  individually revocable credential. Revoking one does not affect the others.
- **One hop, one holder:** a vault-mcp proxy for every CLI would add a hop
  and a second holder of a broader credential. Only Grok needs the proxy,
  because Grok cannot hold a token itself.
- **Attack surface:** the port is already reachable. The guard and the
  token scope keep the new surface to the coord routes.

Conditions for the remote-access child:

- Remote CLIs use the tailnet name `paperclip`. That name must be in
  `PAPERCLIP_ALLOWED_HOSTNAMES` when the private hostname guard is on.
- Recommended, not required: a Tailscale ACL that allows only tagged hosts to
  reach `paperclip:3100`.
- Note: `private-hostname-guard.ts` reads `X-Forwarded-Host` without a trust
  check. It is a DNS-rebinding guard, not authentication, so it does not
  weaken the token model.

## Token lifecycle (contract for RK9-623)

- **Issue:** a board-key or operator-session call creates a token for one
  `(company, host|service)`. The plaintext is shown once. The server stores
  only the sha256 hash and the display prefix.
- **Rotate:** one transaction revokes the old row and inserts the new one
  with `rotated_from_token_id`. There is no overlap window.
- **Revoke:** set `revoked_at`. The auth hook looks the hash up on every
  request without a cache, so revocation takes effect on the next request.
- **Auth hook** (`auth.ts`, RK9-623): a bearer that starts with `rk9_coord_`
  is resolved before the agent-key lookup. On a match, the hook sets
  `req.actor = { type: "none", source: "none" }` and `req.rk9CoordPrincipal`.
  Every upstream route then sees an anonymous caller and fails closed. On a
  miss, the request is 401; it must not fall through to the board or agent
  paths.
- **Global guard** (`app.ts`, RK9-623): when `req.rk9CoordPrincipal` is set
  and the path is not under `/api/companies/:companyId/rk9/coord/`, return
  403. Mount it before every API router.
- **Compare:** hash lookup on the unique `token_hash` index. Where a value is
  compared in memory, use `timingSafeEqual`.
- **Audit:** issue, rotate and revoke write `activity_log` rows. The token
  value never appears in logs, argv, comments or the vault.

### Client storage

- The epic contract fixes the client file: `~/.config/rk9/coord.env`, mode
  0600. It holds `RK9_COORD_URL`, `RK9_COORD_COMPANY_ID` and, on remote hosts,
  `RK9_COORD_TOKEN`. This replaces the `coord.token` path in the RK9-621
  acceptance criteria, so the CLI reads one file.
- Tooling reads the token from that file or the environment, never from
  argv. With curl, pass the header through a file descriptor, not argv:
  `curl -H @<(printf 'Authorization: Bearer %s\n' "$RK9_COORD_TOKEN") ...`.
- Delivery to rk9claude (skynet) and to vault-mcp follows the Bitwarden and
  secret policy. It is outside this repository.
- **The board key never leaves paperclip-01.** Remote hosts never receive it.
  Q6 (remote recall moving from the board key to a scoped token) is a
  follow-up, not part of this epic.

## Prototype checks

After deploy, run these on paperclip-01 (board key) and on one remote host
(coord token, after RK9-623). Both must return 200 and echo the resolved
actor:

```sh
# paperclip-01, board key from the session environment
curl -s -H @<(printf 'Authorization: Bearer %s\n' "$PAPERCLIP_API_KEY") \
  -H "X-RK9-Actor: cc:paperclip-01:$CLAUDE_SESSION_ID" \
  "http://127.0.0.1:3100/api/companies/$RK9_COMPANY_ID/rk9/coord/whoami"

# remote host, coord token from ~/.config/rk9/coord.env
. ~/.config/rk9/coord.env
curl -s -H @<(printf 'Authorization: Bearer %s\n' "$RK9_COORD_TOKEN") \
  -H "X-RK9-Actor: remote:$(hostname -s)" \
  "$RK9_COORD_URL/api/companies/$RK9_COORD_COMPANY_ID/rk9/coord/whoami"
```

## Router skeleton

`server/src/routes/rk9-coord.ts` owns `/api/companies/:companyId/rk9/coord/*`.
Sibling children add only their own sub-router file
(`rk9-coord-{actors,events,inbox,leases,board}.ts`) and one mount line in the
marked block. The actor middleware runs before every sub-router, so siblings
read `req.rk9CoordActor` and never parse the header themselves. The router is
mounted before the generic `/companies` router in `app.ts`.

## Open points

- Agent runs of other companies (ALL, SAA, ...) can call coord routes only
  for their own company. Whether they should coordinate inside the RK9
  company is a decision for the presence-api child. It would need an explicit
  cross-company grant, not a relaxed company check.
- The `cc` sessions on paperclip-01 cannot be told apart by the
  server. A per-session credential is a later hardening step, not part of
  this epic.

- Agent-key runs are `attributed`, and `attributed` may hold hard-gate
  leases. An agent key can still name a sibling running run of the same
  agent and act as that run. The lease service
  ([RK9-627](/RK9/issues/RK9-627)) must either require a run JWT
  (`verified`) for hard-gate leases held by `agent_run` actors, or check
  lease ownership against the agent id rather than the run id.

## Related notes

- This repository: `docs/implementation-notes/` (this file).
- claude-config (`~/.claude/docs/implementation-notes/`):
  `session-board.md` (the file-based board this epic replaces),
  `wake-context.md` (RK9-250), `headsup-shadow.md` (RK9-456/608),
  `orchestrator-lifecycle.md`, `vault-mcp-todo-inbox.md` (vault-mcp, Grok).
- Vault: `rk9/areas/identity-roles-sod-polp.md` (RK9-323).
