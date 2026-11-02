// RK9 Custom (RK9-625): coord presence API. Auth and company scope, 422
// validation, idempotent upsert, the TTL death rule with an injected clock,
// the read-only heartbeat_runs projection and phase redaction (RK9-549
// fixtures). Contract: docs/implementation-notes/coord-bus.md ("Presence API").
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  rk9CoordActors,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { rk9CoordRoutes } from "../routes/rk9-coord.js";
import { isRk9CoordCredentialName, rk9CoordMetadataHasSecret } from "../routes/rk9-coord-actors.js";
import {
  RK9_COORD_SECRET_RX_DEFAULT,
  collapseRk9CoordText,
  redactRk9CoordText,
  rk9CoordMatchText,
  toRk9CoordLine,
} from "../services/rk9-coord-redact.js";
import { rk9CoordPresenceService } from "../services/rk9-coord-presence.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("coord redaction (RK9_SESSIONS_SECRET_RX port)", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("matches the bash default copied from rk9-sessions.sh", async () => {
    const script = await readFile(`${process.env.HOME}/.claude/bin/rk9-sessions.sh`, "utf8").catch(() => null);
    if (!script) return; // claude-config is not on CI; the fixtures below still pin the behaviour.
    const line = script.split("\n").find((l) => l.startsWith("export RK9_SESSIONS_SECRET_RX="));
    expect(line).toBeDefined();
    const quoted = line!.slice(line!.indexOf(":-'") + 3, line!.lastIndexOf("'}"));
    expect(quoted.replaceAll(`'"'"'`, "'")).toBe(RK9_COORD_SECRET_RX_DEFAULT);
  });

  it.each([
    // RK9-549 (rk9-sessions-test.sh)
    ["Korjaa login-bugi token=supersecret123", "Korjaa login-bugi [redacted]"],
    // pcp-headsup-test.sh B1-B1d
    ["Avain ghp_abc vuotaa", "Avain ghp_abc vuotaa"],
    ["Avain ghp_abcdefgh123 vuotaa", "Avain [redacted] vuotaa"],
    // Fake values are split so the repo secret scan does not flag the fixtures.
    [`Bearer abcdefghijk ja ${"sk_" + "live_"}51Habcdefgh`, "[redacted] ja [redacted]"],
    ["API_KEY ja token budget mainitaan vakiasti", "API_KEY ja token budget mainitaan vakiasti"],
    // case-insensitive, like re.I
    ["PASSWORD: hunter2hunter2 ok", "[redacted] ok"],
    ["clone https://user:pa55word@github.com/x", "clone https[redacted]github.com/x"],
    [`${"AKIA" + "ABCDEFGHIJ"}KLMNOP leaked`, "[redacted] leaked"],
    // the bus's own token is always redacted
    ["coord rk9_coord_AbCdEfGhIjKlMnOp", "coord [redacted]"],
    // plural keyword forms (verifier round 4)
    ["tokens=abcdefghijkl ok", "[redacted] ok"],
    ["passwords: hunter2hunter2", "[redacted]"],
  ])("redacts %j", (input, expected) => {
    expect(redactRk9CoordText(input, env)).toBe(expected);
  });

  it.each([
    // C0 controls that JS \s misses must not hide a secret (verifier round 1).
    ["Bearer\u0001abcdefghijklmnop", "[redacted]"],
    ["token\u0001=\u0001supersecret123", "[redacted]"],
    ["password\u0002:hunter2hunter2", "[redacted]"],
    ["Bearer\u001fabcdefghijk", "[redacted]"],
    // zero-width characters are removed before matching
    ["token\u200b=supersecret123", "[redacted]"],
    ["Bear\ufeffer abcdefghijkl", "[redacted]"],
  ])("collapses control characters before redacting %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it("collapses to one line, caps at 140 code points and redacts before the cap", () => {
    expect(toRk9CoordLine("  a\n\tb  ", 140, env)).toBe("a b");
    expect(toRk9CoordLine("   ", 140, env)).toBeNull();
    expect(toRk9CoordLine("x".repeat(500), 140, env)).toHaveLength(140);
    expect(Array.from(toRk9CoordLine("😀".repeat(200), 140, env)!)).toHaveLength(140);
    const secretAtCap = `${"y".repeat(130)} ghp_abcdefghijklmnop`;
    expect(toRk9CoordLine(secretAtCap, 140, env)).not.toContain("ghp_");
  });

  // RK9-642: the full invisible list; ZWJ stays in display text, goes for matching.
  it.each([
    ["token=\u00adsupersecret123", "[redacted]"],
    ["pass\u00adword=hunter2hunter2", "[redacted]"],
    ["pass\u2061word=hunter2hunter2", "[redacted]"],
    ["pass\u2064word=hunter2hunter2", "[redacted]"],
    ["pass\u180eword=hunter2hunter2", "[redacted]"],
    ["pass\u034fword=hunter2hunter2", "[redacted]"],
    ["pass\u200dword=hunter2hunter2 ok", "[redacted] ok"],
    ["Bearer\u202e abcdefghijkl", "[redacted]"],
    // verifier round 1 (RK9-642): an invisible character as the only separator, non-Cf fillers
    ["Bearer\u200babcdefgh12345", "[redacted]"],
    ["pass\u3164word=hunter2hunter2", "[redacted]"],
    ["pass\u0301word=hunter2hunter2", "[redacted]"],
    ["pass\u{E0100}word=hunter2hunter2", "[redacted]"],
  ])("redacts a keyword split by an invisible character %j", (input, expected) => {
    expect(toRk9CoordLine(input, 140, env)).toBe(expected);
  });

  it("keeps ZWJ in display text and strips it only for matching", () => {
    const dev = "coding \u{1F469}\u200d\u{1F4BB} now";
    expect(toRk9CoordLine(dev, 140, env)).toBe(dev);
    expect(collapseRk9CoordText("a\u00adb\u2061c\u180ed\u034fe\u200df\u200bg")).toBe("abcde\u200dfg");
    expect(rk9CoordMatchText("a\u00adb\u2061c\u180ed\u034fe\u200df\u202eg")).toBe("abcdefg");
  });

  it("falls back to the default when the env pattern is not a valid JS RegExp", () => {
    expect(redactRk9CoordText("token=supersecret123", { RK9_SESSIONS_SECRET_RX: "(" } as NodeJS.ProcessEnv)).toBe(
      "[redacted]",
    );
  });
});

