// RK9 Custom (RK9-641 item 16): the retention timer chain of
// startRk9CoordRetention, with fake timers and a fake db whose first query
// fails, so pruneRk9Coord rejects at once. No database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startRk9CoordRetention } from "../services/rk9-coord-retention.js";

function failingDb() {
  let calls = 0;
  const db = {
    transaction: async () => {
      calls += 1;
      throw new Error("db down");
    },
  } as unknown as Db;
  return { db, calls: () => calls };
}

/** Let the rejected prune, its catch and its finally run. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("startRk9CoordRetention timer chain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reschedules after a failed prune", async () => {
    const fake = failingDb();
    const stop = startRk9CoordRetention(fake.db, 1000);
    await flush();
    expect(fake.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls()).toBe(3);
    stop();
  });

  it("does not reschedule after stop", async () => {
    const fake = failingDb();
    const stop = startRk9CoordRetention(fake.db, 1000);
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reschedule when stop runs while a prune is in flight", async () => {
    const fake = failingDb();
    const stop = startRk9CoordRetention(fake.db, 1000);
    // The first prune has started but its finally has not run yet.
    stop();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
