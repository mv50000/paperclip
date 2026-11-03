// RK9 Custom (RK9-663): startup warnings and header/pin ordering of the coord
// actor middleware. Contract: docs/implementation-notes/coord-identity.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveRk9CoordActor, rk9CoordActorMiddleware } from "../middleware/rk9-coord-actor.js";

const warnEvents = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call) => (call[0] as { event?: string } | undefined)?.event);

describe("rk9CoordActorMiddleware startup warnings", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });
  afterEach(() => warn.mockRestore());
  const build = (operatorUserIds: string[] | null, boardKeyIds: string[] | null) =>
    rk9CoordActorMiddleware({} as Db, { operatorUserIds, boardKeyIds, findAgentRun: async () => null });

  it("warns when only the operator user pin is set", () => {
    build(["u1"], null);
    expect(warnEvents(warn)).toContain("rk9_coord_operator_pin_without_board_key_pin");
    const msg = warn.mock.calls.find(
      (c) => (c[0] as { event?: string }).event === "rk9_coord_operator_pin_without_board_key_pin",
    )?.[1] as string;
    expect(msg).toMatch(/cc, worktree, headless or orch/);
  });

  it("stays silent about the combined gap when both pins are set", () => {
    build(["u1"], ["k1"]);
    expect(warnEvents(warn)).not.toContain("rk9_coord_operator_pin_without_board_key_pin");
  });

  it("stays silent about the combined gap when only the board-key pin is set", () => {
    build(null, ["k1"]);
    expect(warnEvents(warn)).not.toContain("rk9_coord_operator_pin_without_board_key_pin");
  });

  it("stays silent about the combined gap when neither pin is set", () => {
    build(null, null);
    expect(warnEvents(warn)).not.toContain("rk9_coord_operator_pin_without_board_key_pin");
  });
});

describe("resolveRk9CoordActor header vs pin order (RK9-663)", () => {
  const base = {
    companyId: "00000000-0000-4000-8000-000000000001",
    method: "POST",
    boardHost: "paperclip-01",
    findAgentRun: async () => null,
  };
  const session = (userId: string, isInstanceAdmin = true) =>
    ({ type: "board", source: "session", userId, isInstanceAdmin }) as never;

  it("returns 403 before 400 for an unpinned admin session with a malformed header", async () => {
    await expect(
      resolveRk9CoordActor({ ...base, actor: session("other"), operatorUserIds: ["op"], actorHeader: "!!bad!!" }),
    ).rejects.toMatchObject({ status: 403, details: { code: "rk9_coord_operator_not_allowed" } });
  });

  it("still returns 400 for a pinned operator session with a malformed header", async () => {
    await expect(
      resolveRk9CoordActor({ ...base, actor: session("op"), operatorUserIds: ["op"], actorHeader: "!!bad!!" }),
    ).rejects.toMatchObject({ status: 400, details: { code: "rk9_coord_actor_malformed" } });
  });

  it("returns 403 before 400 for a board key off the pin list with a malformed header", async () => {
    await expect(
      resolveRk9CoordActor({
        ...base,
        actor: { type: "board", source: "board_key", keyId: "bad", isInstanceAdmin: true } as never,
        boardKeyIds: ["good"],
        actorHeader: "!!bad!!",
      }),
    ).rejects.toMatchObject({ status: 403, details: { code: "rk9_coord_board_key_not_allowed" } });
  });
});
