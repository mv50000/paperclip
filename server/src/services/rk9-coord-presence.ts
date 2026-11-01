// --- RK9 Custom (RK9-625): coord presence (epic RK9-620, key presence-api) ---
//
// One row per actor in rk9_coord_actors, keyed by (company_id, actor_ref)
// (docs/implementation-notes/coord-bus.md). Liveness is a pure read rule:
//
//   live  <=>  ended_at IS NULL AND last_seen_at > now - RK9_COORD_PRESENCE_TTL_S
//
// so an actor that crashes (kill -9) or stops refreshing drops out of active
// lists after one TTL, with no cleanup job.
//
// Running Paperclip agent runs are projected from heartbeat_runs as
// kind=agent_run rows. The projection only SELECTs, inside a READ ONLY
// transaction, so it cannot write to any table; the heartbeat service is not
// touched.
//
// Phase and name pass the RK9_SESSIONS_SECRET_RX redaction and are capped at
// 140 characters before storage.
import { and, desc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, rk9CoordActors } from "@paperclipai/db";
import { parseRk9CoordActorId, RK9_COORD_PHASE_MAX, type Rk9CoordActorKind, type Rk9CoordTrust } from "@paperclipai/shared";
import { toRk9CoordLine } from "./rk9-coord-redact.js";

export const RK9_COORD_PRESENCE_TTL_S_DEFAULT = 300;
/** A running heartbeat run with no activity for this long is treated as an orphan. */
export const RK9_COORD_AGENT_RUN_STALE_S_DEFAULT = 7200;
const NAME_MAX = 200;
/** Server-set metadata key: set on the first PUT me, so a stub row (RK9-626) still logs one registration. */
export const RK9_COORD_REGISTERED_MARKER = "presence_registered_at";

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveRk9CoordPresenceTtlS(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_PRESENCE_TTL_S, RK9_COORD_PRESENCE_TTL_S_DEFAULT, 10, 86_400);
}

/** 0 disables the orphan cutoff. */
export function resolveRk9CoordAgentRunStaleS(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RK9_COORD_AGENT_RUN_STALE_S, RK9_COORD_AGENT_RUN_STALE_S_DEFAULT, 0, 7 * 86_400);
}

/** The actor the coord middleware resolved, plus the agent behind an agent_run. */
export interface Rk9CoordPresenceIdentity {
  companyId: string;
  kind: Rk9CoordActorKind;
  actorId: string;
  host: string | null;
  trust: Rk9CoordTrust;
  agentId?: string | null;
  runId?: string | null;
}

/** Fields of PUT me; `undefined` keeps the stored value, `null` clears it. */
export interface Rk9CoordPresenceFields {
  name?: string | null;
  issue?: string | null;
  repo?: string | null;
  branch?: string | null;
  phase?: string | null;
  pid?: number | null;
  livenessSource?: string | null;
  metadata?: Record<string, unknown>;
  /** Client-side id (the CLI's session id) when it differs from the actor_ref part. */
  clientExternalId?: string | null;
}

export interface Rk9CoordPresenceRow {
  actorId: string;
  kind: string;
  host: string | null;
  name: string | null;
  issue: string | null;
  repo: string | null;
  branch: string | null;
  /** `repo@branch`, `repo`, or null. */
  repoBranch: string | null;
  phase: string | null;
  trust: string;
  /** Seconds since the actor registered (agent_run: since the run started). */
  ageS: number;
  /** Seconds since the last refresh (agent_run: since the last run activity). */
  lastSeenS: number;
  /** heartbeat_runs.status for projected agent runs, else null. */
  runStatus: string | null;
  source: "presence" | "heartbeat_run";
}

export interface Rk9CoordPresenceListFilter {
  active?: boolean;
  repo?: string;
  issue?: string;
  limit?: number;
}

export interface Rk9CoordPresenceOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function seconds(now: Date, then: Date | string | null | undefined): number {
  if (!then) return 0;
  const t = then instanceof Date ? then.getTime() : new Date(then).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 1000)) : 0;
}

function repoBranch(repo: string | null, branch: string | null): string | null {
  if (!repo) return null;
  return branch ? `${repo}@${branch}` : repo;
}

