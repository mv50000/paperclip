import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import {
  checkMediaUrl,
  creativeManifestJsonSchema,
  jsonPointer,
  parseCreativeManifest,
} from "../src/creative-manifest/schema.js";
import { PACKAGE_ROOT } from "./fixtures.js";

const SCHEMA_FILE = path.join(PACKAGE_ROOT, "schemas", "creative-manifest.v1.schema.json");

function readmeExample(): Record<string, unknown> {
  const readme = readFileSync(path.join(PACKAGE_ROOT, "README.md"), "utf8");
  const match = readme.match(/<!-- creative-manifest-example -->\s*```json\n([\s\S]*?)```/);
  if (!match) throw new Error("README has no creative manifest example block");
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

/** The brand-repo CI snippet from the README: Ajv strict mode with ajv-formats. */
// ajv-formats is CommonJS: under NodeNext its default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (
  ajv: Ajv,
) => Ajv;

function compileLikeBrandRepoCi() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_FILE, "utf8")));
}

describe("creative manifest v1 schema", () => {
  it("the committed JSON Schema is generated from the zod schema (run schema:generate)", () => {
    expect(JSON.parse(readFileSync(SCHEMA_FILE, "utf8"))).toEqual(creativeManifestJsonSchema());
  });

  it("is exported as @paperclipai/plugin-rk9-ads/creative-manifest.v1.schema.json and shipped", () => {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, string>;
      files: string[];
    };
    expect(pkg.exports["./creative-manifest.v1.schema.json"]).toBe("./schemas/creative-manifest.v1.schema.json");
    expect(pkg.files).toContain("schemas");
  });

  it("the README example passes both the zod schema and the brand-repo Ajv check", () => {
    const example = readmeExample();
    const validate = compileLikeBrandRepoCi();
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(parseCreativeManifest(example)).toMatchObject({ ok: true });
  });

  it.each([
    ["mediaUrl", { mediaUrl: "http://media.ololla.fi/a.mp4" }, "/mediaUrl"],
    ["sha256", { sha256: "XYZ" }, "/sha256"],
    ["kind", { kind: "carousel" }, "/kind"],
    ["copy.message", { copy: { message: "" } }, "/copy/message"],
    ["extra field", { landingUrl: "https://evil.example/" }, ""],
    ["validUntil without offset", { validUntil: "2026-11-30 23:59" }, "/validUntil"],
    ["IP literal mediaUrl", { mediaUrl: "https://100.103.149.19/a.mp4" }, "/mediaUrl"],
    ["hex IP mediaUrl", { mediaUrl: "https://0x7f000001/a.mp4" }, "/mediaUrl"],
    ["IPv6 mediaUrl", { mediaUrl: "https://[fd00::1]/a.mp4" }, "/mediaUrl"],
    ["mediaUrl port", { mediaUrl: "https://media.ololla.fi:8443/a.mp4" }, "/mediaUrl"],
    ["mediaUrl credentials", { mediaUrl: "https://u:p@media.ololla.fi/a.mp4" }, "/mediaUrl"],
    ["tailnet mediaUrl", { mediaUrl: "https://vault.tail1234.TS.net/a.mp4" }, "/mediaUrl"],
    ["localhost mediaUrl", { mediaUrl: "https://localhost./a.mp4" }, "/mediaUrl"],
    ["posterUrl on an image", { kind: "image", posterUrl: "https://media.ololla.fi/p.jpg" }, "/posterUrl"],
  ])("Ajv and zod both reject a bad %s, and zod names it with a JSON pointer", (_name, patch, pointer) => {
    const bad = { ...readmeExample(), ...patch };
    const validate = compileLikeBrandRepoCi();
    expect(validate(bad)).toBe(false);
    const parsed = parseCreativeManifest(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((issue) => issue.path)).toContain(pointer);
  });

  it("Ajv accepts what zod accepts for URLs: default port 443, an @ in the path, a video poster", () => {
    const validate = compileLikeBrandRepoCi();
    for (const patch of [
      { mediaUrl: "https://cdn.example.com:443/a.mp4" },
      { mediaUrl: "https://cdn.example.com/u@2x.mp4?v=1#t" },
      { mediaUrl: "https://cdn.example.com" },
      { kind: "video", posterUrl: "https://media.ololla.fi/p.jpg" },
    ]) {
      const manifest = { ...readmeExample(), ...patch };
      expect(validate(manifest), JSON.stringify(patch)).toBe(true);
      expect(parseCreativeManifest(manifest), JSON.stringify(patch)).toMatchObject({ ok: true });
    }
  });

  it("the URL pattern stays fast on a long hostile authority", () => {
    const validate = compileLikeBrandRepoCi();
    const hostile = `https://${"a.".repeat(10_000)}@`;
    const started = performance.now();
    validate({ ...readmeExample(), mediaUrl: hostile });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("gives URL problems their own codes", () => {
    const parsed = parseCreativeManifest({ ...readmeExample(), mediaUrl: "http://media.ololla.fi/a.mp4", posterUrl: "https://10.0.0.5/p.jpg" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "url_not_https", path: "/mediaUrl" }),
          expect.objectContaining({ code: "url_forbidden", path: "/posterUrl" }),
        ]),
      );
    }
  });

  it("checkMediaUrl allows only public https names on the default port", () => {
    expect(checkMediaUrl("https://media.ololla.fi/a.mp4")).toBeNull();
    expect(checkMediaUrl("https://cdn.example.com:443/a.mp4")).toBeNull();
    for (const url of [
      "http://media.ololla.fi/a.mp4",
      "file:///etc/passwd",
      "not a url",
      "https://127.0.0.1/a",
      "https://0x7f000001/a",
      "https://[fd00::1]/a",
      "https://localhost/a",
      "https://nas.local/a",
      "https://intranet/a",
      "https://user@media.ololla.fi/a",
      "https://media.ololla.fi:8080/a",
      "https://vault.tail1234.ts.net/a",
      "https://host.beta.tailscale.net/a",
      "https://100.64.0.1/a",
      "https://vault.tail1234.ts.net../a",
    ]) {
      expect(checkMediaUrl(url), url).not.toBeNull();
    }
  });

  it("escapes JSON pointer segments (RFC 6901)", () => {
    expect(jsonPointer(["copy", "a/b", "c~d", 0])).toBe("/copy/a~1b/c~0d/0");
    expect(jsonPointer([])).toBe("");
  });
});
