/**
 * Typed Meta Graph API errors (RK9-508).
 *
 * Every message is redacted before it reaches the constructor (see
 * `graph.ts`), and no error carries the raw response or a fetch error as
 * `cause`: Graph echoes request parts in some messages, and a host fetch error
 * can carry the request. `details` holds only whitelisted Graph fields.
 */

/** Graph `error_subcode` for "the ad account has not accepted the policy terms". */
export const POLICY_ACCEPTANCE_SUBCODE = 2859024;

/** Graph `code` values that mean "throttled": app, user, ad account and business use case limits. */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 613, 80004]);

export const TOKEN_INVALID_CODE = 190;
export const INVALID_PARAM_CODE = 100;

export interface MetaGraphErrorDetails {
  /** HTTP status, or null when the request never got a response. */
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  fbtraceId: string | null;
  /** Graph's own end-user title and message, when it sent them. */
  userTitle?: string | null;
  userMessage?: string | null;
}

const EMPTY_DETAILS: MetaGraphErrorDetails = {
  httpStatus: null,
  code: null,
  subcode: null,
  type: null,
  fbtraceId: null,
};

/** Base class: any error the Meta client raises. */
export class MetaGraphError extends Error {
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly graphType: string | null;
  readonly fbtraceId: string | null;
  readonly userTitle: string | null;
  readonly userMessage: string | null;

  constructor(message: string, details: Partial<MetaGraphErrorDetails> = {}) {
    super(message);
    this.name = "MetaGraphError";
    const merged = { ...EMPTY_DETAILS, ...details };
    this.httpStatus = merged.httpStatus;
    this.code = merged.code;
    this.subcode = merged.subcode;
    this.graphType = merged.type;
    this.fbtraceId = merged.fbtraceId;
    this.userTitle = merged.userTitle ?? null;
    this.userMessage = merged.userMessage ?? null;
  }

  /** Plain, log-safe summary (no stack, no cause). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      httpStatus: this.httpStatus,
      code: this.code,
      subcode: this.subcode,
      type: this.graphType,
      fbtraceId: this.fbtraceId,
    };
  }
}

/** Code 190: the token is expired, revoked or malformed. Rotate the system user token. */
export class TokenInvalidError extends MetaGraphError {
  constructor(message: string, details: Partial<MetaGraphErrorDetails> = {}) {
    super(message, details);
    this.name = "TokenInvalidError";
  }
}

/**
 * Codes 4/17/613/80004: throttled. `retryAfterMs` is Meta's own estimate
 * (`estimated_time_to_regain_access`) when it sent one. `attempts` is how many
 * requests the client made before it gave up.
 */
export class RateLimitError extends MetaGraphError {
  readonly retryAfterMs: number | null;
  readonly attempts: number;

  constructor(
    message: string,
    details: Partial<MetaGraphErrorDetails> & { retryAfterMs?: number | null; attempts?: number } = {},
  ) {
    super(message, details);
    this.name = "RateLimitError";
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.attempts = details.attempts ?? 1;
  }
}

/** Code 100: an invalid or missing parameter. */
export class InvalidParamError extends MetaGraphError {
  constructor(message: string, details: Partial<MetaGraphErrorDetails> = {}) {
    super(message, details);
    this.name = "InvalidParamError";
  }
}

export const POLICY_ACCEPTANCE_FIX =
  "The ad account has not accepted Meta's policy terms. Open Ads Manager (or Business settings > Ad accounts) " +
  "as an admin of this ad account, accept the pending terms (for example the non-discrimination policy), " +
  "then retry.";

/** Subcode 2859024: the ad account must accept policy terms before it can create ads. */
export class PolicyAcceptanceRequiredError extends MetaGraphError {
  readonly fix: string;

  constructor(message: string, details: Partial<MetaGraphErrorDetails> = {}) {
    super(`${message} Fix: ${POLICY_ACCEPTANCE_FIX}`, details);
    this.name = "PolicyAcceptanceRequiredError";
    this.fix = POLICY_ACCEPTANCE_FIX;
  }
}

/** A POST or DELETE was attempted on a client created in read-only mode. Nothing was sent. */
export class ReadOnlyViolationError extends MetaGraphError {
  constructor(method: string, path: string) {
    super(`Read-only Meta client refused ${method} ${path}`);
    this.name = "ReadOnlyViolationError";
  }
}

/** The write guard (`guardedWrite`) refused a write. Nothing was sent. */
export class WriteRefusedError extends MetaGraphError {
  constructor(method: string, path: string, reason: string) {
    super(`Meta write ${method} ${path} refused: ${reason}`);
    this.name = "WriteRefusedError";
  }
}

/** Meta reported that an uploaded video failed processing. */
export class MediaProcessingError extends MetaGraphError {
  readonly mediaId: string;

  constructor(mediaId: string, message: string) {
    super(message);
    this.name = "MediaProcessingError";
    this.mediaId = mediaId;
  }
}

/** A video did not become ready within the polling timeout. */
export class MediaTimeoutError extends MetaGraphError {
  readonly mediaId: string;
  readonly lastStatus: string | null;

  constructor(mediaId: string, timeoutMs: number, lastStatus: string | null) {
    super(`Video ${mediaId} was not ready after ${timeoutMs} ms (last status: ${lastStatus ?? "unknown"})`);
    this.name = "MediaTimeoutError";
    this.mediaId = mediaId;
    this.lastStatus = lastStatus;
  }
}

/** Graph answered with something the client cannot read (not JSON, wrong shape, bad number). */
export class MetaResponseError extends MetaGraphError {
  constructor(message: string, details: Partial<MetaGraphErrorDetails> = {}) {
    super(message, details);
    this.name = "MetaResponseError";
  }
}
