// RK9 Custom (RK9-621): coord actor_id grammar.
import { describe, expect, it } from "vitest";
import {
  parseRk9CoordActorId,
  rk9CoordBoardKeyActorIdSchema,
  rk9CoordBoardKeyMayClaim,
  rk9CoordActorIdSchema,
  rk9CoordTrustCanHoldHardGate,
  RK9_COORD_ACTOR_KINDS,
  RK9_COORD_HARD_GATE_PREFIXES,
} from "./index.js";

describe("parseRk9CoordActorId", () => {
  it.each([
    ["cc:paperclip-01:3f1c2a9e-1111-4222-8333-944455556666", "cc", "paperclip-01", "3f1c2a9e-1111-4222-8333-944455556666"],
    ["worktree:RK9-621", "worktree", null, "RK9-621"],
    ["headless:run_20261101.a-1", "headless", null, "run_20261101.a-1"],
    ["agent_run:3f1c2a9e-1111-4222-8333-944455556666", "agent_run", null, "3f1c2a9e-1111-4222-8333-944455556666"],
    ["orch:implement", "orch", null, "implement"],
    ["remote:mv-laptop", "remote", "mv-laptop", null],
    ["rk9claude", "rk9claude", null, null],
    ["grok", "grok", null, null],
    ["operator", "operator", null, null],
  ])("accepts %s", (value, kind, host, ref) => {
    expect(parseRk9CoordActorId(value)).toEqual({ kind, actorId: value, host, ref });
    expect(rk9CoordActorIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "",
    " operator",
    "operator ",
    "OPERATOR",
    "cc:Paperclip-01:abc",
    "cc:paperclip-01",
    "cc::abc",
    "cc:-bad:abc",
    "cc:paperclip-01:abc def",
    "cc:paperclip-01:abc,operator",
    "worktree:rk9-621",
    "worktree:RK9-",
    "agent_run:not-a-uuid",
    "agent_run:3F1C2A9E-1111-4222-8333-944455556666",
    "remote:mv-laptop:extra",
    "grok:x",
    "__proto__",
    "constructor",
    "toString:x",
    "board",
    `cc:paperclip-01:${"a".repeat(190)}`,
  ])("rejects %j", (value) => {
    expect(parseRk9CoordActorId(value)).toBeNull();
    expect(rk9CoordActorIdSchema.safeParse(value).success).toBe(false);
  });

  it("has a pattern for every frozen kind", () => {
    expect(RK9_COORD_ACTOR_KINDS).toEqual([
      "cc", "worktree", "headless", "agent_run", "orch", "remote", "rk9claude", "grok", "operator",
    ]);
  });

  it("never lets a board-key caller claim operator or a remote kind", () => {
    for (const ok of ["cc:paperclip-01:s1", "worktree:RK9-621", "headless:r1", "orch:implement"]) {
      expect(rk9CoordBoardKeyActorIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["operator", "remote:htpc", "rk9claude", "grok", "agent_run:3f1c2a9e-1111-4222-8333-944455556666", "nope"]) {
      expect(rk9CoordBoardKeyActorIdSchema.safeParse(bad).success).toBe(false);
    }
    expect(rk9CoordBoardKeyMayClaim("operator")).toBe(false);
  });

  it("lets only vouched-for actors hold hard-gate leases", () => {
    expect(RK9_COORD_HARD_GATE_PREFIXES).toEqual(["prod", "migrate", "host"]);
    expect(rk9CoordTrustCanHoldHardGate("verified")).toBe(true);
    expect(rk9CoordTrustCanHoldHardGate("attributed")).toBe(true);
    expect(rk9CoordTrustCanHoldHardGate("unverified")).toBe(false);
  });
});
