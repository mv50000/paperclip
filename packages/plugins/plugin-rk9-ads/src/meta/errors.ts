/**
 * Typed Meta Graph API errors (RK9-508).
 *
 * Every message is redacted before it reaches the constructor (see
 * `graph.ts`), and no error carries the raw response or a fetch error as
 * `cause`: Graph echoes request parts in some messages, and a host fetch error
 * can carry the request. `details` holds only whitelisted Graph fields.
 */

import { redactText } from "./redact.js";

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
 * The host could not resolve the token's secret_ref (missing binding, wrong
 * company, deleted secret). Nothing was sent to Meta.
 */
export class TokenResolveError extends MetaGraphError {
  constructor(message: string) {
    super(message);
    this.name = "TokenResolveError";
  }
}

/**
 * Error classes that need an operator, not a retry (A4, RK9-510). The class
 * is part of the dedupe key of the alert and the issue
 * (`rk9-ads:<brand>:<class>`), so one incident gives one of each. Every code
 * 190 is one class: the subcodes (460 password change, 463 expired, 467
 * invalidated) all need the same fix, a new system user token.
 */
export const TOKEN_INVALID_ERROR_CLASS = "token_invalid";
export type OperatorErrorClass = typeof TOKEN_INVALID_ERROR_CLASS;

export function operatorErrorClass(error: unknown): OperatorErrorClass | null {
  return error instanceof TokenInvalidError ? TOKEN_INVALID_ERROR_CLASS : null;
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

// ---------------------------------------------------------------------------
// Operator-readable messages (A8, RK9-514)
// ---------------------------------------------------------------------------

/** Graph `error_subcode`: the app that creates the creative is in development mode. */
export const APP_IN_DEVELOPMENT_SUBCODE = 1885183;

/** What an operator reads for a known Meta error: what happened and what to do. */
export interface KnownMetaError {
  summary: string;
  fix: string;
}

/** Known `error_subcode` values. A subcode wins over the error class and the code. */
export const KNOWN_META_SUBCODES: Readonly<Record<number, KnownMetaError>> = {
  [POLICY_ACCEPTANCE_SUBCODE]: {
    summary: "the ad account has not accepted Meta's policy terms",
    fix:
      "Open Ads Manager (or Business settings > Ad accounts) as an admin of this ad account, accept the pending terms " +
      "(for example the non-discrimination policy), then retry.",
  },
  [APP_IN_DEVELOPMENT_SUBCODE]: {
    summary: "the Meta app is in development mode, so its creatives cannot run as ads",
    fix: "Switch the Meta app (Sunspot Ads) to Live mode in the App Dashboard, then retry.",
  },
};

/** Known `code` values, used when the subcode is not known. */
export const KNOWN_META_CODES: Readonly<Record<number, KnownMetaError>> = {
  [TOKEN_INVALID_CODE]: {
    summary: "the Meta access token is expired or revoked",
    fix: "Generate a new system user token for this brand and update the company secret.",
  },
  10: {
    summary: "the token lacks a permission for this object",
    fix: "Give the system user ads_management on the ad account and the page, then run Verify connection.",
  },
  200: {
    summary: "the token lacks a permission for this object",
    fix: "Give the system user ads_management on the ad account and the page, then run Verify connection.",
  },
  368: {
    summary: "Meta has temporarily blocked this account from posting",
    fix: "Check Account Quality in Business settings and wait for the block to lift.",
  },
};

function oneLine(text: string, max = 400): string {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function known(error: MetaGraphError): KnownMetaError | null {
  if (error.subcode !== null && Object.hasOwn(KNOWN_META_SUBCODES, error.subcode)) return KNOWN_META_SUBCODES[error.subcode]!;
  if (error instanceof TokenInvalidError) return KNOWN_META_CODES[TOKEN_INVALID_CODE]!;
  if (error.code !== null && Object.hasOwn(KNOWN_META_CODES, error.code)) return KNOWN_META_CODES[error.code]!;
  return null;
}

/**
 * One line an operator can act on: what failed, the Meta code, and the fix.
 * No stack trace and no token: every MetaGraphError message is redacted
 * already, and any other error contributes only its first line.
 */
export function operatorMessage(error: unknown): string {
  if (error instanceof MetaGraphError) {
    const codes = [error.code !== null ? `code ${error.code}` : null, error.subcode !== null ? `subcode ${error.subcode}` : null]
      .filter(Boolean)
      .join(", ");
    const entry = known(error);
    if (entry) return oneLine(`Meta refused the request: ${entry.summary}${codes ? ` (${codes})` : ""}. Fix: ${entry.fix}`);
    if (error instanceof RateLimitError) {
      return oneLine(`Meta rate limit hit${codes ? ` (${codes})` : ""}. Fix: wait a few minutes and run the publish again; it resumes where it stopped.`);
    }
    if (error instanceof MediaProcessingError) {
      return oneLine(`${error.message}. Fix: re-encode the video (H.264/AAC MP4) and stage it again.`);
    }
    if (error instanceof MediaTimeoutError) {
      return oneLine(`${error.message}. Fix: run the publish again later; it keeps the uploaded video and polls again.`);
    }
    if (error instanceof WriteRefusedError) return oneLine(`${error.message}. Nothing was sent to Meta.`);
    if (error instanceof TokenResolveError) return oneLine(`${error.message}. Fix: check the brand's meta.accessTokenRef secret binding.`);
    const user = error.userMessage ? ` Meta says: ${error.userMessage}` : "";
    return oneLine(`${error.message}.${user}`);
  }
  const first = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return oneLine(first.split("\n")[0] ?? "unknown error");
}
