import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseRoutes, resolveTarget, planDeliveries, domainIsRouted, findDuplicateKeys, S3_ONLY, SES_DOMAINS } from "./routing.mjs";

const shippedText = fs.readFileSync(new URL("./routes.json", import.meta.url), "utf8");
const shipped = JSON.parse(shippedText);
const config = parseRoutes(shipped);
const ROUTED = { ROUTED_DOMAINS: "*" };

const base = (routes = {}) => ({ targets: { aava: ["aava@rk9.fi"] }, default: "aava", routes });

test("the shipped routes.json is valid", () => {
  assert.equal(config.defaultTarget, "aava");
  assert.deepEqual([...config.targets.get("aava")], ["aava@rk9.fi"]);
});

// Acceptance (RK9-874): the operator's address is not a destination for any address.
test("the shipped table forwards only to aava@rk9.fi", () => {
  const all = [...config.targets.values()].flat();
  assert.deepEqual([...new Set(all)], ["aava@rk9.fi"]);
});

// RK9-870 inventory, section 1: every listed address routes as the report says.
test("every inventoried address routes to the inventory's target", () => {
  const expected = {
    // envelope sender of forwarded copies: a bounce must not loop (verifier M1)
    "forwarder@saatavilla.fi": S3_ONLY,
    "forwarder@sunspot.fi": S3_ONLY,
    "forwarder@ololla.fi": S3_ONLY,
    "tuki@saatavilla.fi": "aava",
    "tietosuoja@saatavilla.fi": "aava",
    "admin@saatavilla.fi": "aava",
    "operator@saatavilla.fi": "aava",
    "noreply@saatavilla.fi": "aava", // RK9-888: app bounces must be seen
    "hei@sunspot.fi": "aava",
    "laskutus@sunspot.fi": "aava",
    "billing@sunspot.fi": "aava",
    "info@sunspot.fi": "aava",
    "hello@sunspot.fi": "aava",
    "admin@sunspot.fi": "aava",
    "ops@sunspot.fi": "aava",
    "no-reply@sunspot.fi": "aava", // RK9-888: app bounces must be seen
    "uptime-probe@sunspot.fi": S3_ONLY,
    "tuki@ololla.fi": "aava",
    "asiakaspalvelu@ololla.fi": "aava",
    "kumppanit@ololla.fi": "aava",
    "omistajat@ololla.fi": "aava",
    "info@ololla.fi": "aava",
    "support@ololla.fi": "aava",
    "tietosuoja@ololla.fi": "aava",
    "kaisa@ololla.fi": "aava",
    "noreply@ololla.fi": "aava", // RK9-888: app bounces must be seen
    "no-reply@ololla.fi": "aava", // RK9-888: app bounces must be seen
    "dmarc@ololla.fi": S3_ONLY,
    "dmarc-reports@ololla.fi": S3_ONLY,
    "tls-rpt@ololla.fi": S3_ONLY,
    // "kaikki muu" -> default
    "random-unknown@sunspot.fi": "aava",
    "x@saatavilla.fi": "aava",
  };
  for (const [addr, target] of Object.entries(expected)) {
    assert.equal(resolveTarget(config, addr), target, addr);
  }
});

test("lookup is case-insensitive and falls back from a +tag to the base address", () => {
  assert.equal(resolveTarget(config, "Forwarder@Saatavilla.FI"), S3_ONLY);
  assert.equal(resolveTarget(config, "forwarder+bounce123@saatavilla.fi"), S3_ONLY);
  assert.equal(resolveTarget(config, "NoReply+bounce123@Saatavilla.FI"), "aava");
  assert.equal(resolveTarget(config, "hei+x@sunspot.fi"), "aava");
});

test("a prefix route matches only its own domain", () => {
  assert.equal(resolveTarget(config, "dmarc@sunspot.fi"), "aava");
});

test("parseRoutes rejects broken tables instead of guessing", () => {
  const bad = [
    null,
    [],
    {},
    { targets: {}, default: "aava" },
    { targets: { aava: [] }, default: "aava" },
    { targets: { aava: ["not-an-address"] }, default: "aava" },
    { targets: { aava: ["aava@rk9.fi"] }, default: "nobody" },
    { targets: { [S3_ONLY]: ["aava@rk9.fi"] }, default: S3_ONLY },
    base({ "tuki@saatavilla.fi": "nobody" }),
    base({ "tuki@example.com": "aava" }),
    base({ "not a key": "aava" }),
    base({ "Tuki@saatavilla.fi": "aava", "tuki@saatavilla.fi": S3_ONLY }),
    // a destination on an SES domain would loop back into this Lambda
    { targets: { loop: ["hei@sunspot.fi"] }, default: "loop" },
  ];
  for (const t of bad) assert.throws(() => parseRoutes(t), /routes\.json invalid/, JSON.stringify(t));
});

