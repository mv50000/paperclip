import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { applyTrustProxy, parseTrustProxyEnv } from "../middleware/trust-proxy.js";

// RK9 Custom (RK9-314): prod runs behind edge nginx 192.168.1.17 -> local nginx on
// 127.0.0.1 -> Express, so Express must trust only loopback (TRUST_PROXY=loopback).
// Supertest connects from loopback, so the difference below proves the setting.
// See doc/upgrade/defaults-hardening.md, "TRUST_PROXY tulee mukaan".
function appWith(raw: string | undefined) {
  const app = express();
  applyTrustProxy(app, parseTrustProxyEnv(raw));
  app.get("/ip", (req, res) => {
    res.json({ ip: req.ip, protocol: req.protocol });
  });
  return app;
}

describe("TRUST_PROXY=loopback (RK9 prod proxy chain)", () => {
  it("reads the client address from X-Forwarded-For when the peer is loopback", async () => {
    const res = await request(appWith("loopback"))
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe("203.0.113.7");
    expect(res.body.protocol).toBe("https");
  });

  it("ignores X-Forwarded-For when TRUST_PROXY is unset (upstream default)", async () => {
    const res = await request(appWith(undefined))
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe("203.0.113.7");
    expect(res.body.protocol).toBe("http");
  });

  it("does not trust a non-loopback proxy address such as the edge 192.168.1.17", async () => {
    const res = await request(appWith("192.168.1.17"))
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.7");
    expect(res.body.ip).not.toBe("203.0.113.7");
  });
});
