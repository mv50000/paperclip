/**
 * G1 (A9, RK9-517): src/gate/activate-ad.ts is the only code that can set an
 * ad, ad set or campaign ACTIVE. Static: the only spend authorization and the
 * only non-PAUSED status write live there. Runtime: the full worker is set up
 * on a fake Graph, and every action, job and agent tool is driven with valid
 * and hostile parameters; none sends status=ACTIVE.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { useCompanyConfigs, useCompanySecrets } from "../src/kit/testing/harness.js";
import { brandConfig, COMPANY_A, PACKAGE_ROOT, SECRET_A_META } from "./fixtures.js";
import { FakeMeta } from "./spend-guard/fake-meta.js";

const SRC = join(PACKAGE_ROOT, "src");
const ACTIVATOR = "src/gate/activate-ad.ts";

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Code without comments. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = sourceFiles().map((path) => ({ path: relative(PACKAGE_ROOT, path).replaceAll("\\", "/"), text: code(readFileSync(path, "utf8")) }));

/** The argument list of every call to `name(` in `text`. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const match of text.matchAll(re)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") depth -= 1;
    }
    out.push(text.slice(start, i - 1));
  }
  return out;
}

describe("activation sole path (static)", () => {
  it("every status write outside the Meta methods is a literal PAUSED, except in the activation handler", () => {
    const offenders = files
      .filter((file) => !file.path.startsWith("src/meta/") && file.path !== ACTIVATOR)
      .flatMap((file) => callArgs(file.text, "setObjectStatus").map((args) => ({ file: file.path, args })))
      .filter(({ args }) => !/,\s*["']PAUSED["']\s*$/.test(args.trim()));
    expect(offenders).toEqual([]);
    expect(callArgs(files.find((file) => file.path === ACTIVATOR)!.text, "setObjectStatus").length).toBeGreaterThan(0);
  });

  it("only the activation handler authorizes a spend-raising write", () => {
    const authorizers = files.filter((file) => /authorizeSpend\s*:\s*(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(file.text)).map((file) => file.path);
    expect(authorizers).toEqual([ACTIVATOR]);
    const users = files.filter((file) => /\bcreateActivationClient\b/.test(file.text)).map((file) => file.path).sort();
    expect(users).toEqual(["src/features/gate/register.ts", ACTIVATOR]);
  });

  it("registers the activation handler only as the activate_ad gate handler", () => {
    const registrations = files.flatMap((file) => callArgs(file.text, "registerGateHandler").map((args) => `${file.path}: ${args.split(",")[0]!.trim()}`));
    expect(registrations.filter((entry) => entry.includes("activate_ad"))).toEqual(['src/features/gate/register.ts: "activate_ad"']);
    const handlerUsers = files.filter((file) => /\bcreateActivateAdHandler\b/.test(file.text)).map((file) => file.path).sort();
    expect(handlerUsers).toEqual(["src/features/gate/register.ts", ACTIVATOR]);
  });
});

const PARAM_SETS: Array<Record<string, unknown>> = [
  {},
  { status: "ACTIVE" },
  { confirm: true, dryRun: false, status: "ACTIVE", adId: "120200000000000301", adsetId: "120200000000000201", campaignId: "120200000000000101" },
  { gateRequestId: "dddddddd-0000-4000-8000-000000000009", publicationId: "dddddddd-0000-4000-8000-000000000001" },
  { objectId: "120200000000000301", objectType: "ad", action: "activate", daily_budget: 100000 },
];

describe("activation sole path (runtime)", () => {
  it("no action, job or tool of the worker sends status=ACTIVE to Meta", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ companies: [{ id: COMPANY_A, name: "Ololla" } as Company] });
    useCompanyConfigs(harness, { [COMPANY_A]: brandConfig() });
    useCompanySecrets(harness, { [COMPANY_A]: { [SECRET_A_META]: "EAAG-sole-path-token-000000" } });
    const meta = new FakeMeta();
    meta.campaigns = [{ id: "120200000000000101", status: "PAUSED" }];
    meta.adsets = [{ id: "120200000000000201", status: "PAUSED", campaign_id: "120200000000000101", daily_budget: "322" }];
    meta.ads = [{ id: "120200000000000301", status: "PAUSED", adset_id: "120200000000000201", campaign_id: "120200000000000101", creative_id: "120200000000000401" }];
    harness.ctx.http.fetch = async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://graph.facebook.com/")) return meta.fetch(url, init);
      throw new Error(`no route for ${url}`);
    };
    const actionKeys: string[] = [];
    const register = harness.ctx.actions.register.bind(harness.ctx.actions);
    harness.ctx.actions.register = (key, handler) => {
      actionKeys.push(key);
      register(key, handler);
    };
    await plugin.definition.setup(harness.ctx);

    expect(actionKeys).toContain("resend_gate_card");
    for (const key of actionKeys) {
      for (const params of PARAM_SETS) {
        await harness.performAction(key, params, { companyId: COMPANY_A }).catch(() => undefined);
      }
    }
    for (const job of manifest.jobs ?? []) {
      await harness.runJob(job.jobKey).catch(() => undefined);
    }
    for (const tool of manifest.tools ?? []) {
      for (const params of PARAM_SETS) {
        await harness.executeTool(tool.name, params, { companyId: COMPANY_A }).catch(() => undefined);
      }
    }
    await plugin.definition.onShutdown?.();

    expect(meta.calls.length).toBeGreaterThan(0);
    const activations = meta.writes.filter((call) => Object.entries(call.body).some(([key, value]) => /status/i.test(key) && /ACTIVE/i.test(value)));
    expect(activations).toEqual([]);
    expect([...meta.campaigns, ...meta.adsets, ...meta.ads].map((object) => object.status)).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  });
});
