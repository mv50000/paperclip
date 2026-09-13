// RK9-194: minimal raw-SMTP client (node:net only — no nodemailer/SMTP
// library; the repo's pnpm-lock.yaml pre-commit hook blocks new dependencies
// on a feature branch, see CONSTITUTION.md and RK9-196's `draft.ts`). Talks a
// plain, unauthenticated EHLO/MAIL FROM/RCPT TO/DATA dialog to a local
// Postfix relay (`localhost:25` on rk9-prod) — never TLS/auth, since Postfix
// is loopback-only and this is the only client allowed to talk to it.

import { Socket } from "node:net";

export interface SmtpResult {
  ok: boolean;
  /** Final SMTP reply code for the DATA transaction (or the failing step). */
  code: number;
  response: string;
}

export interface SmtpSendOptions {
  host: string;
  port: number;
  /** Bare envelope sender, e.g. "outreach@example.fi" (no display name). */
  envelopeFrom: string;
  /** Bare envelope recipient. */
  envelopeTo: string;
  /** Full raw RFC 5322 message (headers + body), CRLF or LF line endings. */
  data: string;
  /** HELO/EHLO identity. Defaults to the envelope sender's domain. */
  heloDomain?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface SmtpResponse {
  code: number;
  text: string;
}

/** Buffers `data` events until a full (possibly multi-line) SMTP reply arrives. */
function readResponse(socket: Socket, timeoutMs: number): Promise<SmtpResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("smtp response timeout"));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n").filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      // A final line has a space (not '-') as the 4th character: "250 OK" vs "250-PIPELINING".
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0, 3));
        resolve({ code, text: lines.join("\n") });
      }
    }
    function onError(err: Error) {
      cleanup();
      reject(err);
    }
    function onClose() {
      cleanup();
      reject(new Error("smtp connection closed before a full response"));
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function write(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`);
}

/** RFC 5321 dot-stuffing: a line starting with '.' gets an extra leading '.'. */
function dotStuff(data: string): string {
  return data
    .split(/\r\n|\n/)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/**
 * Dials `host:port`, sends one message, and reports the terminal SMTP code.
 * Never throws for a rejected message (4xx/5xx) — only for a connection-level
 * failure (timeout, refused, reset), which the caller should treat like a 4xx
 * (transient, retryable) since it says nothing about the message itself.
 */
export async function sendMail(opts: SmtpSendOptions): Promise<SmtpResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heloDomain = opts.heloDomain ?? opts.envelopeFrom.split("@")[1] ?? "localhost";
  const socket = new Socket();
  // A permanent listener for the socket's whole lifetime: readResponse()
  // adds/removes its own per-call 'error' listener, which leaves a window
  // (e.g. between the last readResponse() and finish()'s socket.end()) with
  // zero listeners — an 'error' event with no listener crashes the process.
  // This one is always there, so that never happens; readResponse's own
  // listener still does the real work of rejecting its promise.
  socket.on("error", () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      socket.once("error", onError);
      socket.connect(opts.port, opts.host, () => {
        socket.off("error", onError);
        resolve();
      });
    });

    const greeting = await readResponse(socket, timeoutMs);
    if (greeting.code !== 220) return finish(socket, { ok: false, code: greeting.code, response: greeting.text });

    write(socket, `EHLO ${heloDomain}`);
    const ehlo = await readResponse(socket, timeoutMs);
    if (ehlo.code !== 250) return finish(socket, { ok: false, code: ehlo.code, response: ehlo.text });

    write(socket, `MAIL FROM:<${opts.envelopeFrom}>`);
    const mailFrom = await readResponse(socket, timeoutMs);
    if (mailFrom.code !== 250) return finish(socket, { ok: false, code: mailFrom.code, response: mailFrom.text });

    write(socket, `RCPT TO:<${opts.envelopeTo}>`);
    const rcptTo = await readResponse(socket, timeoutMs);
    if (rcptTo.code !== 250 && rcptTo.code !== 251) {
      return finish(socket, { ok: false, code: rcptTo.code, response: rcptTo.text });
    }

    write(socket, "DATA");
    const dataStart = await readResponse(socket, timeoutMs);
    if (dataStart.code !== 354) return finish(socket, { ok: false, code: dataStart.code, response: dataStart.text });

    socket.write(`${dotStuff(opts.data)}\r\n.\r\n`);
    const dataEnd = await readResponse(socket, timeoutMs);
    return finish(socket, { ok: dataEnd.code >= 200 && dataEnd.code < 300, code: dataEnd.code, response: dataEnd.text });
  } catch (err) {
    socket.destroy();
    // Connection-level failure: no SMTP code was ever returned. 421 (service
    // unavailable) is the closest standard code and is retryable (4xx).
    return { ok: false, code: 421, response: err instanceof Error ? err.message : String(err) };
  }
}

function finish(socket: Socket, result: SmtpResult): SmtpResult {
  try {
    write(socket, "QUIT");
  } catch {
    // best-effort
  }
  socket.end();
  socket.destroy();
  return result;
}
