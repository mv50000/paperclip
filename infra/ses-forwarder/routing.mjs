// Address-level routing for rk9-ses-forwarder (RK9-874).
//
// Until RK9-874 every message for all three SES domains went to one FORWARD_TO
// address: the operator's personal mailbox. The routing table (routes.json,
// bundled next to index.mjs) now decides per recipient address:
//
//   - a named target  -> forward to that target's destination addresses
//   - "s3-only"       -> do not forward; the raw .eml stays in S3
//   - anything else   -> the table's `default` (Aava)
//
// This module has no AWS dependencies, so deploy.sh can validate routes.json
// before upload and the tests run without `npm install`.
//
// Failure rule: a missing or invalid table NEVER silently drops mail and NEVER
// falls back to the operator's address. parseRoutes() throws, the handler logs
// the error and rethrows, and the message stays in S3 for replay.

/** Reserved target name: keep the message in S3 and forward it nowhere. */
export const S3_ONLY = "s3-only";

/** The three SES inbound domains. A destination on one of these would loop
 *  straight back into the forwarder, so parseRoutes() rejects it. */
export const SES_DOMAINS = ["sunspot.fi", "ololla.fi", "saatavilla.fi"];

const ADDRESS_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// Route key: a full address, or a local-part prefix ending in `*` (`dmarc*@ololla.fi`).
const ROUTE_KEY_RE = /^[a-z0-9!#$%&'+/=?^_`{|}~.-]*\*?@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const TARGET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function fail(msg) {
  throw new Error(`routes.json invalid: ${msg}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate a parsed routes.json object and return a frozen, normalized config.
 *  Throws on any defect: an unknown target, a malformed address, a destination
 *  on an SES domain (mail loop), a route for a domain this forwarder does not
 *  serve. Keys that start with `$` are comments and are ignored. */
export function parseRoutes(obj) {
  if (!isPlainObject(obj)) fail("top level must be an object");

  const targets = new Map();
  if (!isPlainObject(obj.targets)) fail("`targets` must be an object");
  for (const [name, dests] of Object.entries(obj.targets)) {
    if (name.startsWith("$")) continue;
    if (name === S3_ONLY) fail(`target name "${S3_ONLY}" is reserved`);
    if (!TARGET_NAME_RE.test(name)) fail(`bad target name ${JSON.stringify(name)}`);
    if (!Array.isArray(dests) || dests.length === 0) fail(`target "${name}" needs a non-empty address list`);
    const norm = dests.map((d) => {
      if (typeof d !== "string") fail(`target "${name}" has a non-string address`);
      const a = d.trim().toLowerCase();
      if (!ADDRESS_RE.test(a)) fail(`target "${name}" has a malformed address ${JSON.stringify(d)}`);
      if (SES_DOMAINS.includes(a.split("@")[1])) fail(`target "${name}" address ${a} is on an SES inbound domain (mail loop)`);
      return a;
    });
    targets.set(name, Object.freeze([...new Set(norm)]));
  }

  const knownTarget = (t) => t === S3_ONLY || targets.has(t);

  if (typeof obj.default !== "string" || !knownTarget(obj.default)) {
    fail(`\`default\` must name a target or "${S3_ONLY}"`);
  }

  const exact = new Map();
  const prefixes = []; // [{ prefix, domain, target }], longest prefix first
  if (obj.routes !== undefined && !isPlainObject(obj.routes)) fail("`routes` must be an object");
  for (const [rawKey, target] of Object.entries(obj.routes || {})) {
    if (rawKey.startsWith("$")) continue;
    const key = rawKey.trim().toLowerCase();
    if (!ROUTE_KEY_RE.test(key)) fail(`bad route key ${JSON.stringify(rawKey)}`);
    const [local, domain] = key.split("@");
    if (!SES_DOMAINS.includes(domain)) fail(`route ${key} is for a domain this forwarder does not serve`);
    if (typeof target !== "string" || !knownTarget(target)) fail(`route ${key} names unknown target ${JSON.stringify(target)}`);
    if (local.endsWith("*")) {
      prefixes.push({ prefix: local.slice(0, -1), domain, target });
    } else {
      if (!local) fail(`route ${JSON.stringify(rawKey)} has an empty local part`);
      if (exact.has(key)) fail(`duplicate route ${key}`);
      exact.set(key, target);
    }
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  return Object.freeze({ targets, defaultTarget: obj.default, exact, prefixes });
}

/** Target name for one recipient address. Lookup order: exact address, then the
 *  address without a `+tag`, then the longest matching `prefix*@domain`, then
 *  the table default. Pure; never throws for a well-formed config. */
export function resolveTarget(config, recipient) {
  const addr = String(recipient || "").trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return config.defaultTarget;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);

  if (config.exact.has(addr)) return config.exact.get(addr);
  const plus = local.indexOf("+");
  if (plus > 0) {
    const base = `${local.slice(0, plus)}@${domain}`;
    if (config.exact.has(base)) return config.exact.get(base);
  }
  for (const p of config.prefixes) {
    if (p.domain === domain && local.startsWith(p.prefix)) return p.target;
  }
  return config.defaultTarget;
}

/** Rollout switch for a domain-at-a-time deploy. `ROUTED_DOMAINS` unset, empty
 *  or `*` means every domain uses the routing table (the final state). A comma
 *  list means only those domains do; the others keep the legacy FORWARD_TO
 *  behaviour until they are added. Rollback for one domain is removing it. */
export function domainIsRouted(domain, env) {
  const raw = (env.ROUTED_DOMAINS ?? "").trim();
  if (raw === "" || raw === "*") return true;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(domain);
}

/** Decide what to do with one SES receipt. Returns
 *    { deliveries: [{ target, destinations, recipients }], s3Only: [recipient] }
 *  Each delivery is one SendRawEmail; recipients that share a target share one
 *  copy. Legacy (non-routed) domains get a single "legacy" delivery to
 *  FORWARD_TO; an empty FORWARD_TO there throws instead of dropping the mail.
 *  `config` may be null only when no domain needs it (i.e. a legacy domain). */
export function planDeliveries({ config, domain, recipients, env }) {
  const rcpts = [...new Set((recipients || []).map((r) => String(r).trim().toLowerCase()).filter(Boolean))];

  if (!domainIsRouted(domain, env)) {
    const legacy = (env.FORWARD_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (legacy.length === 0) throw new Error(`domain ${domain} is not in ROUTED_DOMAINS and FORWARD_TO is empty`);
    return { deliveries: [{ target: "legacy", destinations: legacy, recipients: rcpts }], s3Only: [] };
  }

  if (!config) throw new Error("routing table not loaded");
  const byTarget = new Map();
  const s3Only = [];
  for (const r of rcpts) {
    const t = resolveTarget(config, r);
    if (t === S3_ONLY) {
      s3Only.push(r);
      continue;
    }
    if (!byTarget.has(t)) byTarget.set(t, []);
    byTarget.get(t).push(r);
  }
  const deliveries = [...byTarget].map(([target, rs]) => ({
    target,
    destinations: [...config.targets.get(target)],
    recipients: rs,
  }));
  return { deliveries, s3Only };
}
