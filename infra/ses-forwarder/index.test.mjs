import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { Readable } from "node:stream";
import { rewrite, sanitizeDanglingBoundaries, senderLabel, encodePhrase, decodeEncodedWords, handler } from "./index.mjs";

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

// ---- RK9-874: From / Reply-To / X-Original-To rewrite -------------------------

const plain = (headers, body = "hello\r\n") => Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body, "utf8");
const headersOf = (buf) => buf.toString("utf8").split(/\r\n\r\n/)[0];
const header = (buf, name) => {
  const m = headersOf(buf).match(new RegExp(`^${name}:([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)`, "im"));
  return m ? m[1].replace(/\r\n[ \t]/g, " ").trim() : null;
};

test("rewrite() sets From to '\"<name> via <domain>\" <forwarder@domain>' and Reply-To to the sender", () => {
  const raw = plain(["From: Matti Asiakas <matti@example.com>", "To: tuki@saatavilla.fi", "Subject: Apua"]);
  const m = { commonHeaders: { from: ["Matti Asiakas <matti@example.com>"] } };
  const out = rewrite(raw, "forwarder@saatavilla.fi", m, ["tuki@saatavilla.fi"]);
  assert.equal(header(out, "From"), '"Matti Asiakas via saatavilla.fi" <forwarder@saatavilla.fi>');
  assert.equal(header(out, "Reply-To"), "Matti Asiakas <matti@example.com>");
  assert.equal(header(out, "X-Original-From"), "Matti Asiakas <matti@example.com>");
  assert.equal(header(out, "X-Original-To"), "tuki@saatavilla.fi");
  assert.equal(header(out, "Subject"), "Apua");
  assert.equal((headersOf(out).match(/^From:/gim) || []).length, 1, "exactly one From header");
  assert.ok(!/via RK9/.test(out.toString("utf8")));
});

