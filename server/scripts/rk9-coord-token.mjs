#!/usr/bin/env node
// --- RK9 Custom (RK9-623): issue, rotate, revoke and list coord tokens ---
//
// Operator tool for the per-host and per-service coord tokens of the coord bus
// (epic RK9-620, ADR docs/implementation-notes/coord-identity.md). Run it on
// paperclip-01 with the operator's board key in the environment.
//
// Secrets never travel in argv, stdout or logs:
// - the board key is read from PAPERCLIP_API_KEY only;
// - a new token is written only to the --out env file (mode 0600, created
//   atomically, never overwritten without --force) in the client format of the
//   ADR: RK9_COORD_URL, RK9_COORD_COMPANY_ID, RK9_COORD_TOKEN. Deliver that
//   file to the host as ~/.config/rk9/coord.env (mode 0600).
//   RK9-653: a recall-scope token (--scope recall) is written as
//   RK9_RECALL_URL, RK9_RECALL_COMPANY_ID, RK9_RECALL_TOKEN instead, for
//   ~/.config/rk9/recall.env, which qmd-recall-remote.sh reads.
// stdout carries metadata only (id, display prefix, principal, file path).
//
// Usage:
//   node server/scripts/rk9-coord-token.mjs issue (--host <name> | --service <rk9claude|grok>) --out <file>
//        [--scope coord|recall] [--recall-all] [--label <text>] [--expires-at <iso>] [--force]
//        --recall-all (recall scope only): the token may use scope:"all" recall (operator mode).
//   node server/scripts/rk9-coord-token.mjs rotate --id <token-id> --out <file> [--label <text>]
//        [--expires-at <iso> | --no-expiry] [--force]
//   node server/scripts/rk9-coord-token.mjs revoke --id <token-id>
//   node server/scripts/rk9-coord-token.mjs list
//
// Environment:
//   PAPERCLIP_API_KEY     operator board key (required)
//   PAPERCLIP_API_URL     API base URL (default http://127.0.0.1:3100)
//   RK9_COORD_COMPANY_ID  company id (or --company <uuid>)
//   RK9_COORD_URL         URL written to the env file (default http://paperclip:3100,
//                         the tailnet name of paperclip-01)
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^rk9_coord_[A-Za-z0-9_-]{43}$/;
const DEFAULT_API_URL = "http://127.0.0.1:3100";
const DEFAULT_COORD_URL = "http://paperclip:3100";

class UsageError extends Error {}

function fail(message, code = 1) {
  process.stderr.write(`rk9-coord-token: ${message}\n`);
  process.exit(code);
}

/**
 * Flags each command accepts. A flag that does not belong to the command is a
 * usage error, never silently ignored: `issue --no-expiry` or
 * `revoke --expires-at` would otherwise look like they did something.
 */
const COMMAND_FLAGS = {
  issue: ["host", "service", "scope", "recall-all", "out", "label", "expires-at", "company", "force"],
  rotate: ["id", "out", "label", "expires-at", "no-expiry", "company", "force"],
  revoke: ["id", "company"],
  list: ["company"],
};

function parse(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMAND_FLAGS, command ?? "")) {
    throw new UsageError("command must be issue, rotate, revoke or list");
  }
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      host: { type: "string" },
      service: { type: "string" },
      scope: { type: "string" },
      "recall-all": { type: "boolean" },
      id: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      "expires-at": { type: "string" },
      company: { type: "string" },
      "no-expiry": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  const allowed = COMMAND_FLAGS[command];
  const foreign = Object.keys(values).filter((flag) => values[flag] !== undefined && !allowed.includes(flag));
  if (foreign.length > 0) {
    throw new UsageError(`${command} does not take ${foreign.map((flag) => `--${flag}`).join(", ")}`);
  }
  return { command, values };
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/** Check the target before the API call, so a refused write wastes no token. */
async function prepareOut(out, force) {
  if (!out) throw new UsageError("--out <file> is required: the token is written only to that file");
  const target = path.resolve(out);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!force && (await pathExists(target))) {
    throw new UsageError(`${target} exists; pass --force to replace it`);
  }
  return target;
}

