// Thin HTTP wrapper around Resend's REST API. We use node:fetch (no extra
// dependency) and only implement the endpoints we actually need:
//   - POST /emails           (send)
//   - GET  /domains/:id      (verification status, used by the cron that
//                              flips company_email_config.status to 'verified')
//   - GET  /emails/{id}/content  (used by inbound router in Vaihe 2)
//
// Per-company API key resolution lives in the orchestrator (services/email/index.ts);
// this module is stateless.

const RESEND_BASE = "https://api.resend.com";

export interface ResendSendInput {
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export type ResendSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; status: number; errorCode: string | null; errorMessage: string | null };

export interface ResendDomainStatus {
  id: string;
  status: "pending" | "verified" | "failed";
  records: Array<{ type: string; name: string; value: string; status: "pending" | "verified" }>;
}

export type ResendDomainResult =
  | { ok: true; domain: ResendDomainStatus }
  | { ok: false; status: number; errorMessage: string | null };

async function call<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; payload: unknown }> {
  const res = await fetch(`${RESEND_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) return { ok: false, status: res.status, payload };
  return { ok: true, data: payload as T };
}

export async function sendViaResend(apiKey: string, input: ResendSendInput): Promise<ResendSendResult> {
  const body = {
    from: input.from,
    to: input.to,
    cc: input.cc,
    reply_to: input.replyTo,
    subject: input.subject,
    html: input.html,
    text: input.text,
    headers: input.headers,
  };
  const res = await call<{ id: string }>(apiKey, "POST", "/emails", body);
  if (!res.ok) {
    const p = (res.payload ?? {}) as { name?: string; message?: string };
    return {
      ok: false,
      status: res.status,
      errorCode: p.name ?? null,
      errorMessage: p.message ?? null,
    };
  }
  return { ok: true, providerMessageId: res.data.id };
}

export async function getDomainStatus(apiKey: string, domainId: string): Promise<ResendDomainResult> {
  const res = await call<ResendDomainStatus>(apiKey, "GET", `/domains/${domainId}`);
  if (!res.ok) {
    const p = (res.payload ?? {}) as { message?: string };
    return { ok: false, status: res.status, errorMessage: p.message ?? null };
  }
  return { ok: true, domain: res.data };
}
