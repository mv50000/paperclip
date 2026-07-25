// Junk guard (RK9-81): classify inbound mail from automated senders so the
// pipeline never auto-replies to, wakes an agent for, or escalates
// notification/bulk traffic. Born from the July 2026 incident where Instagram
// notification mail to a catch-all route was auto-replied and escalated to the
// CEO.
//
// This is a deliberately small heuristic — sender local-part patterns plus the
// standard automated-mail headers (RFC 3834 Auto-Submitted, Precedence,
// List-*). No content analysis, no ML.

const AUTOMATED_LOCAL_PART =
  /^(no-?reply|notifications?|notify|bounces?|mailer-daemon|postmaster|do-?not-?reply|auto-?reply|newsletter|updates?|alerts?|digest)([+._-]|$)/i;

/** Unwrap `"Name" <local@domain>` to `local@domain`; tolerate bare form. */
function bareAddress(addr: string): string {
  let s = addr.trim();
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt >= 0 && gt > lt) s = s.slice(lt + 1, gt).trim();
  return s;
}

export interface JunkClassification {
  automated: boolean;
  reason?: string;
}

/**
 * Classify an inbound message. `headers` keys are matched case-insensitively;
 * only the allowlisted headers extracted by the SES adapter are expected, but
 * any record works.
 */
export function classifyInbound(input: {
  from: string;
  headers?: Record<string, string>;
}): JunkClassification {
  const address = bareAddress(input.from);
  const at = address.lastIndexOf("@");
  const localPart = at > 0 ? address.slice(0, at) : address;
  if (AUTOMATED_LOCAL_PART.test(localPart)) {
    return { automated: true, reason: `sender_local_part:${localPart.toLowerCase()}` };
  }

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    lower[k.toLowerCase()] = v;
  }

  const autoSubmitted = lower["auto-submitted"]?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { automated: true, reason: `auto_submitted:${autoSubmitted}` };
  }

  const precedence = lower["precedence"]?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { automated: true, reason: `precedence:${precedence}` };
  }

  if (lower["list-unsubscribe"] !== undefined || lower["list-id"] !== undefined) {
    return { automated: true, reason: "list_headers" };
  }

  if (lower["x-auto-response-suppress"] !== undefined) {
    return { automated: true, reason: "x_auto_response_suppress" };
  }

  return { automated: false };
}
