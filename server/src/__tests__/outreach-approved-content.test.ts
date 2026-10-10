// RK9-475: canonical form of the approved-content fingerprint (pure, no DB).
import { describe, expect, it } from "vitest";
import {
  computeApprovedContentHash,
  verifyApprovedContent,
  type ApprovedContent,
} from "../services/outreach/approved-content.js";

const BASE: ApprovedContent = {
  subject: "Hei",
  bodyText: "Tekstiä",
  bodyHtml: null,
  inReplyTo: null,
  recipientEmail: "info@example.fi",
};

describe("computeApprovedContentHash", () => {
  it("is versioned, hex and deterministic", () => {
    const hash = computeApprovedContentHash(BASE);
    expect(hash).toMatch(/^sha256-v1:[0-9a-f]{64}$/);
    expect(computeApprovedContentHash({ ...BASE })).toBe(hash);
  });

  it("changes when any sent field changes", () => {
    const hash = computeApprovedContentHash(BASE);
    const variants: ApprovedContent[] = [
      { ...BASE, subject: "Hei!" },
      { ...BASE, bodyText: "Tekstiä." },
      { ...BASE, bodyHtml: "<p>Tekstiä</p>" },
      { ...BASE, inReplyTo: "<a@b>" },
      { ...BASE, recipientEmail: "other@example.fi" },
      { ...BASE, recipientEmail: null },
    ];
    for (const variant of variants) expect(computeApprovedContentHash(variant)).not.toBe(hash);
  });

  it("does not collide when a newline moves between subject and body", () => {
    const a = computeApprovedContentHash({ ...BASE, subject: "a\nb", bodyText: "c" });
    const b = computeApprovedContentHash({ ...BASE, subject: "a", bodyText: "b\nc" });
    expect(a).not.toBe(b);
  });

  it("tells a null HTML body from an empty one", () => {
    expect(computeApprovedContentHash({ ...BASE, bodyHtml: "" })).not.toBe(computeApprovedContentHash(BASE));
  });

  it("compares the recipient case- and whitespace-insensitively", () => {
    expect(computeApprovedContentHash({ ...BASE, recipientEmail: " INFO@Example.fi " })).toBe(
      computeApprovedContentHash(BASE),
    );
  });
});

describe("verifyApprovedContent", () => {
  it("passes a legacy message with no hash", () => {
    expect(verifyApprovedContent(null, BASE)).toEqual({ ok: true, legacy: true });
    expect(verifyApprovedContent(undefined, BASE)).toEqual({ ok: true, legacy: true });
  });

  it("passes unchanged content", () => {
    expect(verifyApprovedContent(computeApprovedContentHash(BASE), BASE)).toEqual({ ok: true, legacy: false });
  });

  it("fails changed content and reports both hashes", () => {
    const stored = computeApprovedContentHash(BASE);
    const changed = { ...BASE, bodyText: "Muutettu" };
    expect(verifyApprovedContent(stored, changed)).toEqual({
      ok: false,
      expected: stored,
      actual: computeApprovedContentHash(changed),
    });
  });

  it("fails a hash in an unknown format instead of skipping the check", () => {
    expect(verifyApprovedContent("sha256-v2:abc", BASE).ok).toBe(false);
  });
});
