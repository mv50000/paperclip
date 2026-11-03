// --- RK9 Custom (RK9-623): coord token service (epic RK9-620) ---
//
// Issue, rotate, revoke and resolve the per-host and per-service coord tokens
// of the ADR docs/implementation-notes/coord-identity.md ("Token lifecycle").
//
// - Format: `rk9_coord_` + 43 base64url characters (32 random bytes).
// - Storage: only the sha256 hex of the full token and a 14-character display
//   prefix. The plaintext is returned once, by issue and rotate, and never
//   stored or logged.
// - Resolution: a hash lookup on the unique token_hash index on every request,
//   without a cache, so a revoke takes effect on the next request. The stored
//   hash is compared again with timingSafeEqual.
// - Rotate: one transaction revokes the old row and inserts the new one with
//   rotated_from_token_id. There is no overlap window.
// - Audit (RK9-639): issue, rotate and revoke take an optional `audit`
//   callback that runs inside the same transaction as the token write. If the
//   audit row cannot be written, the token write rolls back too: the caller
//   never loses a plaintext it was not shown, and a rotate never revokes the
//   old token without a replacement.
// - Scope (RK9-653): a token is `coord` (coord routes only) or `recall`
//   (POST /api/companies/:companyId/knowledge/recall only). A host or
//   service holds at most one active token per scope. `recallAll` is an
//   operator opt-in on a recall token: the recall route then honours
//   scope:"all" for it. Rotate keeps the scope and the flag.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rk9CoordTokens } from "@paperclipai/db";
import { RK9_COORD_TOKEN_PREFIX, RK9_COORD_TOKEN_SCOPES, type Rk9CoordTokenScope } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { Rk9CoordTokenPrincipal } from "../middleware/rk9-coord-actor.js";

/** Full token grammar; anything else is rejected before the DB lookup. */
export const RK9_COORD_TOKEN_PATTERN = /^rk9_coord_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_LENGTH = RK9_COORD_TOKEN_PREFIX.length + 4;

export type Rk9CoordTokenRecord = typeof rk9CoordTokens.$inferSelect;

/**
 * A rotate that inherits the old expiry, and an explicit expiry, must leave
 * the new token at least this long to live. Otherwise the call mints a token
 * that is dead before the host has installed it.
 */
export const RK9_COORD_TOKEN_MIN_LIFETIME_MS = 60_000;

/** Runs inside the token write's transaction; a throw rolls the write back. */
export type Rk9CoordTokenAudit<T> = (tx: Db, result: T) => Promise<void>;

