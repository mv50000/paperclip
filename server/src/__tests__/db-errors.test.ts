import { describe, expect, it } from "vitest";
import { isForeignKeyViolation, isUniqueViolation } from "../db-errors.js";

const CONSTRAINT = "issues_open_routine_execution_uq";

describe("isUniqueViolation", () => {
  it("matches a bare postgres.js unique violation", () => {
    expect(isUniqueViolation({ code: "23505", constraint_name: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the node-postgres constraint field", () => {
    expect(isUniqueViolation({ code: "23505", constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the error Drizzle wraps around the driver failure", () => {
    const wrapped = new Error("Failed query: update \"issues\" set \"execution_run_id\" = $1");
    (wrapped as { cause?: unknown }).cause = { code: "23505", constraint_name: CONSTRAINT };
    expect(isUniqueViolation(wrapped, CONSTRAINT)).toBe(true);
  });

  it("falls back to the driver message when the constraint name is not surfaced", () => {
    expect(isUniqueViolation({
      cause: {
        code: "23505",
        message: `duplicate key value violates unique constraint "${CONSTRAINT}"`,
      },
    }, CONSTRAINT)).toBe(true);
  });

  it("matches any unique violation when no constraint is named", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("ignores a unique violation on a different constraint", () => {
    expect(isUniqueViolation({ cause: { code: "23505", constraint_name: "issues_identifier_idx" } }, CONSTRAINT))
      .toBe(false);
  });

  it("ignores errors that are not unique violations", () => {
    expect(isUniqueViolation({ cause: { code: "23503", constraint_name: CONSTRAINT } }, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(new Error("boom"), CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(null, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(undefined, CONSTRAINT)).toBe(false);
  });

  it("stops walking a self-referential cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUniqueViolation(looped, CONSTRAINT)).toBe(false);
  });
});

// RK9 Custom (RK9-684): the constraint filter of the coord lease prune retry.
describe("isForeignKeyViolation", () => {
  const ACTOR_FK = /_rk9_coord_actors_id_fk\b/;

  it("matches any foreign key violation without a filter", () => {
    expect(isForeignKeyViolation({ cause: { code: "23503" } })).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: "23505" } })).toBe(false);
  });

  it("matches the filter on the constraint name or the driver message", () => {
    const name = "rk9_coord_leases_holder_actor_id_rk9_coord_actors_id_fk";
    expect(isForeignKeyViolation({ cause: { code: "23503", constraint_name: name } }, ACTOR_FK)).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: "23503", constraint: name } }, ACTOR_FK)).toBe(true);
    expect(
      isForeignKeyViolation({ cause: { code: "23503", message: `violates foreign key constraint "${name}"` } }, ACTOR_FK),
    ).toBe(true);
  });

  it("ignores a foreign key violation on another constraint", () => {
    const name = "rk9_coord_leases_company_id_companies_id_fk";
    expect(isForeignKeyViolation({ cause: { code: "23503", constraint_name: name, message: name } }, ACTOR_FK)).toBe(false);
  });
});
