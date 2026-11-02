// --- RK9 Custom (RK9-635): tests of the migration advisory lock ---
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import {
  RK9_MIGRATION_LOCK_KEY,
  Rk9MigrationLockTimeoutError,
  rk9MigrationLockTimeoutMs,
  withRk9MigrationLock,
} from "./rk9-migration-lock.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describe("rk9MigrationLockTimeoutMs", () => {
  it("defaults to 120 s, takes seconds from the env and caps at 3600 s", () => {
    expect(rk9MigrationLockTimeoutMs({})).toBe(120_000);
    expect(rk9MigrationLockTimeoutMs({ PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S: "5" })).toBe(5_000);
    expect(rk9MigrationLockTimeoutMs({ PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S: "99999" })).toBe(3_600_000);
    expect(rk9MigrationLockTimeoutMs({ PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S: "-1" })).toBe(120_000);
    expect(rk9MigrationLockTimeoutMs({ PAPERCLIP_MIGRATION_LOCK_TIMEOUT_S: "abc" })).toBe(120_000);
  });
});

describePostgres("withRk9MigrationLock (embedded Postgres)", () => {
  let url = "";
  let cleanup: (() => Promise<void>) | null = null;
  let probe: postgres.Sql;
  const quiet = () => undefined;

  beforeAll(async () => {
    const db = await startEmbeddedPostgresTestDatabase("paperclip-rk9-migration-lock-");
    url = db.connectionString;
    cleanup = db.cleanup;
    probe = postgres(url, { max: 1, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await probe?.end({ timeout: 5 }).catch(() => undefined);
    await cleanup?.();
  });

  /** True when another session could take the lock right now (it is then released again). */
  async function lockIsFree(): Promise<boolean> {
    const [row] = await probe<{ locked: boolean }[]>`select pg_try_advisory_lock(${RK9_MIGRATION_LOCK_KEY}::bigint) as locked`;
    if (row?.locked) await probe`select pg_advisory_unlock(${RK9_MIGRATION_LOCK_KEY}::bigint)`;
    return Boolean(row?.locked);
  }

  /** Hold the lock from a separate session until the returned release function is called. */
  async function holdLock(): Promise<() => Promise<void>> {
    const holder = postgres(url, { max: 1, onnotice: () => {} });
    await holder`select pg_advisory_lock(${RK9_MIGRATION_LOCK_KEY}::bigint)`;
    return async () => {
      await holder`select pg_advisory_unlock(${RK9_MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
      await holder.end({ timeout: 5 });
    };
  }

  it("holds the lock while fn runs and releases it on success", async () => {
    let freeInside: boolean | null = null;
    const result = await withRk9MigrationLock(url, async () => {
      freeInside = await lockIsFree();
      return 42;
    }, { log: quiet });
    expect(result).toBe(42);
    expect(freeInside).toBe(false);
    expect(await lockIsFree()).toBe(true);
  });

  it("releases the lock when fn throws and passes the error on", async () => {
    await expect(withRk9MigrationLock(url, async () => {
      throw new Error("migration failed");
    }, { log: quiet })).rejects.toThrow("migration failed");
    expect(await lockIsFree()).toBe(true);
  });

  it("serializes two concurrent runs (the second starts after the first ends)", async () => {
    const events: string[] = [];
    const run = (name: string, ms: number) =>
      withRk9MigrationLock(url, async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`${name}:end`);
      }, { pollMs: 50, log: quiet });
    const first = run("a", 400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.all([first, run("b", 10)]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("times out without calling fn while another session holds the lock, then passes once it is released", async () => {
    const release = await holdLock();
    const logs: string[] = [];
    let called = false;
    const started = Date.now();
    try {
      const error = await withRk9MigrationLock(url, async () => {
        called = true;
      }, { timeoutMs: 600, pollMs: 50, log: (m) => logs.push(m) }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Rk9MigrationLockTimeoutError);
      expect((error as Rk9MigrationLockTimeoutError).message).toMatch(/not migrating/);
      expect((error as Rk9MigrationLockTimeoutError).holder).toMatch(/^pid \d+/);
      expect(called).toBe(false);
      // Bounded wait, not an instant failure: a systemd restart loop retries at most once per timeout + RestartSec.
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
      expect(logs.some((m) => m.includes("waiting up to"))).toBe(true);
    } finally {
      await release();
    }
    // The "restart" after the holder finished goes through.
    await expect(withRk9MigrationLock(url, async () => "ok", { timeoutMs: 600, log: quiet })).resolves.toBe("ok");
  });

  it("applyPendingMigrations on an up-to-date schema returns without waiting for a held lock", async () => {
    const release = await holdLock();
    try {
      const started = Date.now();
      await applyPendingMigrations(url);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await release();
    }
  });

  it("a restart loop while the lock is held does not run hot: each attempt waits for the timeout", async () => {
    const release = await holdLock();
    try {
      const attempts: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const t0 = Date.now();
        await withRk9MigrationLock(url, async () => undefined, { timeoutMs: 300, pollMs: 50, log: quiet }).catch(() => undefined);
        attempts.push(Date.now() - t0);
      }
      for (const ms of attempts) expect(ms).toBeGreaterThanOrEqual(250);
    } finally {
      await release();
    }
  });
});
// --- end RK9 Custom ---
