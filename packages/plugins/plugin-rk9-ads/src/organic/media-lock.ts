/**
 * The media lock of an organic card (RK9-852, M2).
 *
 * Meta fetches the media URL only after the tap, up to the card's TTL later.
 * The plugin cannot hash the file: the host fetch is text based and stops a
 * request after 30 s, so a video's bytes never reach the worker intact. The
 * lock is fail-closed instead:
 *
 * 1. A live card takes media only from a host in `organic.mediaHosts`.
 * 2. At card time one HEAD records Content-Length, ETag and Last-Modified.
 *    A live card needs Content-Length and an ETag or a Last-Modified.
 * 3. Just before the publish the same HEAD runs again. Any difference, a
 *    non-200 answer or a missing header closes the card as `media_changed`
 *    without a Meta call.
 * 4. With `organic.mediaHostTtlHours` the file expires at Last-Modified + TTL.
 *    The card's deadline comes before that, and a later publish is refused.
 *
 * The limit: a host that serves different bytes with the same length and
 * validators, or that swaps the file between the second HEAD and Meta's
 * fetch (seconds), is not caught. That is why only trusted hosts qualify.
 */

import type { OrganicMode } from "../config.js";
import { redactText } from "../meta/redact.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What one HEAD said about the media. Stored on the post (payload.mediaLock). */
export interface MediaLock {
  url: string;
  host: string;
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
  lastModified: string | null;
  lockedAt: string;
  /** Last-Modified + organic.mediaHostTtlHours, when both are known. */
  expiresAt: string | null;
}

export type LockCheck = { ok: true; lock: MediaLock; warnings: string[] } | { ok: false; code: string; message: string };

/** A card ends this long before the media host drops the file. */
export const MEDIA_EXPIRY_MARGIN_MS = 10 * 60_000;
/** A card shorter than this is not sent. */
export const MIN_CARD_MS = 5 * 60_000;

function header(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value && value.trim().length > 0 ? value.trim().slice(0, 200) : null;
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function head(fetch: FetchLike, url: string): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (response.status !== 200) return { ok: false, message: `HEAD answered ${response.status}` };
    return { ok: true, response };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `HEAD failed (${redactText(reason).slice(0, 120)})` };
  }
}

/**
 * Locks the media at card time. A live card is refused on an untrusted host
 * or a lock without validators; a dry-run card gets the same findings as
 * warnings, so the rehearsal shows what live would refuse.
 */
export async function lockMedia(
  fetch: FetchLike,
  input: { url: string; mode: OrganicMode; mediaHosts: readonly string[]; mediaHostTtlHours?: number; now: Date },
): Promise<LockCheck> {
  const host = hostOf(input.url);
  if (!host) return { ok: false, code: "media_untrusted", message: "the media URL must be https on the default port" };
  const live = input.mode === "live";
  const warnings: string[] = [];
  const finding = (code: string, message: string): LockCheck | null => {
    if (live) return { ok: false, code, message };
    warnings.push(`Live-tila hylkäisi tämän: ${message}`);
    return null;
  };

  if (!input.mediaHosts.includes(host)) {
    const refused = finding("media_untrusted", `media host ${host} is not in organic.mediaHosts`);
    if (refused) return refused;
  }
  const answer = await head(fetch, input.url);
  if (!answer.ok) return { ok: false, code: "media_unreachable", message: `the media could not be checked: ${answer.message}` };
  const headers = answer.response.headers;
  const rawLength = header(headers, "content-length");
  const contentLength = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  const etag = header(headers, "etag");
  const lastModified = header(headers, "last-modified");
  const modifiedMs = lastModified ? Date.parse(lastModified) : Number.NaN;

  if (contentLength === null || contentLength === 0 || (!etag && !lastModified)) {
    const refused = finding("media_unlockable", "the media host gives no Content-Length with an ETag or Last-Modified, so a swapped file would go unseen");
    if (refused) return refused;
  }
  let expiresAt: string | null = null;
  if (input.mediaHostTtlHours !== undefined) {
    if (!Number.isFinite(modifiedMs)) {
      const refused = finding("media_unlockable", "organic.mediaHostTtlHours is set but the media host gives no Last-Modified, so its expiry is unknown");
      if (refused) return refused;
    } else {
      expiresAt = new Date(modifiedMs + input.mediaHostTtlHours * 3_600_000).toISOString();
    }
  }
  return {
    ok: true,
    lock: {
      url: input.url,
      host,
      contentType: header(headers, "content-type"),
      contentLength,
      etag,
      lastModified,
      lockedAt: input.now.toISOString(),
      expiresAt,
    },
    warnings,
  };
}

/** The card deadline: the configured TTL, cut to end before the media expires. */
export function cardDeadline(lock: MediaLock, ttlDeadline: Date): Date {
  if (!lock.expiresAt) return ttlDeadline;
  const mediaDeadline = Date.parse(lock.expiresAt) - MEDIA_EXPIRY_MARGIN_MS;
  return new Date(Math.min(ttlDeadline.getTime(), mediaDeadline));
}

export function readLock(value: unknown): MediaLock | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  const url = text("url");
  const host = text("host");
  const lockedAt = text("lockedAt");
  if (!url || !host || !lockedAt) return null;
  return {
    url,
    host,
    contentType: text("contentType"),
    contentLength: typeof raw.contentLength === "number" && Number.isSafeInteger(raw.contentLength) ? raw.contentLength : null,
    etag: text("etag"),
    lastModified: text("lastModified"),
    lockedAt,
    expiresAt: text("expiresAt"),
  };
}

/**
 * Checks the lock again just before the publish. Null when the media still
 * matches; otherwise the reason, and the caller publishes nothing.
 */
export async function recheckMedia(fetch: FetchLike, lock: MediaLock, input: { url: string; mode: OrganicMode; mediaHosts: readonly string[]; now: Date }): Promise<string | null> {
  if (input.url !== lock.url) return "media_changed: the URL differs from the card";
  if (input.mode === "live" && !input.mediaHosts.includes(lock.host)) return `media_untrusted: ${lock.host} is no longer in organic.mediaHosts`;
  if (lock.expiresAt && input.now.getTime() >= Date.parse(lock.expiresAt) - MEDIA_EXPIRY_MARGIN_MS) {
    return "media_expired: the media host has dropped or is about to drop the file";
  }
  const answer = await head(fetch, input.url);
  if (!answer.ok) return `media_changed: ${answer.message}`;
  const headers = answer.response.headers;
  const rawLength = header(headers, "content-length");
  const now = {
    contentType: header(headers, "content-type"),
    contentLength: rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null,
    etag: header(headers, "etag"),
    lastModified: header(headers, "last-modified"),
  };
  for (const key of ["contentType", "contentLength", "etag", "lastModified"] as const) {
    if (lock[key] !== now[key]) return `media_changed: ${key} differs from the card`;
  }
  return null;
}
