import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rewrite, sanitizeDanglingBoundaries } from "./index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");

const mail = {
  commonHeaders: { from: ["Mail Delivery Subsystem <MAILER-DAEMON@amazonses.com>"] },
};

function boundaryOf(text) {
  const headerEnd = text.match(/\r?\n\r?\n/);
  const ctBlock = text
    .slice(0, headerEnd.index)
    .match(/Content-Type:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/i);
  const m = ctBlock[0].match(/boundary="?([^";\r\n]+)"?/i);
  return { boundary: m[1], bodyStart: headerEnd.index + headerEnd[0].length };
}

// RK9-236: SES's virus quarantine truncates the DSN's embedded message/rfc822 copy
// down to bare headers, leaving `Content-Type: multipart/mixed; boundary="raja1"`
// declared but never present in the content. Forwarding that verbatim made SES's
// own SendRawEmail reject the WHOLE message with "Missing start boundary" — this
// is the exact fixture (redacted) that reproduced the failure, pulled from the
// live rk9-ses-forwarder CloudWatch logs and S3 bucket on 2026-09-17.
test("rewrite() repairs a DSN whose embedded rfc822 part has a dangling nested boundary", () => {
  const raw = fs.readFileSync(path.join(FIXTURES, "virus-quarantine-dsn.eml"));
  const out = rewrite(raw, "forwarder@sunspot.fi", mail, "no-reply@sunspot.fi").toString("utf8");

  // The dangling declaration must be neutralized, not left dangling.
  assert.ok(!/boundary="?raja1"?/i.test(out), "the unreachable nested boundary must not survive verbatim");

  // The top-level multipart/report boundary must still be intact and immediately
  // reachable (this is what "the message parses" actually depends on).
  const { boundary, bodyStart } = boundaryOf(out);
  assert.equal(boundary, "__boundary-9a35d738-3b55-48ee-b405-0a323631e52c");
  const idx = out.indexOf(`--${boundary}`, bodyStart);
  assert.ok(idx >= 0, "top-level boundary delimiter must be present in the body");

  // Every "--boundary" occurrence in the body must correspond to the declared
  // top-level boundary — no leftover reference to a boundary that isn't declared
  // anywhere reachable.
  const danglingRaja1 = out.includes("--raja1");
  assert.ok(!danglingRaja1, "no stray reference to the unreachable inner boundary");
});

test("sanitizeDanglingBoundaries() is a no-op on well-formed nested multipart content", () => {
  const wellFormed =
    "Content-Type: multipart/alternative; boundary=\"inner-1\"\r\n\r\n" +
    "--inner-1\r\nContent-Type: text/plain\r\n\r\nhi\r\n--inner-1--\r\n";
  assert.equal(sanitizeDanglingBoundaries(wellFormed), wellFormed);
});

test("sanitizeDanglingBoundaries() neutralizes a boundary that is declared but never used", () => {
  const broken = "Content-Type: multipart/mixed; boundary=\"ghost\"\r\n";
  const fixed = sanitizeDanglingBoundaries(broken);
  assert.equal(fixed, "Content-Type: text/plain\r\n");
});

test("rewrite() still drops inbound authentication/SES bookkeeping headers", () => {
  const raw = fs.readFileSync(path.join(FIXTURES, "virus-quarantine-dsn.eml"));
  const out = rewrite(raw, "forwarder@sunspot.fi", mail, "no-reply@sunspot.fi").toString("utf8");
  for (const header of ["Authentication-Results", "Received-SPF", "X-SES-Receipt", "X-SES-DKIM-SIGNATURE"]) {
    assert.ok(!new RegExp(`^${header}:`, "im").test(out), `${header} must be dropped`);
  }
});

// RK9-236 review: an earlier version of sanitizeDanglingBoundaries() re-scanned the
// remaining message text on every `boundary=` declaration it found, which is O(n^2)
// on a fully attacker-controlled input (anyone can email hei@sunspot.fi). Guard
// against reintroducing that by asserting the work scales roughly linearly, not
// quadratically, as input size grows.
test("sanitizeDanglingBoundaries() scales linearly, not quadratically, with attacker-controlled input", () => {
  const buildPayload = (n) =>
    Array.from({ length: n }, (_, i) => `Content-Type: multipart/mixed; boundary="fake${i}"`).join("\r\n") +
    "\r\n\r\nbody\r\n";

  const time = (n) => {
    const payload = buildPayload(n);
    const t0 = process.hrtime.bigint();
    sanitizeDanglingBoundaries(payload);
    return Number(process.hrtime.bigint() - t0) / 1e6; // ms
  };

  const small = Math.max(time(2000), 1); // avoid div-by-zero on a very fast run
  const large = time(16000); // 8x the input

  // Quadratic behavior would make this ~64x; linear is ~8x. Allow generous slack
  // for scheduling noise while still catching a real O(n^2) regression.
  assert.ok(
    large / small < 20,
    `expected roughly linear scaling, got ${small}ms -> ${large}ms (${(large / small).toFixed(1)}x for 8x input)`
  );
});
