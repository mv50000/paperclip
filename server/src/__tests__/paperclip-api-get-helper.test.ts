import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The read helper must print only the response body so agents can pipe it into
// jq; the HTTP status goes to stderr and a non-2xx answer exits 1.
const HELPER_PATH = path.resolve("skills/paperclip/scripts/paperclip-api-get.sh");

interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("paperclip api get helper", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
  });

  async function startServer(
    respond: (url: string, attempt: number, res: http.ServerResponse) => void,
  ): Promise<{ baseUrl: string; urls: string[] }> {
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      urls.push(req.url ?? "");
      respond(req.url ?? "", urls.length, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanupFns.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, urls };
  }

  function runHelper(apiUrl: string, args: string[]): Promise<HelperResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [HELPER_PATH, ...args], {
        env: { ...process.env, PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: "test-key" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("prints only the JSON body and accepts an /api-suffixed base URL", async () => {
    const { baseUrl, urls } = await startServer((_url, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "issue-1", status: "todo" }));
    });

    const result = await runHelper(`${baseUrl}/api/`, ["/api/issues/ALL-1"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "issue-1", status: "todo" });
    expect(urls).toEqual(["/api/issues/ALL-1"]);
  });

  it("writes the body to --out", async () => {
    const { baseUrl } = await startServer((_url, _attempt, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-api-get-"));
    cleanupFns.push(() => fs.rm(root, { recursive: true, force: true }));
    const out = path.join(root, "comments.json");

    const result = await runHelper(baseUrl, ["issues/ALL-1/comments", "--out", out]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(await fs.readFile(out, "utf8"))).toEqual([]);
  });

  it("exits 1 on a 4xx without retrying and keeps stdout empty", async () => {
    const { baseUrl, urls } = await startServer((_url, _attempt, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    const result = await runHelper(baseUrl, ["issues/ALL-404"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HTTP 404");
    expect(urls).toHaveLength(1);
  });

  it("retries a 5xx once", async () => {
    const { baseUrl, urls } = await startServer((_url, attempt, res) => {
      res.writeHead(attempt === 1 ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: attempt !== 1 }));
    });

    const result = await runHelper(baseUrl, ["agents/me"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(urls).toHaveLength(2);
  });
});
