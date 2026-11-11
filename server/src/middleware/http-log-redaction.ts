export const HTTP_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["proxy-authorization"]',
  "req.headers.cookie",
  // "set-cookie" is normally a response header; keep the request-side
  // path as defensive coverage in case a proxy forwards it inbound.
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  'req.headers["x-api-key"]',
  // Cloud proxy credentials and signed assertions authorize tenant access.
  'req.headers["x-paperclip-cloud-tenant-token"]',
  'req.headers["x-paperclip-cloud-session-id"]',
  'req.headers["x-paperclip-cloud-runtime-identity"]',
  'req.headers["x-paperclip-cloud-control"]',
  // Runtime GitHub capabilities authorize credential acquisition for a live run.
  'req.headers["x-paperclip-github-capability"]',
  // Telegram's optional webhook verification header is a reusable bearer
  // secret sent on every provider callback.
  'req.headers["x-telegram-bot-api-secret-token"]',
  // --- RK9 Custom (RK9-621): reserved coord-token header. Clients send the
  // token as `Authorization: Bearer rk9_coord_...` (covered above); redact
  // this name too in case a client sends the token in a custom header. ---
  'req.headers["x-rk9-coord-token"]',
  // The structured failure logger adds a sanitized request-body copy under
  // `reqBody`. Keep the standard connector credential envelope covered again
  // at the final serialization boundary in case a future custom serializer
  // bypasses the recursive redactor.
  "reqBody.credentials",
  "errorContext.details.credentials",
] as const;