/** Metadata view of a token row: never includes the hash. */
export interface Rk9CoordTokenView {
  id: string;
  companyId: string;
  principalKind: "host" | "service";
  principalName: string;
  tokenPrefix: string;
  scope: Rk9CoordTokenScope;
  recallAll: boolean;
  label: string | null;
  createdByUserId: string | null;
  rotatedFromTokenId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface IssueRk9CoordTokenInput {
  companyId: string;
  principalKind: "host" | "service";
  principalName: string;
  /** Omitted = coord. */
  scope?: Rk9CoordTokenScope;
  /** Operator opt-in for scope:"all" recall; only on a recall token. */
  recallAll?: boolean;
  label?: string | null;
  expiresAt?: Date | null;
  createdByUserId?: string | null;
}

export interface Rk9CoordTokenIssueResult {
  /** Plaintext token: show it once, never store or log it. */
  token: string;
  record: Rk9CoordTokenView;
}

export interface Rk9CoordTokenRotateResult extends Rk9CoordTokenIssueResult {
  revoked: Rk9CoordTokenView;
}

export function generateRk9CoordToken(): string {
  return `${RK9_COORD_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashRk9CoordToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isRk9CoordBearer(token: string): boolean {
  return token.startsWith(RK9_COORD_TOKEN_PREFIX);
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function rk9CoordTokenView(row: Rk9CoordTokenRecord): Rk9CoordTokenView {
  return {
    id: row.id,
    companyId: row.companyId,
    principalKind: row.principalKind,
    principalName: row.principalName,
    tokenPrefix: row.tokenPrefix,
    scope: row.scope,
    recallAll: row.recallAll,
    label: row.label,
    createdByUserId: row.createdByUserId,
    rotatedFromTokenId: row.rotatedFromTokenId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const candidate = err as { code?: unknown; constraint_name?: unknown; cause?: unknown } | null;
  if (!candidate) return false;
  if (candidate.code === "23505" && candidate.constraint_name === constraint) return true;
  return candidate.cause ? isUniqueViolation(candidate.cause, constraint) : false;
}

const ACTIVE_PRINCIPAL_UQ = "rk9_coord_tokens_active_principal_uq";

export function rk9CoordTokenService(db: Db) {
  /**
   * Resolve a bearer to its principal. Returns null for a malformed, unknown,
   * revoked or expired token: the caller answers 401 and never falls through
   * to another credential path.
   */
  async function resolve(token: string, now: Date = new Date()): Promise<Rk9CoordTokenPrincipal | null> {
    if (!RK9_COORD_TOKEN_PATTERN.test(token)) return null;
    const tokenHash = hashRk9CoordToken(token);
    const [row] = await db
      .select()
      .from(rk9CoordTokens)
      .where(and(eq(rk9CoordTokens.tokenHash, tokenHash), isNull(rk9CoordTokens.revokedAt)))
      .limit(1);
    if (!row || !hashesEqual(row.tokenHash, tokenHash)) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    // An unknown scope (a newer row on an older server) is never honoured.
    if (!(RK9_COORD_TOKEN_SCOPES as readonly string[]).includes(row.scope)) return null;
    await db
      .update(rk9CoordTokens)
      .set({ lastUsedAt: now })
      .where(eq(rk9CoordTokens.id, row.id))
      .catch(() => undefined);
    return {
      tokenId: row.id,
      companyId: row.companyId,
      principalKind: row.principalKind,
      principalName: row.principalName,
      scope: row.scope,
      recallAll: row.scope === "recall" && row.recallAll,
    };
  }

  async function issue(
    input: IssueRk9CoordTokenInput,
    audit?: Rk9CoordTokenAudit<Rk9CoordTokenIssueResult>,
  ): Promise<Rk9CoordTokenIssueResult> {
    const scope = input.scope ?? "coord";
    if (input.recallAll && scope !== "recall") {
      throw unprocessable("recallAll is allowed only on a recall-scoped token", {
        code: "rk9_coord_token_recall_all_scope",
      });
    }
    const token = generateRk9CoordToken();
    try {
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(rk9CoordTokens)
          .values({
            companyId: input.companyId,
            principalKind: input.principalKind,
            principalName: input.principalName,
            tokenHash: hashRk9CoordToken(token),
            tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
            scope,
            recallAll: input.recallAll === true,
            label: input.label ?? null,
            expiresAt: input.expiresAt ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();
        const result = { token, record: rk9CoordTokenView(row!) };
        if (audit) await audit(tx as unknown as Db, result);
        return result;
      });
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_PRINCIPAL_UQ)) {
        throw conflict(`This host or service already has an active ${scope} token; rotate or revoke it`, {
          code: "rk9_coord_token_exists",
        });
      }
      throw err;
    }
  }

  async function rotate(input: {
    companyId: string;
    tokenId: string;
    label?: string | null;
    expiresAt?: Date | null;
    createdByUserId?: string | null;
  }, audit?: Rk9CoordTokenAudit<Rk9CoordTokenRotateResult>): Promise<Rk9CoordTokenRotateResult> {
    const token = generateRk9CoordToken();
    return db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(rk9CoordTokens)
        .where(
          and(
            eq(rk9CoordTokens.id, input.tokenId),
            eq(rk9CoordTokens.companyId, input.companyId),
            isNull(rk9CoordTokens.revokedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!old) throw notFound("No active coord token with this id", { code: "rk9_coord_token_not_found" });
      // An inherited expiry that has passed, or that leaves less than the
      // minimum lifetime, would mint a (nearly) dead token and take the
      // active-principal slot: ask for an explicit expiry.
      if (input.expiresAt === undefined && old.expiresAt) {
        const remainingMs = old.expiresAt.getTime() - Date.now();
        if (remainingMs <= 0) {
          throw unprocessable("The token has expired; pass expiresAt (or null for no expiry) to rotate it", {
            code: "rk9_coord_token_expiry_past",
          });
        }
        if (remainingMs < RK9_COORD_TOKEN_MIN_LIFETIME_MS) {
          throw unprocessable(
            "The token expires in less than 60 s; pass expiresAt (or null for no expiry) to rotate it",
            { code: "rk9_coord_token_expiry_too_soon" },
          );
        }
      }
      const [revoked] = await tx
        .update(rk9CoordTokens)
        .set({ revokedAt: new Date() })
        .where(eq(rk9CoordTokens.id, old.id))
        .returning();
      const [row] = await tx
        .insert(rk9CoordTokens)
        .values({
          companyId: old.companyId,
          principalKind: old.principalKind,
          principalName: old.principalName,
          tokenHash: hashRk9CoordToken(token),
          tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
          scope: old.scope,
          recallAll: old.recallAll,
          label: input.label === undefined ? old.label : input.label,
          expiresAt: input.expiresAt === undefined ? old.expiresAt : input.expiresAt,
          createdByUserId: input.createdByUserId ?? null,
          rotatedFromTokenId: old.id,
        })
        .returning();
      const result = { token, record: rk9CoordTokenView(row!), revoked: rk9CoordTokenView(revoked!) };
      if (audit) await audit(tx as unknown as Db, result);
      return result;
    });
  }

  async function revoke(
    input: { companyId: string; tokenId: string },
    audit?: Rk9CoordTokenAudit<Rk9CoordTokenView>,
  ): Promise<Rk9CoordTokenView> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(rk9CoordTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(rk9CoordTokens.id, input.tokenId),
            eq(rk9CoordTokens.companyId, input.companyId),
            isNull(rk9CoordTokens.revokedAt),
          ),
        )
        .returning();
      if (!row) throw notFound("No active coord token with this id", { code: "rk9_coord_token_not_found" });
      const record = rk9CoordTokenView(row);
      if (audit) await audit(tx as unknown as Db, record);
      return record;
    });
  }

  async function list(companyId: string): Promise<Rk9CoordTokenView[]> {
    const rows = await db
      .select()
      .from(rk9CoordTokens)
      .where(eq(rk9CoordTokens.companyId, companyId))
      .orderBy(asc(rk9CoordTokens.createdAt));
    return rows.map(rk9CoordTokenView);
  }

  return { resolve, issue, rotate, revoke, list };
}
// --- /RK9 Custom ---
