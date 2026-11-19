import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";
import { Readable } from "node:stream";
import { rewrite, boundaryValues, sanitizeDanglingBoundaries, senderLabel, encodePhrase, decodeEncodedWords, originalMessageId, forwardedToValue, FORWARDED_TO_INVALID, UnforwardableMessageError, handler } from "./index.mjs";

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

// ---- RK9-930: X-Original-Message-ID ------------------------------------------

const countOf = (buf, name) => (headersOf(buf).match(new RegExp(`^${name}:`, "gim")) || []).length;
const fwd = (headers) =>
  rewrite(plain(headers), "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi");

test("rewrite() keeps the original Message-ID as X-Original-Message-ID and threading headers as is", () => {
  const out = fwd([
    "From: a@example.com",
    "Message-ID: <CAF1abc.def+x=y@mail.example.com>",
    "In-Reply-To: <prev@saatavilla.fi>",
    "References: <first@example.com>\r\n <prev@saatavilla.fi>",
    "Subject: Re: tilaus",
  ]);
  assert.equal(header(out, "X-Original-Message-ID"), "<CAF1abc.def+x=y@mail.example.com>");
  assert.equal(countOf(out, "X-Original-Message-ID"), 1);
  assert.equal(countOf(out, "Message-ID"), 0, "SES writes the forwarded copy's own Message-ID");
  assert.equal(header(out, "In-Reply-To"), "<prev@saatavilla.fi>");
  assert.equal(header(out, "References"), "<first@example.com> <prev@saatavilla.fi>");
  assert.equal(countOf(out, "X-Original-References"), 0);
  assert.equal(countOf(out, "X-Original-In-Reply-To"), 0);
  assert.equal(out.toString("utf8").split("\r\n\r\n")[1], "hello\r\n", "body intact");
});

test("rewrite() forwards a message without a Message-ID and adds no X-Original-Message-ID", () => {
  const out = fwd(["From: a@example.com", "Subject: x"]);
  assert.equal(countOf(out, "X-Original-Message-ID"), 0);
  assert.equal(header(out, "Subject"), "x");
  assert.equal(out.toString("utf8").split("\r\n\r\n")[1], "hello\r\n");
});

test("rewrite() drops a forged inbound X-Original-Message-ID and every other X-Original-* header", () => {
  const forged = [
    "X-Original-Message-ID: <forged@attacker.example>",
    "x-original-message-id: <forged2@attacker.example>",
    "X-Original-References: <forged@attacker.example>",
    "X-Original-In-Reply-To: <forged@attacker.example>",
    "X-Original-Sender: forged@attacker.example",
  ];
  const withId = fwd(["From: a@example.com", "Message-ID: <real@example.com>", ...forged, "Subject: x"]);
  assert.equal(countOf(withId, "X-Original-Message-ID"), 1);
  assert.equal(header(withId, "X-Original-Message-ID"), "<real@example.com>");
  assert.ok(!/attacker/.test(headersOf(withId)), "no forged value survives");

  const withoutId = fwd(["From: a@example.com", ...forged, "Subject: x"]);
  assert.equal(countOf(withoutId, "X-Original-Message-ID"), 0);
  assert.ok(!/attacker/.test(headersOf(withoutId)), "no forged value survives");
});

test("rewrite() omits X-Original-Message-ID when the value has a line break", () => {
  // folded inside the id
  assert.equal(countOf(fwd(["From: a@example.com", "Message-ID: <abc\r\n def@example.com>"]), "X-Original-Message-ID"), 0);
  // a lone CR is no line end, and the id it leaves behind is not valid
  assert.equal(countOf(fwd(["From: a@example.com", "Message-ID: <abc\rdef@example.com>"]), "X-Original-Message-ID"), 0);
  // a bare LF starts a new (forged) header line, which is dropped
  const lf = fwd(["From: a@example.com", "Message-ID: <ok@example.com>\nX-Original-Message-ID: <forged@attacker.example>"]);
  assert.equal(countOf(lf, "X-Original-Message-ID"), 1);
  assert.equal(header(lf, "X-Original-Message-ID"), "<ok@example.com>");
  // folding before the id is whitespace, not part of the value
  assert.equal(header(fwd(["From: a@example.com", "Message-ID:\r\n <ok@example.com>"]), "X-Original-Message-ID"), "<ok@example.com>");
});

