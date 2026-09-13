import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendMail } from "../services/outreach/smtp-client.js";

interface FakeSmtpOptions {
  /** Reply code for RCPT TO (default 250). Use 550 to simulate a hard bounce. */
  rcptCode?: number;
  /** Reply code once the DATA payload has been fully received (default 250). Use 450 for a soft/transient failure. */
  dataCode?: number;
  /** Every line the fake server received after DATA, dot-unstuffed removed (for assertions). */
  onData?: (raw: string) => void;
}

/** A tiny scripted SMTP server good enough to drive the real client dialog end to end. */
function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let buffer = "";
      let inData = false;
      let dataBuffer = "";
      socket.write("220 fake.local ESMTP\r\n");

      socket.on("data", (chunk) => {
        if (inData) {
          dataBuffer += chunk.toString("utf8");
          if (dataBuffer.endsWith("\r\n.\r\n")) {
            inData = false;
            opts.onData?.(dataBuffer.slice(0, -5));
            socket.write(`${opts.dataCode ?? 250} 2.0.0 OK queued\r\n`);
          }
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (/^EHLO/i.test(line)) {
            socket.write("250-fake.local greets you\r\n250 PIPELINING\r\n");
          } else if (/^MAIL FROM/i.test(line)) {
            socket.write("250 2.1.0 OK\r\n");
          } else if (/^RCPT TO/i.test(line)) {
            const code = opts.rcptCode ?? 250;
            socket.write(`${code} ${code === 250 ? "2.1.5 OK" : "no such user"}\r\n`);
          } else if (/^DATA/i.test(line)) {
            inData = true;
            socket.write("354 Start mail input\r\n");
          } else if (/^QUIT/i.test(line)) {
            socket.write("221 bye\r\n");
            socket.end();
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

describe("sendMail (raw SMTP dialog)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("completes EHLO/MAIL FROM/RCPT TO/DATA and reports the terminal 2xx code", async () => {
    let received = "";
    const fake = await startFakeSmtp({ onData: (raw) => (received = raw) });
    server = fake.server;

    const result = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      envelopeFrom: "outreach@example.fi",
      envelopeTo: "prospect@example.fi",
      data: "Subject: hi\r\n\r\nHello there.",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(250);
    expect(received).toContain("Hello there.");
  });

  it("dot-stuffs a leading dot in the body so it doesn't end the DATA early", async () => {
    let received = "";
    const fake = await startFakeSmtp({ onData: (raw) => (received = raw) });
    server = fake.server;

    const result = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      envelopeFrom: "outreach@example.fi",
      envelopeTo: "prospect@example.fi",
      data: "line one\r\n.line starting with a dot\r\nline three",
    });

    expect(result.ok).toBe(true);
    // The wire form must double the leading dot...
    expect(received).toContain("..line starting with a dot");
    // ...but a client re-parsing the message would unstuff it back.
  });

  it("classifies a 5xx RCPT TO rejection as a failed, non-ok result", async () => {
    const fake = await startFakeSmtp({ rcptCode: 550 });
    server = fake.server;

    const result = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      envelopeFrom: "outreach@example.fi",
      envelopeTo: "nobody@example.fi",
      data: "Subject: hi\r\n\r\nHello.",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(550);
  });

  it("classifies a 4xx DATA rejection as a retryable failure", async () => {
    const fake = await startFakeSmtp({ dataCode: 450 });
    server = fake.server;

    const result = await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      envelopeFrom: "outreach@example.fi",
      envelopeTo: "prospect@example.fi",
      data: "Subject: hi\r\n\r\nHello.",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(450);
  });

  it("reports a connection failure as a retryable 421 without throwing", async () => {
    const result = await sendMail({
      host: "127.0.0.1",
      port: 1, // nothing listens on a privileged port 1 in the test sandbox
      envelopeFrom: "outreach@example.fi",
      envelopeTo: "prospect@example.fi",
      data: "Subject: hi\r\n\r\nHello.",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(421);
  });

  it("does not crash the process when the socket errors right after the final response", async () => {
    // The server slams the connection shut (RST) the instant it replies, so
    // the client's socket can emit a late 'error' after sendMail() has
    // already resolved — exactly the window a per-call-only error listener
    // would miss.
    const fake = await startFakeSmtp({
      onData: () => {
        /* handled by server socket.destroy() below via the wrapping server */
      },
    });
    server = fake.server;
    server.removeAllListeners("connection");
    server.on("connection", (socket: Socket) => {
      socket.write("220 fake.local ESMTP\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (/^EHLO/i.test(text)) socket.write("250 fake.local\r\n");
        else if (/^MAIL FROM/i.test(text)) socket.write("250 OK\r\n");
        else if (/^RCPT TO/i.test(text)) socket.write("250 OK\r\n");
        else if (/^DATA/i.test(text)) socket.write("354 Go ahead\r\n");
        else if (text.endsWith("\r\n.\r\n")) {
          socket.write("250 OK\r\n");
          socket.destroy(); // abrupt reset right after the final reply
        }
      });
    });

    let uncaught: unknown;
    const onUncaught = (err: unknown) => (uncaught = err);
    process.once("uncaughtException", onUncaught);
    try {
      const result = await sendMail({
        host: "127.0.0.1",
        port: fake.port,
        envelopeFrom: "outreach@example.fi",
        envelopeTo: "prospect@example.fi",
        data: "Subject: hi\r\n\r\nHello.",
      });
      expect(result.ok).toBe(true);
      // Give a queued 'error'/'close' event a tick to fire, if it's going to.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toBeUndefined();
  });
});