function ts(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

export function rk9CoordPresenceService(db: Db, opts: Rk9CoordPresenceOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;

  function ttlS() {
    return resolveRk9CoordPresenceTtlS(env);
  }

  /**
   * Upsert the caller's row. Returns the row id and whether this call was the
   * actor's first registration (insert, or the first PUT on a stub row that
   * another coord route inserted).
   */
  async function upsert(identity: Rk9CoordPresenceIdentity, fields: Rk9CoordPresenceFields) {
    const at = now();
    const expiresAt = new Date(at.getTime() + ttlS() * 1000);
    const parsed = parseRk9CoordActorId(identity.actorId);
    const externalId = parsed?.ref ?? fields.clientExternalId ?? null;
    const phase = fields.phase === undefined ? undefined : toRk9CoordLine(fields.phase, RK9_COORD_PHASE_MAX, env);
    const name = fields.name === undefined ? undefined : toRk9CoordLine(fields.name, NAME_MAX, env);
    const issue =
      fields.issue !== undefined ? fields.issue : identity.kind === "worktree" ? (parsed?.ref ?? null) : undefined;

    return db.transaction(async (tx) => {
      // Lock an existing row (a stub, or a previous registration) so two
      // concurrent first PUTs cannot both count as the registration.
      const [prior] = await tx
        .select({
          id: rk9CoordActors.id,
          registered: sql<string | null>`${rk9CoordActors.metadata} ->> ${RK9_COORD_REGISTERED_MARKER}`,
          metadata: rk9CoordActors.metadata,
        })
        .from(rk9CoordActors)
        .where(and(eq(rk9CoordActors.companyId, identity.companyId), eq(rk9CoordActors.actorRef, identity.actorId)))
        .for("update");

      const registeredAt = prior?.registered ?? at.toISOString();
      const clientMetadata = { ...(fields.metadata ?? {}) };
      delete clientMetadata[RK9_COORD_REGISTERED_MARKER];
      const baseMetadata = fields.metadata !== undefined ? clientMetadata : { ...(prior?.metadata ?? {}) };
      const metadata: Record<string, unknown> = { ...baseMetadata, [RK9_COORD_REGISTERED_MARKER]: registeredAt };
      if (fields.clientExternalId && fields.clientExternalId !== externalId) {
        metadata.client_external_id = fields.clientExternalId;
      }

      const set: Partial<typeof rk9CoordActors.$inferInsert> = {
        kind: identity.kind,
        host: identity.host,
        externalId,
        trust: identity.trust,
        agentId: identity.agentId ?? null,
        runId: identity.runId ?? null,
        metadata,
        lastSeenAt: at,
        expiresAt,
        endedAt: null,
        updatedAt: at,
      };
      if (name !== undefined) set.name = name;
      if (issue !== undefined) set.issue = issue;
      if (fields.repo !== undefined) set.repo = fields.repo;
      if (fields.branch !== undefined) set.branch = fields.branch;
      if (fields.pid !== undefined) set.pid = fields.pid;
      if (fields.livenessSource !== undefined) set.livenessSource = fields.livenessSource;

      const updateSet: Record<string, unknown> = { ...set };
      if (phase !== undefined) {
        updateSet.phase = phase;
        updateSet.phaseAt = sql`case when ${rk9CoordActors.phase} is distinct from ${phase}::text then ${ts(at)} else ${rk9CoordActors.phaseAt} end`;
      }

      const [row] = await tx
        .insert(rk9CoordActors)
        .values({
          ...set,
          companyId: identity.companyId,
          actorRef: identity.actorId,
          kind: identity.kind,
          trust: identity.trust,
          phase: phase ?? null,
          phaseAt: phase ? at : null,
          createdAt: at,
        })
        .onConflictDoUpdate({
          target: [rk9CoordActors.companyId, rk9CoordActors.actorRef],
          set: updateSet,
        })
        .returning({ id: rk9CoordActors.id, inserted: sql<boolean>`(xmax = 0)` });

      const inserted = row!.inserted === true;
      return { id: row!.id, inserted, firstRegistration: inserted || (prior !== undefined && !prior.registered) };
    });
  }

  /** Update phase and refresh liveness. Returns false when the actor has no open row. */
  async function setPhase(identity: Rk9CoordPresenceIdentity, rawPhase: string | null) {
    const at = now();
    const phase = toRk9CoordLine(rawPhase, RK9_COORD_PHASE_MAX, env);
    const rows = await db
      .update(rk9CoordActors)
      .set({
        phase,
        phaseAt: sql`case when ${rk9CoordActors.phase} is distinct from ${phase}::text then ${ts(at)} else ${rk9CoordActors.phaseAt} end`,
        lastSeenAt: at,
        expiresAt: new Date(at.getTime() + ttlS() * 1000),
        updatedAt: at,
      })
      .where(
        and(
          eq(rk9CoordActors.companyId, identity.companyId),
          eq(rk9CoordActors.actorRef, identity.actorId),
          isNull(rk9CoordActors.endedAt),
        ),
      )
      .returning({ id: rk9CoordActors.id, phase: rk9CoordActors.phase });
    return rows[0] ?? null;
  }

  /** End the actor. Idempotent: an ended or unknown actor is a no-op. */
  async function end(identity: Pick<Rk9CoordPresenceIdentity, "companyId" | "actorId">) {
    const at = now();
    const rows = await db
      .update(rk9CoordActors)
      .set({ endedAt: at, updatedAt: at })
      .where(
        and(
          eq(rk9CoordActors.companyId, identity.companyId),
          eq(rk9CoordActors.actorRef, identity.actorId),
          isNull(rk9CoordActors.endedAt),
        ),
      )
      .returning({ id: rk9CoordActors.id });
    return rows[0] ?? null;
  }

  /**
   * Compact presence rows plus projected agent runs. Runs in one READ ONLY
   * transaction: a consistent snapshot, and a hard guarantee that the list
   * (including the heartbeat_runs projection) writes nothing.
   */
  async function list(companyId: string, filter: Rk9CoordPresenceListFilter = {}): Promise<Rk9CoordPresenceRow[]> {
    const at = now();
    const active = filter.active !== false;
    const limit = filter.limit ?? 200;
    const cutoff = new Date(at.getTime() - ttlS() * 1000);
    const staleS = resolveRk9CoordAgentRunStaleS(env);

    return db.transaction(
      async (tx) => {
        const conds: SQL[] = [eq(rk9CoordActors.companyId, companyId)];
        if (active) {
          conds.push(isNull(rk9CoordActors.endedAt), gt(rk9CoordActors.lastSeenAt, cutoff));
        }
        if (filter.issue) conds.push(eq(rk9CoordActors.issue, filter.issue));
        if (filter.repo) {
          // `paperclip` matches `paperclip` and `<owner>/paperclip`.
          conds.push(
            filter.repo.includes("/")
              ? eq(rk9CoordActors.repo, filter.repo)
              : or(eq(rk9CoordActors.repo, filter.repo), sql`${rk9CoordActors.repo} like ${`%/${filter.repo}`}`)!,
          );
        }
        const actorRows = await tx
          .select({
            actorRef: rk9CoordActors.actorRef,
            kind: rk9CoordActors.kind,
            host: rk9CoordActors.host,
            name: rk9CoordActors.name,
            issue: rk9CoordActors.issue,
            repo: rk9CoordActors.repo,
            branch: rk9CoordActors.branch,
            phase: rk9CoordActors.phase,
            trust: rk9CoordActors.trust,
            createdAt: rk9CoordActors.createdAt,
            lastSeenAt: rk9CoordActors.lastSeenAt,
          })
          .from(rk9CoordActors)
          .where(and(...conds))
          .orderBy(desc(rk9CoordActors.lastSeenAt))
          .limit(limit);

        const rows: Rk9CoordPresenceRow[] = actorRows.map((r) => ({
          actorId: r.actorRef,
          kind: r.kind,
          host: r.host,
          name: r.name,
          issue: r.issue,
          repo: r.repo,
          branch: r.branch,
          repoBranch: repoBranch(r.repo, r.branch),
          phase: r.phase,
          trust: r.trust,
          ageS: seconds(at, r.createdAt),
          lastSeenS: seconds(at, r.lastSeenAt),
          runStatus: null,
          source: "presence",
        }));

        // Agent runs have no repo, so a repo filter excludes them.
        if (filter.repo || rows.length >= limit) return rows;

        const contextIssueId = sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`;
        const runConds: SQL[] = [eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")];
        if (staleS > 0) {
          const staleCutoff = new Date(at.getTime() - staleS * 1000);
          runConds.push(
            sql`greatest(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.updatedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) > ${ts(staleCutoff)}`,
          );
        }
        if (filter.issue) runConds.push(eq(issues.identifier, filter.issue));
        const runRows = await tx
          .select({
            runId: heartbeatRuns.id,
            status: heartbeatRuns.status,
            startedAt: heartbeatRuns.startedAt,
            createdAt: heartbeatRuns.createdAt,
            lastActivityAt: sql<Date>`greatest(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.updatedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`.mapWith(
              heartbeatRuns.updatedAt,
            ),
            agentName: agents.name,
            issue: issues.identifier,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
          .leftJoin(
            issues,
            and(
              eq(issues.companyId, heartbeatRuns.companyId),
              // Guarded cast: a non-UUID context value never breaks the list.
              sql`${issues.id} = case when ${contextIssueId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${contextIssueId})::uuid end`,
            ),
          )
          .where(and(...runConds))
          .orderBy(desc(heartbeatRuns.startedAt))
          .limit(limit - rows.length);

        const seen = new Set(rows.map((r) => r.actorId));
        for (const r of runRows) {
          const actorId = `agent_run:${r.runId.toLowerCase()}`;
          // A run that registered itself through PUT me is already listed.
          if (seen.has(actorId)) continue;
          rows.push({
            actorId,
            kind: "agent_run",
            host: null,
            name: r.agentName,
            issue: r.issue ?? null,
            repo: null,
            branch: null,
            repoBranch: null,
            phase: null,
            trust: "verified",
            ageS: seconds(at, r.startedAt ?? r.createdAt),
            lastSeenS: seconds(at, r.lastActivityAt),
            runStatus: r.status,
            source: "heartbeat_run",
          });
        }
        return rows;
      },
      { accessMode: "read only" },
    );
  }

  return { upsert, setPhase, end, list, ttlS };
}
// --- /RK9 Custom ---
