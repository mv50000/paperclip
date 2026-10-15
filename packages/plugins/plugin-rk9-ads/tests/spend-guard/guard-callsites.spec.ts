/**
 * One guard for every spend-raising write (A6, RK9-511).
 *
 * The structural guarantee is in src/meta/graph.ts: requests go through the
 * runtime-private #send, and the only public write paths (post/delete) call
 * the guardedWrite hook first. These tests pin the rest:
 * - a Meta client write is made only in src/meta/methods.ts;
 * - a brand client gets its hook from createSpendGuardHook, or none (the
 *   default refuses activation and budget changes);
 * - budget fields and ACTIVE writes appear only where the guard handles them;
 * - every write method of methods.ts reaches the hook exactly once.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createSpendGuardHook } from "../../src/features/spend-guard/guard.js";
import type { WritePlan } from "../../src/meta/graph.js";
import { pausedOnlyWrites } from "../../src/meta/graph.js";
import { createAd, createAdCreative, setObjectStatus, uploadImageBytes, uploadVideoByUrl } from "../../src/meta/methods.js";
import { PACKAGE_ROOT } from "../fixtures.js";
import { FakeMeta } from "./fake-meta.js";
import { config, metaClient } from "./helpers.js";

const SRC = join(PACKAGE_ROOT, "src");

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles().map((path) => ({ path: relative(PACKAGE_ROOT, path), text: readFileSync(path, "utf8") }));

/** Code without comments, so a doc example does not count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("guard call sites", () => {
  it("makes Meta client writes only in src/meta/methods.ts", () => {
    const offenders = files
      .filter((file) => !file.path.startsWith("src/meta/"))
      .filter((file) => /\b\w*[cC]lient\w*\s*\.\s*(post|delete)\s*(<[^>]*>)?\s*\(/.test(code(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("builds every hooked Meta client with createSpendGuardHook", () => {
    const hooks = files.flatMap((file) =>
      [...code(file.text).matchAll(/guardedWrite\s*:\s*([A-Za-z_$][\w$]*)/g)].map((match) => `${file.path}: ${match[1]}`),
    );
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) expect(hook).toMatch(/: createSpendGuardHook$/);
    // A client without a hook gets pausedOnlyWrites, which refuses spend.
    const unhooked = files.filter((file) => !file.path.startsWith("src/meta/") && /new\s+MetaGraphClient\s*\(/.test(code(file.text)));
    expect(unhooked.map((file) => file.path)).toEqual([]);
  });

  it("names budget fields only in the Meta methods and the guard", () => {
    const users = files.filter((file) => /daily_budget|lifetime_budget/.test(code(file.text))).map((file) => file.path);
    expect(users.sort()).toEqual(["src/features/spend-guard/guard.ts", "src/meta/methods.ts"]);
  });

  it("never writes status ACTIVE as a literal outside the Meta methods", () => {
    const offenders = files
      .filter((file) => !file.path.startsWith("src/meta/"))
      .filter((file) => /status\s*:\s*["']ACTIVE["']|status=ACTIVE/.test(code(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("the default hook refuses activation and budget raises", () => {
    const plan = (path: string, fields: Record<string, unknown>): WritePlan => ({ companyId: "c", mode: "live", method: "POST", path, fields });
    expect(pausedOnlyWrites(plan("123", { status: "ACTIVE" })).allow).toBe(false);
    expect(pausedOnlyWrites(plan("123", { daily_budget: "500" })).allow).toBe(false);
    expect(pausedOnlyWrites(plan("act_1/ads", { name: "a", status: "ACTIVE" })).allow).toBe(false);
  });

  it("routes every write method of methods.ts through the hook exactly once", async () => {
    const seen: string[] = [];
    const client = metaClient(new FakeMeta(), "dryRun", {
      guardedWrite: (plan) => {
        seen.push(`${plan.method} ${plan.path}`);
        return { allow: true };
      },
    });
    const act = "act_29231592883113369";
    await setObjectStatus(client, "123", "ACTIVE");
    await createAd(client, act, { name: "a", adsetId: "1", creativeId: "2" });
    await createAdCreative(client, act, { name: "c" });
    await uploadVideoByUrl(client, act, { fileUrl: "https://cdn.example/v.mp4" });
    await uploadImageBytes(client, act, { bytesBase64: "AAAA" });
    expect(seen).toEqual([
      "POST 123",
      `POST ${act}/ads`,
      `POST ${act}/adcreatives`,
      `POST ${act}/advideos`,
      `POST ${act}/adimages`,
    ]);
  });

  it("the spend guard hook keeps media and pauses on the fast path and refuses ungated activation", async () => {
    const meta = new FakeMeta();
    const hook = createSpendGuardHook({ config: config(), readClient: metaClient(meta) });
    const plan = (path: string, fields: Record<string, unknown>): WritePlan => ({ companyId: "c", mode: "live", method: "POST", path, fields });
    expect(await hook(plan("act_29231592883113369/adimages", { bytes: "AAAA" }))).toEqual({ allow: true });
    expect(await hook(plan("123", { status: "PAUSED" }))).toEqual({ allow: true });
    expect(await hook(plan("123", { status: "ACTIVE" }))).toMatchObject({ allow: false, reason: expect.stringMatching(/^spend_guard:gate_required/) });
    expect(meta.calls).toHaveLength(0);
  });
});
