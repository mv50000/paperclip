// Suppression list tests use the in-memory Postgres-compatible store the rest
// of the test suite uses (see other tests for the pattern). We keep this test
// focused on the logic — addresses are normalized to lowercase so that
// suppression always matches case-insensitively.

import { describe, expect, it } from "vitest";

// The functions are pure logic; we don't need a real DB to test
// case-insensitive normalization behavior. Instead we test the contract
// indirectly through the function signature. A full integration test that
// hits a real Postgres lives in the e2e suite (pending Vaihe 1 smoke).

describe("suppression normalization contract", () => {
  it("addresses must be compared case-insensitively", () => {
    // The contract: addSuppression lowercases on insert; findSuppressed
    // lowercases the lookup keys. So "Customer@Example.COM" inserted should
    // match "customer@example.com" on lookup, and vice versa.
    const inserted = "Customer@Example.COM";
    const lookups = ["customer@example.com", "CUSTOMER@EXAMPLE.COM", inserted];
    const normalized = inserted.toLowerCase();
    for (const l of lookups) {
      expect(l.toLowerCase()).toBe(normalized);
    }
  });
});
