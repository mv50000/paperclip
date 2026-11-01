// RK9 Custom (RK9-623): server/scripts/rk9-coord-token.mjs keeps every secret
// out of argv and stdout. The board key comes from the environment, and a new
// token lands only in the --out env file (mode 0600, never overwritten
// without --force).
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/rk9-coord-token.mjs", import.meta.url));
const COMPANY = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const BOARD_KEY = "pcp_board_cliTestKey0123456789";
const TOKEN = `rk9_coord_${"A".repeat(40)}xyz`;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

describe("rk9-coord-token.mjs", () => {
  let server: Server;
  let apiUrl = "";
  let dir = "";
  const seen: Seen[] = [];

  const record = (extra: Record<string, unknown> = {}) => ({
    id: TOKEN_ID,
    principalKind: "host",
    principalName: "mv-laptop",
    tokenPrefix: TOKEN.slice(0, 14),
    label: null,
    expiresAt: null,
    revokedAt: null,
    rotatedFromTokenId: null,
    ...extra,
  });

  async function readBody(req: IncomingMessage) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rk9-coord-token-cli-"));
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      res.setHeader("Content-Type", "application/json");
      const base = `/api/companies/${COMPANY}/rk9/coord-tokens`;
      if (req.method === "POST" && req.url === base) {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: TOKEN, record: record() }));
      } else if (req.method === "POST" && req.url === `${base}/${TOKEN_ID}/rotate`) {
        res.statusCode = 201;
        res.end(JSON.stringify({ token: TOKEN, record: record({ rotatedFromTokenId: TOKEN_ID }) }));
      } else if (req.method === "POST" && req.url === `${base}/${TOKEN_ID}/revoke`) {
        res.end(JSON.stringify({ record: record({ revokedAt: "2026-11-01T00:00:00.000Z" }) }));
      } else if (req.method === "GET" && req.url === base) {
        res.end(JSON.stringify({ tokens: [record()] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: "nope" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    PAPERCLIP_API_KEY: BOARD_KEY,
    PAPERCLIP_API_URL: apiUrl,
    RK9_COORD_COMPANY_ID: COMPANY,
    RK9_COORD_URL: "http://paperclip:3100",
    ...extra,
  });

  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], { env: env(extraEnv) });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("issues a host token into a 0600 env file and prints metadata only", async () => {
    const out = path.join(dir, "nested", "coord.env");
    const res = await run(["issue", "--host", "mv-laptop", "--label", "laptop", "--out", out]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).not.toContain(TOKEN);
    expect(res.stdout).not.toContain(BOARD_KEY);
    expect(JSON.parse(res.stdout)[0]).toMatchObject({ id: TOKEN_ID, tokenPrefix: TOKEN.slice(0, 14), envFile: out });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const content = await readFile(out, "utf8");
    expect(content).toContain(`RK9_COORD_TOKEN=${TOKEN}\n`);
    expect(content).toContain(`RK9_COORD_COMPANY_ID=${COMPANY}\n`);
    expect(content).toContain("RK9_COORD_URL=http://paperclip:3100\n");
    const call = seen.at(-1)!;
    expect(call.authorization).toBe(`Bearer ${BOARD_KEY}`);
    expect(call.body).toEqual({ principalKind: "host", principalName: "mv-laptop", label: "laptop" });
  });

  it("refuses to overwrite an existing file before calling the API", async () => {
    const out = path.join(dir, "existing.env");
    await writeFile(out, "keep\n");
    const before = seen.length;
    const res = await run(["issue", "--service", "rk9claude", "--out", out]);
    expect(res.code).toBe(2);
    expect(seen.length).toBe(before);
    expect(await readFile(out, "utf8")).toBe("keep\n");
    const forced = await run(["rotate", "--id", TOKEN_ID, "--out", out, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await readFile(out, "utf8")).toContain(`RK9_COORD_TOKEN=${TOKEN}`);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });

  it("revokes and lists without touching any file", async () => {
    const revoke = await run(["revoke", "--id", TOKEN_ID]);
    expect(revoke.code, revoke.stderr).toBe(0);
    expect(JSON.parse(revoke.stdout)[0].revokedAt).not.toBeNull();
    const list = await run(["list"]);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(1);
  });

  it("requires the board key in the environment and --out for new tokens", async () => {
    expect((await run(["list"], { PAPERCLIP_API_KEY: "" })).code).toBe(2);
    expect((await run(["issue", "--host", "mv-laptop"])).code).toBe(2);
    expect((await run(["issue", "--host", "a", "--service", "grok", "--out", path.join(dir, "x.env")])).code).toBe(2);
    // There is no flag that takes a token or key value.
    expect((await run(["list", "--token", TOKEN])).code).not.toBe(0);
  });
});