/** Write the env file atomically with mode 0600. */
export async function writeCoordEnvFile(target, { coordUrl, companyId, token, record }) {
  if (!TOKEN_RE.test(token)) throw new Error("server returned a token in an unexpected format");
  // RK9-653: a recall token gets its own variable names, so it can never be
  // mistaken for a coord token (and the other way round).
  const recall = record.scope === "recall";
  const prefix = recall ? "RK9_RECALL" : "RK9_COORD";
  const body = [
    recall
      ? `# rk9 recall credentials: ${record.principalKind} ${record.principalName}, token ${record.id}` +
        `${record.recallAll ? " (recall_all: scope \"all\" allowed)" : ""}.`
      : `# rk9 coord credentials: ${record.principalKind} ${record.principalName}, token ${record.id}.`,
    "# Mode 0600. Never commit, paste or pass this token as a command argument.",
    `${prefix}_URL=${coordUrl}`,
    `${prefix}_COMPANY_ID=${companyId}`,
    `${prefix}_TOKEN=${token}`,
    "",
  ].join("\n");
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (err) {
    // Every failure, also a failed close, removes the temp file: it holds the
    // token. A second close of a closed handle is harmless.
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function api(method, url, apiKey, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json && typeof json === "object" ? json.code ?? json.error ?? "" : "";
    throw new Error(`${method} ${new URL(url).pathname} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  return json;
}

function summary(record, extra = {}) {
  return {
    id: record.id,
    principalKind: record.principalKind,
    principalName: record.principalName,
    // An older server has no scope: every token there is a coord token.
    scope: record.scope ?? "coord",
    recallAll: record.recallAll === true,
    tokenPrefix: record.tokenPrefix,
    label: record.label,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    rotatedFromTokenId: record.rotatedFromTokenId,
    ...extra,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, values } = parse(argv);
  const apiKey = env.PAPERCLIP_API_KEY?.trim();
  if (!apiKey) throw new UsageError("PAPERCLIP_API_KEY (the operator board key) must be set in the environment");
  const companyId = (values.company ?? env.RK9_COORD_COMPANY_ID ?? "").trim();
  if (!UUID_RE.test(companyId)) throw new UsageError("set RK9_COORD_COMPANY_ID or --company to the company UUID");
  const apiBase = (env.PAPERCLIP_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "").replace(/\/api$/, "");
  const coordUrl = (env.RK9_COORD_URL?.trim() || DEFAULT_COORD_URL).replace(/\/+$/, "");
  const base = `${apiBase}/api/companies/${companyId}/rk9/coord-tokens`;
  const out = [];

  if (command === "list") {
    const result = await api("GET", base, apiKey);
    for (const record of result.tokens ?? []) out.push(summary(record));
    return out;
  }

  if (command === "revoke") {
    if (!values.id || !UUID_RE.test(values.id)) throw new UsageError("--id <token-id> is required");
    const result = await api("POST", `${base}/${values.id}/revoke`, apiKey, {});
    return [summary(result.record)];
  }

  const target = await prepareOut(values.out, values.force);
  let result;
  if (command === "issue") {
    if (Boolean(values.host) === Boolean(values.service)) {
      throw new UsageError("issue needs exactly one of --host <name> or --service <rk9claude|grok>");
    }
    const scope = values.scope ?? "coord";
    if (scope !== "coord" && scope !== "recall") throw new UsageError("--scope must be coord or recall");
    if (values["recall-all"] && scope !== "recall") throw new UsageError("--recall-all needs --scope recall");
    result = await api("POST", base, apiKey, {
      principalKind: values.host ? "host" : "service",
      principalName: values.host ?? values.service,
      ...(scope === "recall" ? { scope } : {}),
      ...(values["recall-all"] ? { recallAll: true } : {}),
      ...(values.label ? { label: values.label } : {}),
      ...(values["expires-at"] ? { expiresAt: values["expires-at"] } : {}),
    });
  } else {
    if (!values.id || !UUID_RE.test(values.id)) throw new UsageError("--id <token-id> is required");
    if (values["no-expiry"] && values["expires-at"]) {
      throw new UsageError("pass --expires-at or --no-expiry, not both");
    }
    result = await api("POST", `${base}/${values.id}/rotate`, apiKey, {
      ...(values.label ? { label: values.label } : {}),
      ...(values["expires-at"] ? { expiresAt: values["expires-at"] } : {}),
      ...(values["no-expiry"] ? { expiresAt: null } : {}),
    });
  }
  try {
    await writeCoordEnvFile(target, { coordUrl, companyId, token: result.token, record: result.record });
  } catch (err) {
    throw new Error(
      `the token ${result.record.id} was created but ${target} could not be written (${err.message}); ` +
        `revoke it with: rk9-coord-token.mjs revoke --id ${result.record.id}`,
    );
  }
  return [summary(result.record, { envFile: target })];
}

async function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  const { realpath } = await import("node:fs/promises");
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}
const invokedDirectly = await isInvokedDirectly();
if (invokedDirectly) {
  main().then(
    (rows) => process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`),
    (err) => fail(err.message, err instanceof UsageError ? 2 : 1),
  );
}
// --- /RK9 Custom ---