// RK9-642: the RK9-625 round-5 verifier cases. Fake values only.
describe("presence metadata secret check", () => {
  it.each([
    "password", "passwords", "PassWords", "secret", "secrets", "github_token", "githubToken", "DB_PASSWORD",
    "api_key", "api-keys", "apiKey", "myApiKey", "passwd", "secret_value", "aws.secret", "pass\u00adword",
    // compound names (verifier round 1): the keyword need not end the name
    "SECRET_KEY", "aws_secret_access_key", "secretAccessKey", "api_key_prod", "apiKeyProd", "GITHUB_TOKEN_RW",
    "token_prod", "password_new", "password1", "secrets_prod", "password_hash", "DBPassword", "GITHUBToken",
    "Password:",
  ])("treats %j as a credential name", (name) => {
    expect(isRk9CoordCredentialName(name)).toBe(true);
  });

  it.each([
    "tokens_used", "token_count", "secret_scan", "tokenizer", "secretary", "password_policy", "tokensUsed", "note",
    "token_type", "secret_name", "access_token_expiry", "max_tokens_limit",
  ])("does not treat %j as a credential name", (name) => {
    expect(isRk9CoordCredentialName(name)).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    // round-4 repro
    ["array under a credential key", { password: ["hunter2hunter2"] }],
    ["nested object under secret", { secret: { db: "hunter2hunter2" } }],
    ["nested object under secrets", { secrets: { db: "hunter2hunter2" } }],
    ["nested object under passwords", { passwords: { prod: "hunter2hunter2" } }],
    ["array under api_key", { api_key: ["abcdef123456"] }],
    ["ZWSP inside a keyword in a value", { a: "pass\u200bword=hunter2hunter2" }],
    // zero-width list (LOW)
    ["ZWSP inside a key", { "pass\u200bword": ["hunter2hunter2"] }],
    ["soft hyphen inside a key", { "pass\u00adword": "hunter2hunter2" }],
    ["invisible separator inside a key", { "pass\u2063word": "hunter2hunter2" }],
    ["CGJ inside a key", { "pass\u034fword": "hunter2hunter2" }],
    ["ZWJ inside a key", { "pass\u200dword": "hunter2hunter2" }],
    // secret used as a key (LOW)
    ["secret as a key under a credential key", { password: { hunter2hunter2: true } }],
    ["secret as a key with an empty value", { secrets: { hunter2hunter2: {} } }],
    // keyword given as a value (MEDIUM)
    ["name/value pair object", { env: [{ name: "PASSWORD", value: "hunter2hunter2" }] }],
    ["key/val pair object", { headers: [{ key: "api_key", val: "abcdef123456" }] }],
    ["two-item tuple in a list", { env: [["DB_PASSWORD", "hunter2hunter2"]] }],
    ["two-item tuple", { env: ["DB_PASSWORD", "hunter2hunter2"] }],
    ["camelCase key", { githubToken: "abcdefghijkl" }],
    ["deep arrays under a mixed-case key", { PassWords: [[["hunter2hunter2"]]] }],
    ["leading space in the value", { password: " hunter2hunter2" }],
    ["ZWSP after Bearer", { note: "Bearer\u200b abcdefghijkl" }],
    ["numeric password sent as a string", { password: "12345678" }],
    // verifier round 1 (RK9-642)
    ["SECRET_KEY", { SECRET_KEY: "django-insecure-abc123xyz" }],
    ["aws_secret_access_key", { aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE" }],
    ["secrets_prod nested", { secrets_prod: { db: "hunter2hunter2" } }],
    ["acronym camelCase in a pair", { env: [{ name: "DBPassword", value: "hunter2hunter2" }] }],
    ["trailing punctuation in a pair name", { env: [{ name: "Password:", value: "hunter2hunter2" }] }],
    ["CloudFormation parameter", { params: [{ ParameterKey: "DbPassword", ParameterValue: "hunter2hunter2" }] }],
    ["k/v pair", { env: [{ k: "PASSWORD", v: "hunter2hunter2" }] }],
    ["name, separator, value", { env: [["DB_PASSWORD", "=", "hunter2hunter2"]] }],
    ["argv flag", { args: ["mysql", "--password", "hunter2hunter2"] }],
    ["invisible character as the only separator", { note: "Bearer\u200babcdefgh12345" }],
    ["Hangul filler inside a keyword", { note: "pass\u3164word=hunter2hunter2" }],
  ])("flags %s", (_label, metadata) => {
    expect(rk9CoordMetadataHasSecret(metadata)).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    // false positives of the unanchored key rule (MEDIUM)
    ["tokens_used", { tokens_used: 123456 }],
    ["context_tokens", { context_tokens: 291000 }],
    ["max_tokens", { max_tokens: 200000 }],
    ["secret_scan", { secret_scan: "passed" }],
    ["token_count", { token_count: 12 }],
    ["tmux_pane", { tmux_pane: "%12" }],
    ["branch", { branch: "rk9/RK9-625-presence" }],
    ["tokenizer", { tokenizer: "cl100k_base" }],
    ["secretary", { secretary: "Anne Lahti" }],
    ["password_policy", { password_policy: "strict" }],
    ["counter map under tokens", { tokens: { input: 1234, output: 56 } }],
    ["input_tokens", { usage: { input_tokens: 123456 } }],
    ["maxTokens", { maxTokens: 200000 }],
    ["name/value pair with a plain name", { env: [{ name: "EDITOR", value: "vim-nox" }] }],
    ["two-item tuple with a plain name", { env: ["EDITOR", "vim-nox"] }],
    ["three-item list starting with a credential name", { tags: ["token", "billing", "usage"] }],
    ["ZWJ emoji", { face: "\u{1F469}\u200d\u{1F4BB}" }],
    ["pair object without a value key", { field: "password", status: "rotated" }],
    ["token_type", { token_type: "Bearer" }],
  ])("accepts %s", (_label, metadata) => {
    expect(rk9CoordMetadataHasSecret(metadata)).toBe(false);
  });
});

describe("presence service source contract", () => {
  it("never writes heartbeat_runs and the heartbeat service does not know about presence", async () => {
    const service = await readFile(new URL("../services/rk9-coord-presence.ts", import.meta.url), "utf8");
    expect(service).not.toMatch(/\.(insert|update|delete)\(\s*heartbeatRuns/);
    expect(service).toContain('accessMode: "read only"');
    const heartbeat = await readFile(new URL("../services/heartbeat.ts", import.meta.url), "utf8");
    expect(heartbeat).not.toMatch(/rk9[-_]?coord/i);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`[rk9-coord-actors] embedded Postgres unsupported, DB suite skipped: ${support.reason ?? "unknown"}`);
}

(support.supported ? describe : describe.skip)("coord presence API against Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let readOnlyDb!: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let agentId = "";
  let otherAgentId = "";
  let issueId = "";
  const runningRunId = randomUUID();
  const finishedRunId = randomUUID();
  const staleRunId = randomUUID();
  const otherCompanyRunId = randomUUID();
  let clock = new Date();
  const env = { RK9_COORD_PRESENCE_TTL_S: "300" } as NodeJS.ProcessEnv;

  type Actor = Express.Request["actor"];
  const operatorKey = (): Actor => ({
    type: "board",
    userId: "operator-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true,
    keyId: "board-key-1",
    source: "board_key",
  });
  const otherBoardUser = (): Actor => ({
    type: "board",
    userId: "other-user",
    companyIds: [otherCompanyId],
    memberships: [{ companyId: otherCompanyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    keyId: "board-key-2",
    source: "board_key",
  });
  const agentKey = (): Actor => ({
    type: "agent",
    agentId,
    companyId,
    keyId: "agent-key-1",
    keyScope: { kind: "standard" },
    runId: runningRunId,
    source: "agent_key",
  });

  function makeApp(actor: Actor, database = db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(
      "/api",
      rk9CoordRoutes(database, {
        boardHost: "paperclip-01",
        boardKeyIds: null,
        presence: { now: () => clock, env },
      }),
    );
    app.use(errorHandler);
    return app;
  }

  const base = (cid = companyId) => `/api/companies/${cid}/rk9/coord/actors`;
  const CC = "cc:paperclip-01:sess-1";

  async function registrations(actorRef: string) {
    const rows = await db
      .select({ id: activityLog.id, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "rk9.coord.actor_registered")));
    return rows.filter((r) => (r.details as { actorRef?: string } | null)?.actorRef === actorRef);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rk9-coord-actors-");
    db = createDb(tempDb.connectionString);
    const roUrl = new URL(tempDb.connectionString);
    roUrl.searchParams.set("default_transaction_read_only", "on");
    readOnlyDb = createDb(roUrl.toString());
    await db.insert(companies).values([
      { id: companyId, name: "RK9 presence", issuePrefix: "RKP" },
      { id: otherCompanyId, name: "Other presence", issuePrefix: "RKQ" },
    ]);
    const [agent, otherAgent] = await db
      .insert(agents)
      .values([
        { companyId, name: "Presence Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
        { companyId: otherCompanyId, name: "Other Coder", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      ])
      .returning();
    agentId = agent!.id;
    otherAgentId = otherAgent!.id;
    const [issue] = await db
      .insert(issues)
      .values({ companyId, identifier: "RKP-7", title: "Presence target", status: "in_progress", priority: "medium" })
      .returning();
    issueId = issue!.id;
  }, 60_000);

  beforeEach(async () => {
    clock = new Date();
    await db.delete(activityLog);
    await db.delete(rk9CoordActors);
    await db.delete(heartbeatRuns);
    const started = new Date(clock.getTime() - 90_000);
    const old = new Date(clock.getTime() - 3 * 3600_000);
    await db.insert(heartbeatRuns).values([
      { id: runningRunId, companyId, agentId, status: "running", startedAt: started, createdAt: started, updatedAt: started, contextSnapshot: { issueId } },
      { id: finishedRunId, companyId, agentId, status: "succeeded", startedAt: started, finishedAt: clock, contextSnapshot: { issueId } },
      { id: staleRunId, companyId, agentId, status: "running", startedAt: old, createdAt: old, updatedAt: old, lastOutputAt: old, contextSnapshot: { taskId: "not-a-uuid" } },
      { id: otherCompanyRunId, companyId: otherCompanyId, agentId: otherAgentId, status: "running", startedAt: started, updatedAt: started },
    ]);
  });

  afterAll(async () => {
    await readOnlyDb?.$client?.end?.({ timeout: 0 });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("upserts idempotently by actor_ref and logs only the first registration", async () => {
    const app = makeApp(operatorKey());
    const body = { kind: "cc", host: "paperclip-01", external_id: "sess-1", name: "Presence work", issue: "RKP-7", repo: "paperclip", branch: "work/RKP-7", phase: "coding", client_event_id: "c-1" };
    const first = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ actorId: CC, kind: "cc", host: "paperclip-01", trust: "attributed", created: true, ttlS: 300 });
    const second = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.created).toBe(false);
    const rows = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "sess-1", host: "paperclip-01", repo: "paperclip", branch: "work/RKP-7", phase: "coding" });
    const logged = await registrations(CC);
    expect(logged).toHaveLength(1);
  });

  it("counts a stub row inserted by another coord route as unregistered until the first PUT", async () => {
    await db.insert(rk9CoordActors).values({
      companyId,
      kind: "cc",
      actorRef: "cc:paperclip-01:stub",
      host: "paperclip-01",
      externalId: "stub",
      trust: "attributed",
      livenessSource: "hook",
    });
    const app = makeApp(operatorKey());
    const put = await request(app).put(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:stub").send({ phase: "x" });
    expect(put.status).toBe(200);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:stub").send({ phase: "y" });
    expect(await registrations("cc:paperclip-01:stub")).toHaveLength(1);
  });

  it("logs exactly one registration for concurrent first PUTs", async () => {
    const app = makeApp(operatorKey());
    const ref = "cc:paperclip-01:race";
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).put(`${base()}/me`).set("X-RK9-Actor", ref).send({ phase: "go" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(await registrations(ref)).toHaveLength(1);
  });

  it("keeps the registration marker out of client hands", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { presence_registered_at: "x", a: 1 } });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { b: 2 } });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).toMatchObject({ b: 2 });
    expect(row!.metadata).not.toHaveProperty("a");
    expect(String(row!.metadata.presence_registered_at)).not.toBe("x");
    expect(await registrations(CC)).toHaveLength(1);
  });

  it("answers 422 to a secret in a field that is stored verbatim", async () => {
    const app = makeApp(operatorKey());
    for (const body of [
      { branch: "fix/token=supersecret123" },
      { external_id: "rk9_coord_AbCdEfGhIjKl" },
      { metadata: { note: "rk9_coord_AbCdEfGhIjKl" } },
      // JSON escaping must not hide whitespace from the pattern (verifier round 2).
      { metadata: { note: "Bearer\nabcdefghijklmnop" } },
      { metadata: { note: "Bearer\tabcdefghijklmnop" } },
      { metadata: { note: "token\u0001=\u0001supersecret123" } },
      { metadata: { nested: [{ "token=supersecret123": 1 }] } },
      // key/value form (verifier round 3)
      { metadata: { password: "hunter2hunter2" } },
      { metadata: { github_token: "abcdefghijkl" } },
      { metadata: { aws: { secret: "abcdefghijkl" } } },
      { metadata: { url: "https://user:pass\tword@host" } },
      // a credential-named key above an array or nested object (verifier round 4)
      { metadata: { password: ["hunter2hunter2"] } },
      { metadata: { api_key: ["abcdef123456"] } },
      { metadata: { secret: { db: "hunter2hunter2" } } },
      { metadata: { secrets: { db: "hunter2hunter2" } } },
      { metadata: { passwords: { prod: ["hunter2hunter2"] } } },
      { metadata: { tokens: "abcdefghijkl" } },
      { metadata: { note: "secrets=abcdefghijkl" } },
      { branch: "Bearer\u0085abcdefghijk" },
      // RK9-642 (verifier round 5)
      { metadata: { env: [{ name: "PASSWORD", value: "hunter2hunter2" }] } },
      { metadata: { env: [["DB_PASSWORD", "hunter2hunter2"]] } },
      { metadata: { password: { hunter2hunter2: true } } },
      { metadata: { "pass\u00adword": "hunter2hunter2" } },
    ]) {
      const res = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
      expect(res.status).toBe(422);
    }
    expect(await db.select().from(rk9CoordActors)).toHaveLength(0);
  });

  it("measures the metadata cap in UTF-8 bytes", async () => {
    const app = makeApp(operatorKey());
    // 1500 emoji = 3000 UTF-16 units but 6000 UTF-8 bytes.
    const res = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { e: "😀".repeat(1500) } });
    expect(res.status).toBe(422);
  });

  it("accepts plain metadata under keys that are not credential names", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({ metadata: { tmux: { window: "@12", panes: ["main-pane", "logs-pane"] }, attempt: 3 } });
    expect(res.status).toBe(201);
  });

  it("accepts token counts and keys that only contain a credential word (RK9-642)", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({
        metadata: {
          tokens_used: 123456,
          max_tokens: 200000,
          secret_scan: "passed",
          tokenizer: "cl100k_base",
          usage: { input_tokens: 123456, tokens: { input: 1234, output: 56 } },
        },
      });
    expect(res.status).toBe(201);
  });

  it("accepts legitimate metadata: a backslash-u0000 literal and a real emoji", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app)
      .put(`${base()}/me`)
      .set("X-RK9-Actor", CC)
      .send({ metadata: { path: "C:\\u0000dir", face: "😀" } });
    expect(res.status).toBe(201);
  });

  it("clears a stale client_external_id once the client id matches", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "other" });
    let [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata.client_external_id).toBe("other");
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "sess-1" });
    [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).not.toHaveProperty("client_external_id");
  });

  it("keeps client_external_id server-owned", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ metadata: { client_external_id: "forged" } });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.metadata).not.toHaveProperty("client_external_id");
  });

  it("refreshes trust on phase updates and ends", async () => {
    await db.insert(rk9CoordActors).values({ companyId, kind: "cc", actorRef: CC, host: "paperclip-01", trust: "verified" });
    const app = makeApp(operatorKey());
    await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "x" });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.trust).toBe("attributed");
  });

  it("updates phase without an activity row and shows it in GET at once", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ phase: "start" });
    const before = (await registrations(CC)).length;
    clock = new Date(clock.getTime() + 500);
    const phase = await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "running tests" });
    expect(phase.status).toBe(200);
    expect(phase.body.phase).toBe("running tests");
    expect((await registrations(CC)).length).toBe(before);
    const allLogs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(allLogs.some((r) => r.action !== "rk9.coord.actor_registered")).toBe(false);
    const list = await request(app).get(`${base()}?active=1`).set("X-RK9-Actor", CC);
    expect(list.status).toBe(200);
    expect(list.body.actors.find((a: { actorId: string }) => a.actorId === CC)).toMatchObject({ phase: "running tests", lastSeenS: 0 });
  });

  it("answers rk9_coord_actor_not_found to a phase without a registration", async () => {
    const app = makeApp(operatorKey());
    const res = await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", "cc:paperclip-01:ghost").send({ phase: "x" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("rk9_coord_actor_not_found");
  });

  it("redacts and caps the phase before storage (RK9-549 fixture)", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ phase: "Korjaa login-bugi token=supersecret123" });
    let [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.phase).toBe("Korjaa login-bugi [redacted]");
    await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: `${"z".repeat(300)} ghp_abcdefghijk` });
    [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, CC));
    expect(row!.phase).toHaveLength(140);
    expect(row!.phase).not.toContain("ghp_");
  });

  it("ends idempotently and drops the actor from active lists at once", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    const end = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", CC).send({ external_id: "sess-1", host: "paperclip-01" });
    expect(end.status).toBe(204);
    const again = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", CC);
    expect(again.status).toBe(204);
    const never = await request(app).delete(`${base()}/me`).set("X-RK9-Actor", "cc:paperclip-01:never");
    expect(never.status).toBe(204);
    const active = await request(app).get(`${base()}?active=1`);
    expect(active.body.actors.map((a: { actorId: string }) => a.actorId)).not.toContain(CC);
    const all = await request(app).get(`${base()}?active=0`);
    expect(all.body.actors.map((a: { actorId: string }) => a.actorId)).toContain(CC);
  });

  it("drops a kill -9'd actor after the TTL plus one refresh, with no cleanup step", async () => {
    const app = makeApp(operatorKey());
    const live = "cc:paperclip-01:live";
    const dead = "cc:paperclip-01:dead";
    const t0 = clock.getTime();
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", dead).send({});
    // `live` refreshes every 200 s; `dead` was killed and never sends again.
    clock = new Date(t0 + 200_000);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    clock = new Date(t0 + 299_000);
    let ids = (await request(app).get(`${base()}?active=1`)).body.actors.map((a: { actorId: string }) => a.actorId);
    expect(ids).toEqual(expect.arrayContaining([live, dead]));
    clock = new Date(t0 + 400_000);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", live).send({});
    ids = (await request(app).get(`${base()}?active=1`)).body.actors.map((a: { actorId: string }) => a.actorId);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead);
    // The row still exists: liveness is a read rule, not a delete.
    const rows = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, dead));
    expect(rows[0]!.endedAt).toBeNull();
  });

  it("filters by repo and issue and returns compact rows", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ repo: "mv50000/paperclip", branch: "work/RKP-7", issue: "RKP-7", name: "A" });
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "worktree:RKP-8").send({ repo: "bk" });
    const byRepo = await request(app).get(`${base()}?active=1&repo=paperclip`);
    expect(byRepo.body.actors).toEqual([
      expect.objectContaining({ actorId: CC, kind: "cc", host: "paperclip-01", name: "A", issue: "RKP-7", repoBranch: "mv50000/paperclip@work/RKP-7", phase: null, ageS: 0 }),
    ]);
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", "worktree:RKP-9").send({ repo: "o/myXrepo" });
    const underscore = await request(app).get(`${base()}?repo=my_repo`);
    expect(underscore.body.actors).toEqual([]);
        const byIssue = await request(app).get(`${base()}?issue=RKP-8`);
    expect(byIssue.body.actors.map((a: { actorId: string }) => a.actorId)).toEqual(["worktree:RKP-8"]);
  });

  it("projects running heartbeat runs as agent_run rows without writing anything", async () => {
    const before = await db.select().from(heartbeatRuns);
    // A connection whose every transaction is READ ONLY: any INSERT or UPDATE
    // on any table would fail the request.
    const app = makeApp(operatorKey(), readOnlyDb);
    const res = await request(app).get(`${base()}?active=1`);
    expect(res.status).toBe(200);
    const runs = res.body.actors.filter((a: { kind: string }) => a.kind === "agent_run");
    expect(runs).toEqual([
      {
        actorId: `agent_run:${runningRunId}`,
        kind: "agent_run",
        host: null,
        name: "Presence Coder",
        issue: "RKP-7",
        repo: null,
        branch: null,
        repoBranch: null,
        phase: null,
        trust: "verified",
        ageS: 90,
        lastSeenS: 90,
        runStatus: "running",
        source: "heartbeat_run",
      },
    ]);
    const byIssue = await request(app).get(`${base()}?issue=RKP-7`);
    expect(byIssue.body.actors.map((a: { actorId: string }) => a.actorId)).toEqual([`agent_run:${runningRunId}`]);
    const byRepo = await request(app).get(`${base()}?repo=paperclip`);
    expect(byRepo.body.actors).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual(before);
    // The read-only connection really rejects writes.
    await expect(readOnlyDb.insert(rk9CoordActors).values({ companyId, kind: "orch", actorRef: "orch:x", trust: "attributed" })).rejects.toThrow();
  });

  it("registers an agent run once and does not list it twice", async () => {
    const app = makeApp(agentKey());
    const put = await request(app).put(`${base()}/me`).send({ phase: "working" });
    expect(put.status).toBe(201);
    expect(put.body).toMatchObject({ actorId: `agent_run:${runningRunId}`, trust: "attributed" });
    const [row] = await db.select().from(rk9CoordActors).where(eq(rk9CoordActors.actorRef, `agent_run:${runningRunId}`));
    expect(row).toMatchObject({ agentId, runId: runningRunId, host: null, externalId: runningRunId });
    const logged = await db.select().from(activityLog).where(eq(activityLog.entityId, put.body.id));
    expect(logged[0]).toMatchObject({ actorType: "agent", agentId, runId: runningRunId });
    const list = await request(app).get(`${base()}?active=1`);
    const mine = list.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: "presence", phase: "working" });
    // Ending the presence row does not hide a run that is still running.
    await request(app).delete(`${base()}/me`);
    const after = await request(app).get(`${base()}?active=1`);
    const projected = after.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(projected).toEqual([expect.objectContaining({ source: "heartbeat_run", runStatus: "running" })]);
    const all = await request(app).get(`${base()}?active=0`);
    const both = all.body.actors.filter((a: { actorId: string }) => a.actorId === `agent_run:${runningRunId}`);
    expect(both.map((a: { source: string }) => a.source).sort()).toEqual(["heartbeat_run", "presence"]);
  });

  it("rejects another company's cid for agent keys and board users", async () => {
    const agentOther = await request(makeApp(agentKey())).put(`${base(otherCompanyId)}/me`).send({});
    expect(agentOther.status).toBe(403);
    const agentList = await request(makeApp(agentKey())).get(base(otherCompanyId));
    expect(agentList.status).toBe(403);
    const boardOther = await request(makeApp(otherBoardUser())).get(base());
    expect(boardOther.status).toBe(403);
    const boardPut = await request(makeApp(otherBoardUser())).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    expect(boardPut.status).toBe(403);
    expect(await db.select().from(rk9CoordActors)).toHaveLength(0);
  });

  it.each([
    [{ kind: "bogus" }],
    [{ host: "Paperclip-01" }],
    [{ external_id: "has space" }],
    [{ external_id: "" }],
    [{ phase: "p".repeat(1001) }],
    [{ issue: "not an issue" }],
    [{ repo: "a/b/c" }],
    [{ pid: -1 }],
    [{ branch: "a\u0000b" }],
    [{ branch: "a\u0001b" }],
    [{ metadata: { a: "x\u0000y" } }],
    [{ metadata: { a: "\ud800" } }],
    [{ metadata: { "\udc00": 1 } }],
    [{ metadata: JSON.parse(`{"a":${"[".repeat(3000)}${"]".repeat(3000)}}`) }],
    [{ metadata: JSON.parse(`{"a":${"[".repeat(20)}1${"]".repeat(20)}}`) }],
    [{ unknown: true }],
  ])("answers 422 to an invalid PUT body %j", async (body) => {
    const res = await request(makeApp(operatorKey())).put(`${base()}/me`).set("X-RK9-Actor", CC).send(body);
    expect(res.status).toBe(422);
  });

  it("answers 422 to a bad phase body or list query", async () => {
    const app = makeApp(operatorKey());
    await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({});
    expect((await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({})).status).toBe(422);
    expect((await request(app).post(`${base()}/me/phase`).set("X-RK9-Actor", CC).send({ phase: "p".repeat(1001) })).status).toBe(422);
    expect((await request(app).get(`${base()}?active=yes`)).status).toBe(422);
    expect((await request(app).get(`${base()}?limit=0`)).status).toBe(422);
  });

  it("rejects a body kind or host that contradicts the resolved actor", async () => {
    const app = makeApp(operatorKey());
    const kind = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ kind: "worktree" });
    expect(kind.status).toBe(403);
    expect(kind.body.code).toBe("rk9_coord_actor_spoof");
    const host = await request(app).put(`${base()}/me`).set("X-RK9-Actor", CC).send({ host: "mv-laptop" });
    expect(host.status).toBe(403);
    expect(host.body.code).toBe("rk9_coord_host_mismatch");
  });

  it("keeps the actor middleware in front: mutation without an actor id is 400", async () => {
    const res = await request(makeApp(operatorKey())).put(`${base()}/me`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("rk9_coord_actor_required");
  });

  it("service list honours the injected TTL env", async () => {
    const svc = rk9CoordPresenceService(db, { now: () => clock, env: { RK9_COORD_PRESENCE_TTL_S: "60" } as NodeJS.ProcessEnv });
    await svc.upsert({ companyId, kind: "orch", actorId: "orch:ttl", host: "paperclip-01", trust: "attributed" }, {});
    clock = new Date(clock.getTime() + 61_000);
    const rows = await svc.list(companyId, { active: true });
    expect(rows.map((r) => r.actorId)).not.toContain("orch:ttl");
  });
});