test("rewrite() uses the bare address when the sender has no display name", () => {
  const raw = plain(["From: matti@example.com", "Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["matti@example.com"] } }, "hei@sunspot.fi");
  assert.equal(header(out, "From"), '"matti@example.com via sunspot.fi" <forwarder@sunspot.fi>');
  assert.equal(header(out, "Reply-To"), "matti@example.com");
});

test("rewrite() lists every arrival address in X-Original-To and drops a forged inbound one", () => {
  const raw = plain(["From: a@example.com", "X-Original-To: tietosuoja@ololla.fi", "Subject: x"]);
  const out = rewrite(raw, "forwarder@ololla.fi", { commonHeaders: { from: ["a@example.com"] } }, ["tuki@ololla.fi", "info@ololla.fi"]);
  const h = headersOf(out);
  assert.equal((h.match(/^X-Original-To:/gim) || []).length, 1, "only our X-Original-To survives");
  assert.equal(header(out, "X-Original-To"), "tuki@ololla.fi, info@ololla.fi");
});

test("rewrite() cannot be made to inject headers through the sender's name", () => {
  const evil = 'Evil\r\nBcc: victim@example.com\r\n"\\ <evil@example.com>';
  const raw = plain(["From: x@example.com", "Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: [evil] } }, "hei@sunspot.fi\r\nBcc: v@example.com");
  const h = headersOf(out);
  assert.ok(!/^Bcc:/im.test(h), "no injected Bcc header");
  const from = header(out, "From");
  assert.match(from, /^"[^"\\]* via sunspot\.fi" <forwarder@sunspot\.fi>$/);
});

test("rewrite() falls back gracefully when no sender is known", () => {
  const raw = plain(["Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, "hei@sunspot.fi");
  assert.equal(header(out, "From"), '"unknown sender via sunspot.fi" <forwarder@sunspot.fi>');
  assert.equal(header(out, "Reply-To"), null);
});

test("rewrite() keeps the original raw From (encoded-words intact) as Reply-To", () => {
  const rawFrom = "=?UTF-8?B?w4RpdGkgS8OkeXR0w6Rqw6Q=?= <aiti@example.com>";
  const raw = plain([`From: ${rawFrom}`, "Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["Äiti Käyttäjä <aiti@example.com>"] } }, "hei@sunspot.fi");
  assert.equal(header(out, "Reply-To"), rawFrom);
  // non-ASCII name -> RFC 2047 encoded-words, ASCII-only header line
  const from = header(out, "From");
  assert.match(from, /^(=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= ?)+ <forwarder@sunspot\.fi>$/);
  const decoded = decodeEncodedWords(from.replace(/ <forwarder@sunspot\.fi>$/, ""));
  assert.equal(decoded, "Äiti Käyttäjä via sunspot.fi");
});

test("senderLabel() decodes encoded-words and strips quoting", () => {
  assert.equal(senderLabel('"Doe, Jane" <jane@example.com>'), "Doe, Jane");
  assert.equal(senderLabel("=?UTF-8?Q?J=C3=A4rvinen?= <j@example.com>"), "Järvinen");
  assert.equal(senderLabel("<only@example.com>"), "only@example.com");
  assert.equal(senderLabel(""), "unknown sender");
  assert.equal([...senderLabel("x".repeat(500) + " <a@b.fi>")].length, 64);
});

test("encodePhrase() keeps every encoded-word within 75 characters", () => {
  const enc = encodePhrase("Ääkkösiä ".repeat(10) + "via ololla.fi");
  for (const word of enc.split("\r\n ")) assert.ok(word.length <= 75, word);
  assert.equal(decodeEncodedWords(enc.replace(/\r\n /g, " ")), "Ääkkösiä ".repeat(10) + "via ololla.fi");
  assert.equal(encodePhrase("plain via x.fi"), '"plain via x.fi"');
});

test("decodeEncodedWords() leaves an unknown charset untouched", () => {
  assert.equal(decodeEncodedWords("=?x-nonexistent?B?YWJj?="), "=?x-nonexistent?B?YWJj?=");
});

test("rewrite() keeps the sender's own Reply-To as X-Original-Reply-To", () => {
  const raw = plain(["From: noreply@vendor.example", "Reply-To: Customer <customer@example.com>", "X-Original-Reply-To: forged@example.com", "Subject: x"]);
  const out = rewrite(raw, "forwarder@saatavilla.fi", { commonHeaders: { from: ["noreply@vendor.example"] } }, "tuki@saatavilla.fi");
  assert.equal(header(out, "Reply-To"), "noreply@vendor.example");
  assert.equal(header(out, "X-Original-Reply-To"), "Customer <customer@example.com>");
  assert.equal((headersOf(out).match(/^X-Original-Reply-To:/gim) || []).length, 1);
});

test("rewrite() does not let a bare CR or a control-character header name smuggle X-Original-To", () => {
  const raw = Buffer.from(
    "From: a@example.com\r\nSubject: hi\rX-Original-To: tietosuoja@ololla.fi\r\nX-Original-To\0: tietosuoja@ololla.fi\r\n\r\nbody\r\n",
    "utf8",
  );
  const out = rewrite(raw, "forwarder@ololla.fi", { commonHeaders: { from: ["a@example.com"] } }, "tuki@ololla.fi").toString("utf8");
  const h = out.split("\r\n\r\n")[0];
  assert.ok(!/\r(?!\n)/.test(h), "no lone CR left in the headers");
  assert.equal((h.match(/^X-Original-To/gim) || []).length, 1, "only our X-Original-To starts a header line");
  assert.match(out, /\r\nX-Original-To: tuki@ololla\.fi\r\n/);
});

test("rewrite() keeps the header block intact around a stray CR (\\r\\r\\n) and whitespace before a colon", () => {
  const raw = Buffer.from(
    "From: a@example.com\r\nSubject: x\r\r\nSubject2\t: y\r\nContent-Type: text/html\r\n\r\n<b>hi</b>\r\n",
    "utf8",
  );
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
  const [h, body] = out.split("\r\n\r\n");
  assert.match(h, /^Content-Type: text\/html$/m, "Content-Type stays in the headers");
  assert.match(h, /^Subject2\t: y$/m, "obsolete whitespace-before-colon header is kept");
  assert.equal(body, "<b>hi</b>\r\n");
});

test("rewrite() never copies a From that would be cut by its many folds", () => {
  const raw = plain(["From:" + "\r\n ".repeat(2665) + "victim@example.com", "Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: [] } }, "hei@sunspot.fi");
  const rt = header(out, "Reply-To");
  assert.ok(rt === null || rt === "victim@example.com", `Reply-To is whole or absent, got ${rt}`);
});

test("rewrite() omits Reply-To rather than cutting an oversized From mid-address", () => {
  const huge = "x".repeat(2000) + "@example.com";
  const raw = plain([`From: ${huge}`, "Subject: x"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: [huge] } }, "hei@sunspot.fi");
  assert.equal(header(out, "Reply-To"), null);
  for (const line of headersOf(out).split("\r\n")) assert.ok(Buffer.byteLength(line) <= 998, "header line within 998 octets");
});

// ---- RK9-874: handler routing (AWS clients stubbed) ---------------------------

function sesEvent(recipients, { spam = "PASS", virus = "PASS" } = {}) {
  return {
    Records: [{
      ses: {
        mail: { messageId: "msg-1", commonHeaders: { from: ["Matti <matti@example.com>"] } },
        receipt: { recipients, spamVerdict: { status: spam }, virusVerdict: { status: virus } },
      },
    }],
  };
}

async function runHandler(event, env = {}) {
  const calls = { s3: [], ses: [] };
  const origS3 = S3Client.prototype.send;
  const origSes = SESClient.prototype.send;
  const saved = {};
  for (const k of ["ROUTED_DOMAINS", "FORWARD_TO"]) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  S3Client.prototype.send = async (cmd) => {
    calls.s3.push(cmd.input);
    return { Body: Readable.from([Buffer.from("From: Matti <matti@example.com>\r\nSubject: hi\r\n\r\nbody\r\n")]) };
  };
  SESClient.prototype.send = async (cmd) => {
    calls.ses.push(cmd.input);
    return {};
  };
  try {
    const res = await handler(event);
    return { res, calls };
  } finally {
    S3Client.prototype.send = origS3;
    SESClient.prototype.send = origSes;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("handler forwards a routed address to Aava only, never to FORWARD_TO", async () => {
  const { res, calls } = await runHandler(sesEvent(["tuki@saatavilla.fi"]), { FORWARD_TO: "operator@example.com" });
  assert.deepEqual(res, { disposition: "CONTINUE" });
  assert.equal(calls.s3.length, 1);
  assert.equal(calls.s3[0].Key, "saatavilla/msg-1");
  assert.equal(calls.ses.length, 1);
  assert.deepEqual(calls.ses[0].Destinations, ["aava@rk9.fi"]);
  assert.equal(calls.ses[0].Source, "forwarder@saatavilla.fi");
  const sent = Buffer.from(calls.ses[0].RawMessage.Data).toString("utf8");
  assert.match(sent, /^From: "Matti via saatavilla\.fi" <forwarder@saatavilla\.fi>\r\n/);
  assert.match(sent, /\r\nX-Original-To: tuki@saatavilla\.fi\r\n/);
});

test("handler keeps a bounce to forwarder@<domain> in S3 (no loop)", async () => {
  const { calls } = await runHandler(sesEvent(["forwarder@sunspot.fi"]));
  assert.equal(calls.ses.length, 0);
});

test("handler keeps an s3-only address in S3 without fetching or sending", async () => {
  const { calls } = await runHandler(sesEvent(["noreply@saatavilla.fi"]));
  assert.equal(calls.s3.length, 0);
  assert.equal(calls.ses.length, 0);
});

test("handler does not forward an explicit spam FAIL", async () => {
  const { calls } = await runHandler(sesEvent(["hei@sunspot.fi"], { spam: "FAIL" }));
  assert.equal(calls.ses.length, 0);
});

test("handler uses FORWARD_TO only for a domain not yet in ROUTED_DOMAINS", async () => {
  const env = { ROUTED_DOMAINS: "sunspot.fi", FORWARD_TO: "legacy@example.com" };
  const legacy = await runHandler(sesEvent(["tuki@ololla.fi"]), env);
  assert.deepEqual(legacy.calls.ses[0].Destinations, ["legacy@example.com"]);
  const routed = await runHandler(sesEvent(["hei@sunspot.fi"]), env);
  assert.deepEqual(routed.calls.ses[0].Destinations, ["aava@rk9.fi"]);
});

test("handler throws (message stays in S3) for a legacy domain with no FORWARD_TO", async () => {
  await assert.rejects(runHandler(sesEvent(["tuki@ololla.fi"]), { ROUTED_DOMAINS: "sunspot.fi" }), /FORWARD_TO is empty/);
});
