// RK9 Custom (RK9-317): proxy trust cases for the upstream v2026.916 board mutation guard.
// Prod runs with TRUST_PROXY=loopback behind a local nginx. PAPERCLIP_PUBLIC_URL stays unset
// here: the guard always trusts that origin, so it cannot show whether X-Forwarded-Host is
// trusted (doc/upgrade/defaults-hardening.md, "Proxy trust ja X-Forwarded-Host").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";

function createApp(trustProxy?: string) {
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board", source: "session" } as typeof req.actor;
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("board mutation guard proxy trust (RK9-317)", () => {
  let savedPublicUrl: string | undefined;

  beforeEach(() => {
    savedPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.PAPERCLIP_PUBLIC_URL;
  });

  afterEach(() => {
    if (savedPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = savedPublicUrl;
  });

  it("lets a trusted loopback proxy supply X-Forwarded-Host", async () => {
    const res = await request(createApp("loopback"))
      .post("/mutate")
      .set("Host", "127.0.0.1:3100")
      .set("X-Forwarded-Host", "paperclip.rk9.fi")
      .set("Origin", "https://paperclip.rk9.fi");
    expect(res.status).toBe(204);
  });

  it("ignores X-Forwarded-Host from an untrusted peer when trust proxy is loopback", () => {
    const app = createApp("loopback");
    const compiled = app.get("trust proxy fn") as (address: string, hop: number) => boolean;
    const trustProxyFn = vi.fn(compiled);
    const headers: Record<string, string> = {
      host: "127.0.0.1:3100",
      "x-forwarded-host": "evil.example",
      origin: "https://evil.example",
    };
    const req = {
      method: "POST",
      actor: { type: "board", userId: "board", source: "session" },
      header: (name: string) => headers[name.toLowerCase()],
      socket: { remoteAddress: "10.90.10.20" },
      app: { get: (key: string) => (key === "trust proxy fn" ? trustProxyFn : undefined) },
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    boardMutationGuard()(req, res, next);

    expect(trustProxyFn).toHaveBeenCalledWith("10.90.10.20", 0);
    expect(trustProxyFn).toHaveReturnedWith(false);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ignores X-Forwarded-Host from a loopback peer when trust proxy is unset", async () => {
    const res = await request(createApp())
      .post("/mutate")
      .set("Host", "127.0.0.1:3100")
      .set("X-Forwarded-Host", "evil.example")
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
  });
});