// RK9-888: JSON.parse silently keeps the last of two identical keys.
test("the shipped routes.json has no repeated key", () => {
  assert.deepEqual(findDuplicateKeys(shippedText), []);
});

test("findDuplicateKeys() reports a repeated key per object, at any depth", () => {
  const text = `{
    "targets": { "aava": ["aava@rk9.fi"], "x": [{ "k": 1, "k": 2 }] },
    "routes": { "tuki@saatavilla.fi": "aava", "a\\"b": "x", "tuki@saatavilla.fi": "s3-only", "a\\"b": [] },
    "default": "aava", "default": true
  }`;
  assert.deepEqual(findDuplicateKeys(text), [
    "targets.x[0].k",
    "routes.tuki@saatavilla.fi",
    'routes.a"b',
    "default",
  ]);
  // the same key in two different objects is not a duplicate
  assert.deepEqual(findDuplicateKeys('{"a": {"k": 1}, "b": {"k": null}, "c": [-1.5e3, false, "}"]}'), []);
  assert.throws(() => findDuplicateKeys("{ not json"));
});

test("parseRoutes rejects a repeated prefix route", () => {
  assert.throws(() => parseRoutes(base({ "dmarc*@ololla.fi": "aava", "DMARC*@ololla.fi": S3_ONLY })), /duplicate route/);
  assert.doesNotThrow(() => parseRoutes(base({ "dmarc*@ololla.fi": "aava", "dmarc*@sunspot.fi": S3_ONLY })));
});

test("every SES domain is covered by the domain list", () => {
  assert.deepEqual([...SES_DOMAINS].sort(), ["ololla.fi", "saatavilla.fi", "sunspot.fi"]);
});

test("planDeliveries groups recipients per target and separates s3-only", () => {
  const plan = planDeliveries({
    config,
    domain: "saatavilla.fi",
    recipients: ["tuki@saatavilla.fi", "forwarder@saatavilla.fi", "ADMIN@saatavilla.fi", "tuki@saatavilla.fi"],
    env: ROUTED,
  });
  assert.deepEqual(plan.s3Only, ["forwarder@saatavilla.fi"]);
  assert.deepEqual(plan.deliveries, [
    { target: "aava", destinations: ["aava@rk9.fi"], recipients: ["tuki@saatavilla.fi", "admin@saatavilla.fi"] },
  ]);
});

test("planDeliveries with only s3-only recipients forwards nothing", () => {
  const plan = planDeliveries({ config, domain: "ololla.fi", recipients: ["tls-rpt@ololla.fi"], env: ROUTED });
  assert.deepEqual(plan.deliveries, []);
  assert.deepEqual(plan.s3Only, ["tls-rpt@ololla.fi"]);
});

test("ROUTED_DOMAINS: unset or * routes every domain; a list routes only those", () => {
  for (const d of SES_DOMAINS) {
    assert.equal(domainIsRouted(d, {}), true);
    assert.equal(domainIsRouted(d, { ROUTED_DOMAINS: "*" }), true);
  }
  const env = { ROUTED_DOMAINS: "sunspot.fi, OLOLLA.fi" };
  assert.equal(domainIsRouted("sunspot.fi", env), true);
  assert.equal(domainIsRouted("ololla.fi", env), true);
  assert.equal(domainIsRouted("saatavilla.fi", env), false);
});

test("a domain outside ROUTED_DOMAINS keeps the legacy FORWARD_TO during rollout", () => {
  const env = { ROUTED_DOMAINS: "sunspot.fi", FORWARD_TO: "legacy@example.com, second@example.com" };
  const plan = planDeliveries({ config, domain: "saatavilla.fi", recipients: ["noreply@saatavilla.fi"], env });
  assert.deepEqual(plan.deliveries, [
    { target: "legacy", destinations: ["legacy@example.com", "second@example.com"], recipients: ["noreply@saatavilla.fi"] },
  ]);
  // the routed domain ignores FORWARD_TO entirely
  const routed = planDeliveries({ config, domain: "sunspot.fi", recipients: ["hei@sunspot.fi"], env });
  assert.deepEqual(routed.deliveries[0].destinations, ["aava@rk9.fi"]);
});

test("a legacy domain with an empty FORWARD_TO throws instead of dropping the mail", () => {
  assert.throws(
    () => planDeliveries({ config, domain: "saatavilla.fi", recipients: ["tuki@saatavilla.fi"], env: { ROUTED_DOMAINS: "sunspot.fi" } }),
    /FORWARD_TO is empty/,
  );
});

test("a routed domain without a loaded table throws", () => {
  assert.throws(() => planDeliveries({ config: null, domain: "sunspot.fi", recipients: ["hei@sunspot.fi"], env: {} }), /not loaded/);
});