test("originalMessageId() accepts only one single-line <left@right> id that fits a header line", () => {
  const blk = (v) => [[`Message-ID:${v}`]];
  assert.equal(originalMessageId(blk(" <a@b>")), "<a@b>");
  assert.equal(originalMessageId([]), "");
  assert.equal(originalMessageId([...blk(" <a@b>"), ...blk(" <c@d>")]), "", "two Message-IDs are ambiguous");
  for (const bad of [" a@b", " <ab>", " <a@b", " <a b@c>", " <a<b@c>", " <@b>", " <a@>", " <a@b> x", " <ä@b>", " <a\x00@b>", ""]) {
    assert.equal(originalMessageId(blk(bad)), "", JSON.stringify(bad));
  }
  const fits = `<${"x".repeat(975 - 4)}@b>`; // 975 characters
  assert.equal(originalMessageId(blk(` ${fits}`)), fits);
  assert.equal(originalMessageId(blk(` <x${fits.slice(1)}`)), "", "976 characters would make a line over 998 octets");
  const out = fwd(["From: a@example.com", `Message-ID: ${fits}`]);
  for (const line of headersOf(out).split("\r\n")) assert.ok(Buffer.byteLength(line) <= 998, "header line within 998 octets");
  assert.equal(countOf(out, "X-Original-Message-ID"), 1);
  assert.equal(countOf(fwd(["From: a@example.com", `Message-ID: <${"x".repeat(1200)}@b>`]), "X-Original-Message-ID"), 0);
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

// RK9-888: a message converted to CRLF twice has `\r\r\n` on every line, the empty
// line included. The header/body split used to miss it and forward an empty body.
test("rewrite() finds the end of the headers in a message with \\r\\r\\n on every line", () => {
  const raw = Buffer.from(
    "From: a@example.com\r\r\nSubject: x\r\r\nContent-Type: text/plain\r\r\n\r\r\nline 1\r\r\nline 2\r\r\n",
    "utf8",
  );
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
  const sep = out.indexOf("\r\n\r\n");
  const h = out.slice(0, sep);
  assert.equal(out.slice(sep + 4), "line 1\r\nline 2\r\n", "the body is forwarded whole, with plain CRLF line ends");
  assert.match(h, /^Content-Type: text\/plain *$/m, "Content-Type stays in the headers");
  assert.match(h, /^Subject: x *$/m);
  assert.equal(header(out, "Reply-To"), "a@example.com");
  assert.ok(!/\r(?!\n)/.test(h), "no lone CR left in the headers");
});

test("rewrite() repairs the multipart delimiters of a doubly converted message", () => {
  const lines = [
    "From: a@example.com",
    'Content-Type: multipart/alternative; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain",
    "",
    "plain",
    "--B1",
    "Content-Type: text/html",
    "",
    "<b>html</b>",
    "--B1--",
    "",
  ];
  const raw = Buffer.from(lines.join("\r\r\n"), "utf8");
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
  const sep = out.indexOf("\r\n\r\n");
  assert.match(out.slice(0, sep), /^Content-Type: multipart\/alternative; boundary="B1" *$/m);
  assert.equal(out.slice(sep + 4), lines.slice(3).join("\r\n"), "every delimiter line ends in a plain CRLF");
  // a body without a double CR is passed through byte for byte
  const clean = "a\rb\r\nc\n";
  const out2 = rewrite(Buffer.from(`From: a@example.com\r\n\r\n${clean}`), "forwarder@sunspot.fi", {}, "hei@sunspot.fi").toString("utf8");
  assert.ok(out2.endsWith(`\r\n\r\n${clean}`));
});

test("rewrite() drops an empty first line instead of ending its headers early", () => {
  const raw = Buffer.from("\nFrom: a@example.com\r\nContent-Type: text/html\r\n\r\n<b>hi</b>", "utf8");
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
  const [h, body] = out.split("\r\n\r\n");
  assert.match(h, /^Content-Type: text\/html$/m);
  assert.equal(body, "<b>hi</b>");
});

test("rewrite() drops a leading continuation line that would fold into X-Original-To", () => {
  for (const raw of [
    " , tietosuoja@sunspot.fi\r\nFrom: a@example.com\r\nSubject: s\r\n\r\nb",
    "\r\r\n X-Original-To: tietosuoja@sunspot.fi\r\nFrom: a@example.com\r\n\r\nb",
    "\tSubject: x\r\n\tmore\r\nFrom: a@example.com\r\n\r\nb",
  ]) {
    const out = rewrite(Buffer.from(raw, "utf8"), "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
    const h = out.split("\r\n\r\n")[0];
    assert.ok(!h.includes("tietosuoja"), JSON.stringify(raw));
    assert.match(h, /\r\nX-Original-To: hei@sunspot\.fi(\r\n[^ \t]|$)/, JSON.stringify(raw));
    assert.ok(!/\r\n[ \t]/.test(h.slice(h.indexOf("X-Original-To"))), "nothing folds after X-Original-To");
  }
});

test("rewrite() splits CRLF, LF and mixed line endings exactly as before", () => {
  const m = { commonHeaders: { from: ["a@example.com"] } };
  for (const [raw, body] of [
    ["From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n", "body\r\n"],
    ["From: a@example.com\nSubject: x\n\nbody\n", "body\n"],
    ["From: a@example.com\nSubject: x\r\n\nbody", "body"],
    ["From: a@example.com\nSubject: x\n\r\nbody", "body"],
    ["From: a@example.com\r\nSubject: x", ""],
  ]) {
    const out = rewrite(Buffer.from(raw, "utf8"), "forwarder@sunspot.fi", m, "hei@sunspot.fi").toString("utf8");
    const sep = out.indexOf("\r\n\r\n");
    assert.equal(out.slice(sep + 4), body, JSON.stringify(raw));
    assert.match(out.slice(0, sep), /^Subject: x$/m, JSON.stringify(raw));
  }
});

test("rewrite() splits a long run of CRs in linear time", () => {
  const raw = Buffer.from("From: a@example.com\r\nSubject: " + "\r".repeat(2_000_000) + "\r\n\r\nbody" + "\r".repeat(2_000_000) + "x\r\r\n", "utf8");
  const t0 = Date.now();
  const out = rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi").toString("utf8");
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.ok(out.endsWith("x\r\n"));
});

// RK9-888 (verifier Low): a line with a tab but no colon is not a header.
test("rewrite() drops a header line that has a tab but no colon", () => {
  const raw = plain(["From: a@example.com", "Subject: x", "junk\tline", "plain junk"]);
  const h = headersOf(rewrite(raw, "forwarder@sunspot.fi", { commonHeaders: { from: ["a@example.com"] } }, "hei@sunspot.fi"));
  assert.ok(!h.includes("junk\tline"));
  assert.ok(!h.includes("plain junk"), "a colon-less line is dropped too (RK9-936)");
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

// ---- RK9-936: X-Rk9-Forwarded-To -----------------------------------------------

test("rewrite() writes the arrival address as X-Rk9-Forwarded-To, one bare address on one line", () => {
  const out = rewrite(plain(["From: a@example.com", "To: info@sunspot.fi", "Subject: x"]), "forwarder@sunspot.fi", {}, ["Hei@Sunspot.fi"]);
  assert.match(headersOf(out), /\r\nX-Rk9-Forwarded-To: hei@sunspot\.fi\r\n/);
  assert.equal(countOf(out, "X-Rk9-Forwarded-To"), 1);
  const single = rewrite(plain(["From: a@example.com"]), "forwarder@sunspot.fi", {}, "hei@sunspot.fi");
  assert.equal(header(single, "X-Rk9-Forwarded-To"), "hei@sunspot.fi");
});

test("rewrite() lists several routed recipients in X-Rk9-Forwarded-To separated by ', ', without folding", () => {
  const out = rewrite(plain(["From: a@example.com", "Subject: x"]), "forwarder@ololla.fi", {}, ["tuki@ololla.fi", "info@ololla.fi", "TUKI@ololla.fi"]);
  assert.match(headersOf(out), /\r\nX-Rk9-Forwarded-To: tuki@ololla\.fi, info@ololla\.fi\r\n(?![ \t])/);
});

test("rewrite() drops every inbound X-Rk9-* header, whatever its case", () => {
  const raw = plain([
    "From: a@example.com",
    "X-Rk9-Forwarded-To: tietosuoja@sunspot.fi",
    "x-rk9-forwarded-to: tietosuoja@sunspot.fi",
    "X-RK9-FORWARDED-TO : tietosuoja@sunspot.fi",
    "X-Rk9-Forwarded-To\0: tietosuoja@sunspot.fi",
    "X-Rk9-Anything: x",
    "Subject: x",
  ]);
  const withRcpt = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  assert.equal((headersOf(withRcpt).match(/^X-Rk9-/gim) || []).length, 1, "only our X-Rk9-Forwarded-To survives");
  assert.equal(header(withRcpt, "X-Rk9-Forwarded-To"), "hei@sunspot.fi");
  assert.ok(!/tietosuoja/.test(headersOf(withRcpt)));
  const noRcpt = rewrite(raw, "forwarder@sunspot.fi", {}, []);
  assert.equal((headersOf(noRcpt).match(/^X-Rk9-/gim) || []).length, 1, "our header is written even with no recipient");
  assert.equal(header(noRcpt, "X-Rk9-Forwarded-To"), "invalid");
});

test("rewrite() cannot smuggle an X-Rk9-Forwarded-To through a bare CR or a folded continuation", () => {
  const out = rewrite(
    Buffer.from("From: a@example.com\r\nSubject: hi\rX-Rk9-Forwarded-To: tietosuoja@sunspot.fi\r\n X-Rk9-Forwarded-To: x@sunspot.fi\r\n\r\nb", "utf8"),
    "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"],
  );
  const h = headersOf(out);
  assert.equal((h.match(/^X-Rk9-Forwarded-To/gim) || []).length, 1);
  assert.match(h, /\r\nX-Rk9-Forwarded-To: hei@sunspot\.fi\r\n(?![ \t])/);
});

test("forwardedToValue() gives 'invalid' when any address is malformed or the line is too long", () => {
  assert.equal(FORWARDED_TO_INVALID, "invalid");
  assert.equal(forwardedToValue(["hei@sunspot.fi"]), "hei@sunspot.fi");
  assert.equal(forwardedToValue([]), "invalid");
  assert.equal(forwardedToValue(undefined), "invalid");
  assert.equal(forwardedToValue(["hei@sunspot.fi", "bad address@sunspot.fi"]), "invalid", "one bad address voids the whole list");
  for (const bad of ["a@b", "<hei@sunspot.fi>", "Hei <hei@sunspot.fi>", "a,b@sunspot.fi", "hei@sunspot.fi\r\nX: y", "hei@sunspot.fi\0", "äiti@sunspot.fi", ""]) {
    assert.equal(forwardedToValue([bad]), "invalid", JSON.stringify(bad));
  }
  const many = Array.from({ length: 60 }, (_, i) => `osoite${i}-${"x".repeat(10)}@sunspot.fi`);
  assert.equal(forwardedToValue(many), "invalid", "a line over 998 octets is not written");
  const ok = forwardedToValue(many.slice(0, 5));
  assert.ok(Buffer.byteLength(`X-Rk9-Forwarded-To: ${ok}`) <= 998);
});

// Orchestrator review of RK9-936: the forwarder must never leave a sender's hidden
// copy as the only X-Rk9-Forwarded-To, and must not replay a header that a lenient
// parser could turn into one.
const hidden = [
  "\u200BX-Rk9-Forwarded-To: tietosuoja@sunspot.fi", // zero-width space before the name
  "\uFF38-Rk9-Forwarded-To: tietosuoja@sunspot.fi", // fullwidth X
  "X-Rk9\r\n\t-Forwarded-To: tietosuoja@sunspot.fi", // folded name, no colon on the first line
];

test("rewrite() writes X-Rk9-Forwarded-To: invalid for a long list or a non-ASCII recipient, and drops hidden copies", () => {
  const long = Array.from({ length: 15 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(60)}@sunspot.fi`);
  for (const rcpts of [long, ["äiti@sunspot.fi"]]) {
    const out = rewrite(plain(["From: a@example.com", ...hidden, "Subject: x"]), "forwarder@sunspot.fi", {}, rcpts);
    const h = headersOf(out);
    assert.equal((h.match(/X-Rk9/gi) || []).length, 1, "only our header mentions X-Rk9");
    assert.match(h, /\r\nX-Rk9-Forwarded-To: invalid\r\n/);
    assert.ok(!/tietosuoja/.test(h), "no hidden copy is replayed");
    for (const line of h.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 998);
  }
});

test("rewrite() drops a header whose name is not printable ASCII or that has no colon", () => {
  const out = rewrite(plain(["From: a@example.com", ...hidden, "Sübject: x", "plain junk", "Subject: ok"]), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.equal(countOf(out, "X-Rk9-Forwarded-To"), 1);
  assert.equal(header(out, "X-Rk9-Forwarded-To"), "hei@sunspot.fi");
  assert.ok(!/tietosuoja|Sübject|plain junk|Forwarded-To: t/.test(h));
  assert.equal(header(out, "Subject"), "ok");
});

test("rewrite() removes a form feed and other control characters from kept header values", () => {
  const raw = plain(["From: a@example.com", "X-A: a\x0cX-Rk9-Forwarded-To: tietosuoja@sunspot.fi", "Subject: hi\x0b\x00\x7f there", "X-B: one\r\n\ttwo\x1b"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(h), "no control character other than HTAB and the CRLF line ends");
  assert.match(h, /^X-A: aX-Rk9-Forwarded-To: tietosuoja@sunspot\.fi$/m, "the smuggled text stays inside X-A's value");
  assert.equal((h.match(/^X-Rk9-Forwarded-To:/gim) || []).length, 1);
  assert.equal(header(out, "Subject"), "hi there");
  assert.match(h, /^X-B: one\r\n\ttwo$/m, "folding is kept");
  assert.equal(out.toString("utf8").split("\r\n\r\n")[1], "hello\r\n", "body untouched");
});

test("rewrite() drops every inbound X-Pm-* header (Proton writes that family on delivery)", () => {
  const raw = plain([
    "From: a@example.com",
    "X-Pm-Date: Mon, 01 Jan 2035 00:00:00 +0000",
    "X-PM-Date: Mon, 01 Jan 2035 00:00:00 +0000",
    "x-pm-date : Mon, 01 Jan 2035 00:00:00 +0000",
    "X-Pm-Internal-Id: forged",
    "X-Pmx: kept",
    "Subject: x",
  ]);
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.ok(!/^x-pm-/im.test(h), "no X-Pm-* header is forwarded");
  assert.ok(!/2035|forged/.test(h));
  assert.equal(header(out, "X-Pmx"), "kept", "only the X-Pm- prefix is dropped");
  assert.equal(header(out, "Subject"), "x");
});

// ---- RK9-940: forwarder leftovers from the RK9-936 review --------------------

test("rewrite() removes C1 controls, NEL and U+2028/U+2029 from kept values and copied From", () => {
  const raw = plain([
    "From: Matti\u2028X-Rk9-Forwarded-To: tietosuoja@sunspot.fi\u0085X-Rk9-Forwarded-To: x@sunspot.fi <matti@example.com>",
    "Subject: a\u0085X-Rk9-Forwarded-To: hei@sunspot.fi\u2028X-Rk9-Forwarded-To: x@sunspot.fi",
    "X-A: one\u2029X-Rk9-Forwarded-To: tietosuoja@sunspot.fi",
    "X-B: c1\u0080\u009b\u009fend",
    "X-C: keep äiti 😀 \u00a0 \u00ff",
  ]);
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.ok(!/[\u0080-\u009f\u2028\u2029]/.test(h), "no C1 control or Unicode line separator is replayed");
  assert.equal(h.split(/\r\n/).length, h.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).length, "Python splitlines() sees the same lines");
  assert.equal((h.match(/^X-Rk9-Forwarded-To:/gim) || []).length, 1, "a JS m-flag reader sees one X-Rk9-Forwarded-To");
  assert.equal(header(out, "X-Rk9-Forwarded-To"), "hei@sunspot.fi");
  assert.equal(header(out, "Subject"), "aX-Rk9-Forwarded-To: hei@sunspot.fiX-Rk9-Forwarded-To: x@sunspot.fi", "the text stays inside Subject");
  assert.equal(header(out, "X-A"), "oneX-Rk9-Forwarded-To: tietosuoja@sunspot.fi");
  assert.equal(header(out, "X-B"), "c1end");
  assert.equal(header(out, "X-C"), "keep äiti 😀 \u00a0 \u00ff", "ordinary non-ASCII text is kept");
  assert.equal(header(out, "Reply-To"), "MattiX-Rk9-Forwarded-To: tietosuoja@sunspot.fiX-Rk9-Forwarded-To: x@sunspot.fi <matti@example.com>");
  assert.equal(header(out, "X-Original-From"), header(out, "Reply-To"));
  assert.equal(out.toString("utf8").split("\r\n\r\n")[1], "hello\r\n", "body untouched");
});

test("rewrite() drops a continuation line that holds only whitespace, before or after the cleaning", () => {
  const raw = plain(["From: a@example.com", "X-A: a\r\n\t\x0c", "X-B: b\r\n \r\n\t\r\n c\r\n \u00a0\u3000", "X-C: c\r\n \u0085\u2028", "Subject: s"]);
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  for (const line of h.split("\r\n")) assert.match(line, /[^ \t]/, `no blank header line: ${JSON.stringify(line)}`);
  assert.match(h, /^X-A: a\r\nX-B: b\r\n c\r\nX-C: c\r\nSubject: s$/m);
  assert.equal(header(out, "Subject"), "s", "later headers stay in the header block");
});

test("rewrite() replays ordinary headers byte for byte", () => {
  const lines = [
    "Subject: =?UTF-8?Q?Tilaus_=C3=A4iti?=\r\n =?UTF-8?Q?_nro_12?=",
    "To: Info <info@sunspot.fi>, \r\n\tToinen <toinen@example.com>",
    "Content-Type: multipart/alternative;\r\n\tboundary=\"=_abc-123\"",
    "X-Mailer: Äpp 1.0 \u00e4",
  ];
  const raw = plain(["From: a@example.com", ...lines], "--=_abc-123\r\nContent-Type: text/plain\r\n\r\nhei\r\n--=_abc-123--\r\n");
  const h = headersOf(rewrite(raw, "forwarder@sunspot.fi", {}, ["info@sunspot.fi"]));
  assert.ok(h.endsWith(`\r\n${lines.join("\r\n")}`), h);
});

test("rewrite() handles a long CR run inside a header line in linear time", { timeout: 10_000 }, () => {
  const raw = Buffer.from(`From: a@example.com\r\nSubject: ${"\r".repeat(2_000_000)}x\r\nContent-Type: multipart/mixed;${"\r".repeat(200_000)} boundary=b${"\r".repeat(200_000)}c\r\n\r\nbody`, "utf8");
  const t = Date.now();
  assert.throws(() => rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]), UnforwardableMessageError);
  // Many parameters without `=`, long pad runs and a long quoted value stay linear too.
  const params = Buffer.from(`From: a@example.com\r\nContent-Type: multipart/mixed${";".repeat(500_000)};${" ".repeat(500_000)}x; boundary="${"b".repeat(500_000)}"\r\n\r\nbody`, "utf8");
  rewrite(params, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const noCt = Buffer.from(`From: a@example.com\r\nSubject: ${"\r".repeat(2_000_000)}x\r\n\r\nbody`, "utf8");
  const out = rewrite(noCt, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.equal(out.toString("utf8").split("\r\n\r\n")[1], "body");
});

test("forwardedToValue() rejects a recipient that holds an encoded-word (=?)", () => {
  assert.equal(forwardedToValue(["=?utf-8?q?info?=@sunspot.fi"]), "invalid");
  assert.equal(forwardedToValue(["hei@sunspot.fi", "a=?b@sunspot.fi"]), "invalid");
  assert.equal(forwardedToValue(["a=b@sunspot.fi", "c?d@sunspot.fi", "e?=f@sunspot.fi"]), "a=b@sunspot.fi, c?d@sunspot.fi, e?=f@sunspot.fi");
  const out = rewrite(plain(["From: a@example.com"]), "forwarder@sunspot.fi", {}, ["=?utf-8?q?info?=@sunspot.fi"]);
  assert.equal(header(out, "X-Rk9-Forwarded-To"), "invalid");
});

test("rewrite() drops a header whose name holds a zero-width character anywhere (RK9-931)", () => {
  const names = ["X-Rk9\u200B-Forwarded-To", "X-Rk9-Forwarded-To\u200B", "X-Rk9-Forwarded\u200D-To", "\uFEFFX-Rk9-Forwarded-To", "X-Rk9-Forwarded-To\u2060 "];
  const out = rewrite(plain(["From: a@example.com", ...names.map((n) => `${n}: tietosuoja@sunspot.fi`), "Subject\u200B: forged", "Subject: ok"]), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.ok(!/tietosuoja|forged|[\u200b\u200d\u2060\ufeff]/.test(h), h);
  assert.equal((h.match(/X-Rk9/gi) || []).length, 1);
  assert.equal(header(out, "Subject"), "ok");
});

test("rewrite() refuses a message whose Content-Type boundary would change, so the boundary never splits from the body", () => {
  const body = (b) => `--${b}\r\nContent-Type: text/plain\r\n\r\nhei\r\n--${b}--\r\n`;
  const cases = [
    ["ab\x01cd", 'Content-Type: multipart/mixed; boundary="ab\x01cd"'],
    ["ab\u0085cd", 'Content-Type: multipart/mixed; boundary="ab\u0085cd"'],
    ["ab\x01cd", "Content-Type: multipart/mixed; boundary=ab\x01cd"], // bare value
    ["ab\x01cd", 'CONTENT-TYPE: Multipart/Mixed; BOUNDARY="ab\x01cd"'],
    ["ab\u2028cd", 'content-type : multipart/alternative; boundary="ab\u2028cd"'],
    ["ab\u0085cd", 'Content-Type: (c) multipart/mixed; boundary="ab\u0085cd"'], // a comment before the type
    ["ab\x01cd", 'Content-Type:\tmultipart/mixed; boundary="ab\x01cd"'],
    ["ab\x01cd", 'Content-Type: multipart /mixed; boundary="ab\x01cd"'],
    ["ab\x01cd", 'Content-Type: \x01multipart/mixed; boundary="ab\x01cd"'],
    ["ab\x01cd", 'Content-Type: text/plain; boundary="ab\x01cd"'], // the type does not matter
    ["ab\\\x01cd", 'Content-Type: multipart/mixed; boundary="ab\\\x01cd"'], // an escaped control character
    ["ab\x7fcd", 'Content-Type: text/plain\r\nContent-Type: multipart/mixed; boundary="ab\x7fcd"'], // the second of two
    ["abcd", 'Content-Type: multipart/mixed; x="a\\\x01\\"; boundary=abcd; y="'], // cleaning ends the quote early and reveals a boundary
  ];
  for (const [b, ct] of cases) {
    assert.throws(
      () => rewrite(plain(["From: a@example.com", ct], body(b)), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]),
      (err) => err instanceof UnforwardableMessageError && /Content-Type/.test(err.message),
      JSON.stringify(ct),
    );
  }
  // A clean Content-Type, a doubly converted one (\r\r\n) and junk in another header still forward.
  const ok = rewrite(plain(["From: a@example.com", 'Content-Type: multipart/mixed; boundary="abcd"', "X-A: a\x01"], body("abcd")), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  assert.equal(header(ok, "Content-Type"), 'multipart/mixed; boundary="abcd"');
  const doubled = Buffer.from(`From: a@example.com\r\r\nContent-Type: multipart/mixed; boundary="abcd"\r\r\n\r\r\n${body("abcd").replace(/\r\n/g, "\r\r\n")}`, "utf8");
  assert.match(headersOf(rewrite(doubled, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"])), /boundary="abcd"/);
});

test("boundaryValues() reads every boundary parameter, quoted or bare, in any case", () => {
  assert.deepEqual(boundaryValues('Content-Type: multipart/mixed; boundary="a;b"; x=1'), ["a;b"]);
  assert.deepEqual(boundaryValues('Content-Type: multipart/mixed; x="boundary=no"; Boundary = bare ; BOUNDARY="q\\"x"'), ["bare", 'q"x']);
  assert.deepEqual(boundaryValues('Content-Type: multipart/mixed; boundary="a\\";b"; x=1'), ['a";b']);
  assert.deepEqual(boundaryValues('Content-Type: boundary="type-only"'), []);
  assert.deepEqual(boundaryValues("Content-Type: multipart/mixed; boundary"), []);
  assert.deepEqual(boundaryValues('Content-Type: multipart/mixed; boundary="unclosed'), ["unclosed"]);
  assert.deepEqual(boundaryValues('Content-Type: multipart/mixed; boundary="ab"junk'), ["ab"]);
});

test("boundaryValues() skips RFC 822 comments outside quotes, and reads them as text with { comments: false } (RK9-945)", () => {
  const cases = [
    ['Content-Type: (c)multipart/mixed; boundary="ab"', ["ab"], ["ab"]],
    ['Content-Type: (")multipart/mixed; boundary="ab"', ["ab"], []], // a quote in the comment
    ["Content-Type: (a;b)multipart/mixed; boundary=ab", ["ab"], ["ab"]], // a semicolon in the comment
    ['Content-Type: (a(b")c)multipart/mixed; boundary="x"', ["x"], []], // a nested comment
    ['Content-Type: (a\\)")multipart/mixed; boundary="x"', ["x"], []], // an escaped ")" does not close the comment
    ['Content-Type: multipart/mixed; boundary="a(b"', ["a(b"], ["a(b"]], // "(" inside quotes is not a comment
    ['Content-Type: multipart/mixed; boundary="x" (c)', ["x"], ["x"]],
    ["Content-Type: multipart/mixed; boundary=ab(c)", ["ab"], ["ab(c)"]],
    ['Content-Type: multipart/mixed (; boundary="x")', [], ["x"]], // the boundary is inside the comment
    ['Content-Type: (multipart/mixed; boundary="x"', [], ["x"]], // an unclosed comment runs to the end
  ];
  for (const [line, aware, naive] of cases) {
    assert.deepEqual(boundaryValues(line), aware, JSON.stringify(line));
    assert.deepEqual(boundaryValues(line, { comments: false }), naive, JSON.stringify(line));
  }
});

test("rewrite() refuses a message whose boundary a comment hides from one reading of Content-Type (RK9-945)", () => {
  const body = "--ab\x01cd\r\n\r\nhei\r\n--ab\x01cd--\r\n";
  for (const ct of [
    'Content-Type: (c)multipart/mixed; boundary="ab\x01cd"',
    'Content-Type: (")multipart/mixed; boundary="ab\x01cd"',
    'Content-Type: (a;")multipart/mixed; boundary=ab\x01cd',
    'Content-Type: multipart/mixed (; boundary="ab\x01cd")',
    'Content-Type: multipart/mixed; x=y (\\"); boundary="ab\x01cd"',
  ]) {
    assert.throws(
      () => rewrite(plain(["From: a@example.com", ct], body), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]),
      (err) => err instanceof UnforwardableMessageError,
      JSON.stringify(ct),
    );
  }
  // A comment whose own text is cleaned still forwards: the boundary stays the same.
  const ok = rewrite(plain(["From: a@example.com", 'Content-Type: (c\x01) multipart/mixed; boundary="abcd"'], "--abcd\r\n\r\nhei\r\n--abcd--\r\n"), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  assert.equal(header(ok, "Content-Type"), '(c) multipart/mixed; boundary="abcd"');
});

test("rewrite() cleans and forwards a dirty Content-Type whose boundary stays the same, as before", () => {
  const variants = [
    ['Content-Type: application/pdf; name="Lasku 100\u0080.pdf"', 'application/pdf; name="Lasku 100.pdf"'],
    ['Content-Type: text/plain; name="\x1b$B%F%9%H\x1b(B.txt"', 'text/plain; name="$B%F%9%H(B.txt"'],
    ['Content-Type: text/plain; name="a\u2028b.txt"', 'text/plain; name="ab.txt"'],
    ["Content-Type: text/plain; charset=utf-8\x7f", "text/plain; charset=utf-8"],
    ["Content-Type: text/plain;\r charset=utf-8", "text/plain;  charset=utf-8"],
    ["Content-Type: text/plain;\r\n \r\n charset=utf-8", "text/plain; charset=utf-8"],
    ["Content-Type: text/plain;\r\n\t\r\n charset=utf-8", "text/plain; charset=utf-8"],
    ["Content-Type: text/html;\r\n \u00a0\r\n charset=utf-8", "text/html; charset=utf-8"],
    ['Content-Type: multipart/mixed; boundary="abcd"\r\nContent-Type: text/plain\x01', null],
    // A multipart or message Content-Type whose boundary stays the same (RK9-940 review).
    ['Content-Type: multipart/report; report-type=delivery-status;\r\n \r\n\tboundary="abcd"', 'multipart/report; report-type=delivery-status; boundary="abcd"'],
    ['Content-Type: multipart/report; report-type=delivery-status; boundary="abcd";\r\n ', 'multipart/report; report-type=delivery-status; boundary="abcd";'],
    ['Content-Type: multipart/signed; micalg=pgp-sha256\u0096; boundary="abcd"', 'multipart/signed; micalg=pgp-sha256; boundary="abcd"'],
    ['Content-Type: multipart/related; start="<a\x01@x>"; boundary="abcd"', 'multipart/related; start="<a@x>"; boundary="abcd"'],
    ['Content-Type: multipart/mixed; boundary="abcd"\x7f', 'multipart/mixed; boundary="abcd"'],
    ['Content-Type: multipart/mixed;\r\n \r\n boundary="abcd"', 'multipart/mixed; boundary="abcd"'],
    ['Content-Type: multipart/mixed;\r boundary="abcd"', 'multipart/mixed;  boundary="abcd"'],
    ['Content-Type: message/rfc822; name="fwd\u0096.eml"', 'message/rfc822; name="fwd.eml"'],
    ["Content-Type: message/rfc822;\x01 x=y", "message/rfc822; x=y"],
    ['Content-Type: multipart/mixed;\x0c boundary="abcd"', 'multipart/mixed; boundary="abcd"'], // the name is cleaned, the value is the same
    ['Content-Type: multipart/mixed; bound\x01ary="abcd"', 'multipart/mixed; boundary="abcd"'],
    ['Content-Type: multipart/mixed;\r\n \u0085\r\n boundary="abcd"', 'multipart/mixed; boundary="abcd"'],
  ];
  for (const [ct, want] of variants) {
    const body = "--abcd\r\n\r\nhei\r\n--abcd--\r\n";
    const out = rewrite(plain(["From: a@example.com", ct, "Subject: s"], body), "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
    if (want) assert.equal(header(out, "Content-Type"), want, JSON.stringify(ct));
    else assert.equal((headersOf(out).match(/^Content-Type: /gim) || []).length, 2);
    assert.equal(header(out, "Subject"), "s");
    assert.equal(countOf(out, "X-Rk9-Forwarded-To"), 1);
    assert.equal(out.toString("utf8").split("\r\n\r\n").slice(1).join("\r\n\r\n"), body, "body untouched");
  }
});

test("rewrite() forwards a doubly converted multipart message (\\r\\r\\n) whose Content-Type is not the last header", () => {
  const raw = Buffer.from(
    'From: a@example.com\r\r\nContent-Type: multipart/mixed;\r\r\n\tboundary="b1"\r\r\nSubject: s\r\r\n\r\r\n--b1\r\r\n\r\r\nhi\r\r\n--b1--\r\r\n',
    "utf8",
  );
  const out = rewrite(raw, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]);
  const h = headersOf(out);
  assert.ok(!/\r(?!\n)/.test(h), "no lone CR in the forwarded headers");
  assert.match(header(out, "Content-Type"), /^multipart\/mixed; +boundary="b1"$/);
  assert.equal(header(out, "Subject"), "s");
  assert.equal(out.toString("utf8").split("\r\n\r\n").slice(1).join("\r\n\r\n"), "--b1\r\n\r\nhi\r\n--b1--\r\n");
  const bare = Buffer.from("From: a@example.com\r\r\nContent-Type: multipart/mixed; boundary=b1\r\r\nSubject: s\r\r\n\r\r\n--b1\r\r\n\r\r\nhi\r\r\n--b1--\r\r\n", "utf8");
  assert.match(header(rewrite(bare, "forwarder@sunspot.fi", {}, ["hei@sunspot.fi"]), "Content-Type"), /^multipart\/mixed; boundary=b1$/);
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

const DEFAULT_RAW = "From: Matti <matti@example.com>\r\nSubject: hi\r\n\r\nbody\r\n";

async function runHandler(event, env = {}, raw = DEFAULT_RAW, run = handler) {
  const calls = { s3: [], ses: [], errors: [] };
  const origError = console.error;
  console.error = (...a) => calls.errors.push(a.join(" "));
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
    return { Body: Readable.from([Buffer.from(raw, "utf8")]) };
  };
  SESClient.prototype.send = async (cmd) => {
    calls.ses.push(cmd.input);
    return {};
  };
  try {
    const res = await run(event);
    return { res, calls };
  } finally {
    console.error = origError;
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
  assert.match(sent, /\r\nX-Rk9-Forwarded-To: tuki@saatavilla\.fi\r\n/);
});

test("handler writes only the forwarded recipients in the arrival headers, never an s3-only one", async () => {
  const { calls } = await runHandler(sesEvent(["uptime-probe@sunspot.fi", "hei@sunspot.fi"]));
  assert.equal(calls.ses.length, 1);
  assert.deepEqual(calls.ses[0].Destinations, ["aava@rk9.fi"]);
  const sent = Buffer.from(calls.ses[0].RawMessage.Data).toString("utf8");
  assert.match(sent, /\r\nX-Rk9-Forwarded-To: hei@sunspot\.fi\r\n/);
  assert.match(sent, /\r\nX-Original-To: hei@sunspot\.fi\r\n/);
  assert.ok(!/uptime-probe/.test(sent), "the s3-only recipient is not named");
});

test("handler keeps a message with a control character in Content-Type in S3 without sending", async () => {
  const raw = 'From: a@example.com\r\nContent-Type: multipart/mixed; boundary="ab\x01cd"\r\n\r\n--ab\x01cd\r\n\r\nhei\r\n--ab\x01cd--\r\n';
  const { res, calls } = await runHandler(sesEvent(["hei@sunspot.fi", "info@sunspot.fi"]), {}, raw);
  assert.deepEqual(res, { disposition: "CONTINUE" });
  assert.equal(calls.s3.length, 1);
  assert.equal(calls.ses.length, 0);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /^SKIP msg-1 \(sunspot\.fi\) unforwardable: .* key=msg-1$/);
});

// A second copy of index.mjs, with routes.json replaced by a table of two targets.
// Its own routing cache, so the shared copy above keeps the real routes.json.
async function twoTargetHandler() {
  const table = JSON.stringify({
    targets: { aava: ["aava@rk9.fi"], ops: ["ops@example.com"] },
    default: "s3-only",
    routes: { "hei@sunspot.fi": "aava", "info@sunspot.fi": "ops" },
  });
  const mod = await import("./index.mjs?two-targets");
  const origRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => (String(p).endsWith("/routes.json") ? table : origRead(p, ...rest));
  try {
    // The table is read on the first call and cached; a message to no one loads it.
    await runHandler(sesEvent(["nobody@sunspot.fi"]), {}, DEFAULT_RAW, mod.handler);
  } finally {
    fs.readFileSync = origRead;
  }
  return mod.handler;
}

test("handler sends no copy at all when the message is unforwardable for two targets (RK9-945)", async () => {
  const two = await twoTargetHandler();
  const rcpts = ["hei@sunspot.fi", "info@sunspot.fi"];
  // Control: a clean message goes out as two copies, one per target.
  const clean = await runHandler(sesEvent(rcpts), {}, DEFAULT_RAW, two);
  assert.deepEqual(clean.calls.ses.map((c) => c.Destinations), [["aava@rk9.fi"], ["ops@example.com"]]);
  // A boundary that cleaning would change: no copy is sent, to either target.
  const raw = 'From: a@example.com\r\nContent-Type: multipart/mixed; boundary="ab\x01cd"\r\n\r\n--ab\x01cd\r\n\r\nhei\r\n--ab\x01cd--\r\n';
  const { res, calls } = await runHandler(sesEvent(rcpts), {}, raw, two);
  assert.deepEqual(res, { disposition: "CONTINUE" });
  assert.equal(calls.s3.length, 1);
  assert.equal(calls.ses.length, 0);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /^SKIP msg-1 \(sunspot\.fi\) unforwardable: .* key=msg-1$/);
});

test("handler forwards a message with a dirty text/plain Content-Type", async () => {
  const raw = "From: a@example.com\r\nContent-Type: text/plain;\r\n \r\n charset=utf-8\r\n\r\nhei\r\n";
  const { calls } = await runHandler(sesEvent(["hei@sunspot.fi"]), {}, raw);
  assert.equal(calls.ses.length, 1);
  assert.equal(calls.errors.length, 0);
});

test("handler rethrows a rewrite() error that is not an unforwardable message", async () => {
  const event = sesEvent(["hei@sunspot.fi"]);
  event.Records[0].ses.mail.commonHeaders.from = [{ toString() { throw new Error("boom"); } }];
  const calls = { ses: [] };
  const origSes = SESClient.prototype.send;
  const origS3 = S3Client.prototype.send;
  const origError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  S3Client.prototype.send = async () => ({ Body: Readable.from([Buffer.from(DEFAULT_RAW, "utf8")]) });
  SESClient.prototype.send = async (cmd) => calls.ses.push(cmd.input);
  try {
    await assert.rejects(handler(event), /boom/);
  } finally {
    S3Client.prototype.send = origS3;
    SESClient.prototype.send = origSes;
    console.error = origError;
  }
  assert.equal(calls.ses.length, 0);
  assert.ok(!errors.some((e) => e.startsWith("SKIP")), "not logged as a skip");
  assert.ok(errors.some((e) => /^FAIL msg-1 .*boom/.test(e)));
});

test("handler keeps a bounce to forwarder@<domain> in S3 (no loop)", async () => {
  const { calls } = await runHandler(sesEvent(["forwarder@sunspot.fi"]));
  assert.equal(calls.ses.length, 0);
});

test("handler keeps an s3-only address in S3 without fetching or sending", async () => {
  const { calls } = await runHandler(sesEvent(["uptime-probe@sunspot.fi"]));
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
