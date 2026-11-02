// --- RK9 Custom (RK9-635): Postgres advisory lock that serializes applyPendingMigrations ---
//
// Every Paperclip migration path ends in applyPendingMigrations (client.ts): server startup
// (server/src/index.ts), the dev-runner's `pnpm db:migrate` on restart, and a manual
// `pnpm db:migrate` / `tsx src/migrate.ts`. Neither that path nor drizzle-orm's pg migrator took a
// lock, so two of them could apply the same migrations at once. This module takes a session-level
// pg_advisory_lock on a fixed key over a DEDICATED single-connection client: the lock, the work's
// "who holds it" lookup and the unlock all run on that one backend, the client is never shared with
// a pool user, and closing it in `finally` drops the session lock even if the unlock failed.
//
// The coord lease `migrate:paperclip` (rk9 gate wrapper, epic RK9-620) is for visibility and the
// queue; this lock is the correctness guarantee and works when coord is down. The wait is bounded:
// on timeout the caller gets Rk9MigrationLockTimeoutError and nothing is migrated. Under systemd
// (Restart=always, RestartSec=10) a failed start therefore retries at most once per
// timeout + 10 s, and once the holder has finished, the next start finds the schema up to date
// and does not take the lock at all. Doc: claude-config
// docs/implementation-notes/coord-gate-migrate-host.md.
//
// Embedded PostgreSQL (DATABASE_URL unset; the legacy `pglite` config mode is mapped to it in
// runtime-config.ts) is a real Postgres server on a local port, so a second connection works there.
import postgres from "postgres";

/** Fixed advisory-lock key: ASCII "rk9mig" (0x726b396d6967). One key per database. */
export const RK9_MIGRATION_LOCK_KEY = 0x726b396d6967;
export const RK9_MIGRATION_LOCK_TIMEOUT_DEFAULT_S = 120;
export const RK9_MIGRATION_LOCK_TIMEOUT_MAX_S = 3600;

export class Rk9MigrationLockTimeoutError extends Error {
  readonly code = "RK9_MIGRATION_LOCK_TIMEOUT";
  constructor(
    readonly timeoutMs: number,
    readonly holder: string | null,
  ) {
    super(
      `Another process has been applying Paperclip migrations for more than ${Math.round(timeoutMs / 1000)} s ` +
        `(advisory lock ${RK9_MIGRATION_LOCK_KEY.toString(16)} held${holder ? ` by ${holder}` : ""}); not migrating. ` +
        "Retry after it finishes: a restart is harmless, the next start sees the applied schema. " +
        "Wait longer with PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S.",
    );
    this.name = "Rk9MigrationLockTimeoutError";
  }
}

/** PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S (seconds, 0..3600), default 120. Returns milliseconds. */
export function rk9MigrationLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S?.trim();
  if (raw && /^[0-9]{1,5}$/.test(raw)) {
    return Math.min(Number(raw), RK9_MIGRATION_LOCK_TIMEOUT_MAX_S) * 1000;
  }
  return RK9_MIGRATION_LOCK_TIMEOUT_DEFAULT_S * 1000;
}

export interface Rk9MigrationLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding the migration advisory lock of the database at `url`. Waits at most
 * `timeoutMs` for the lock, then throws Rk9MigrationLockTimeoutError without calling `fn`.
 * The lock is released (unlock + connection close) on success and on error.
 */
export async function withRk9MigrationLock<T>(
  url: string,
  fn: () => Promise<T>,
  options: Rk9MigrationLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? rk9MigrationLockTimeoutMs();
  const pollMs = options.pollMs ?? 500;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  // max: 1 + no idle timeout + no max lifetime: one backend for the whole hold, never recycled
  // (postgres.js otherwise retires a connection after 30-60 min, which would drop the session lock).
  const sql = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: 0, onnotice: () => {} });
  try {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    for (;;) {
      const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${RK9_MIGRATION_LOCK_KEY}::bigint) as locked`;
      if (row?.locked) break;
      if (Date.now() >= deadline) {
        throw new Rk9MigrationLockTimeoutError(timeoutMs, await lockHolder(sql));
      }
      if (!announced) {
        announced = true;
        const holder = await lockHolder(sql);
        log(
          `[paperclip] migrations are being applied by another process${holder ? ` (${holder})` : ""}; ` +
            `waiting up to ${Math.round(timeoutMs / 1000)} s for the migration lock`,
        );
      }
      await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
    try {
      return await fn();
    } finally {
      await sql`select pg_advisory_unlock(${RK9_MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** Best-effort "pid N (application, since T)" of the session holding the lock. */
async function lockHolder(sql: postgres.Sql): Promise<string | null> {
  try {
    const key = BigInt(RK9_MIGRATION_LOCK_KEY);
    const classid = Number(key >> 32n);
    const objid = Number(key & 0xffffffffn);
    const rows = await sql<{ pid: number; application_name: string | null; backend_start: Date | null }[]>`
      select a.pid, a.application_name, a.backend_start
        from pg_locks l join pg_stat_activity a on a.pid = l.pid
       where l.locktype = 'advisory' and l.granted and l.classid = ${classid} and l.objid = ${objid} and l.objsubid = 1
       limit 1`;
    const r = rows[0];
    if (!r) return null;
    const app = r.application_name ? `, ${r.application_name}` : "";
    const since = r.backend_start ? `, since ${new Date(r.backend_start).toISOString()}` : "";
    return `pid ${r.pid}${app}${since}`;
  } catch {
    return null;
  }
}
// --- end RK9 Custom ---
