// --- RK9 Custom (RK9-625): coord presence API (epic RK9-620, key presence-api) ---
//
// Mounted by routes/rk9-coord.ts at /api/companies/:companyId/rk9/coord/actors,
// behind rk9CoordActorMiddleware: company scope, the RK9-616 loopback rule and
// the actor claim are already resolved in req.rk9CoordActor. This router never
// parses X-RK9-Actor itself (ADR docs/implementation-notes/coord-identity.md).
//
//   PUT    /actors/me        upsert by (company_id, actor_ref); first registration logs activity
//   POST   /actors/me/phase  phase + liveness refresh; no activity_log row (log spam)
//   DELETE /actors/me        end; idempotent 204
//   GET    /actors           compact rows; ?active=1&repo=&issue=&limit=
//
// Contract and env vars: docs/implementation-notes/coord-bus.md ("Presence API").
import { Router, type Request, type RequestHandler } from "express";
import { ZodError, type ZodSchema } from "zod";
import type { Db } from "@paperclipai/db";
import {
  endRk9CoordActorSchema,
  everyRk9CoordString,
  RK9_COORD_METADATA_MAX_DEPTH,
  listRk9CoordActorsQuerySchema,
  updateRk9CoordActorPhaseSchema,
  upsertRk9CoordActorSchema,
  type ListRk9CoordActorsQuery,
  type UpdateRk9CoordActorPhase,
  type UpsertRk9CoordActor,
} from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import type { Rk9CoordResolvedActor } from "../middleware/rk9-coord-actor.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { isRk9CoordCounterKey, rk9CoordMatchText, rk9CoordTextHasSecret } from "../services/rk9-coord-text.js";
import {
  rk9CoordPresenceService,
  type Rk9CoordPresenceIdentity,
  type Rk9CoordPresenceOptions,
} from "../services/rk9-coord-presence.js";

export type Rk9CoordActorRouteOptions = Rk9CoordPresenceOptions;

function coordError(status: number, code: string, message: string) {
  return new HttpError(status, message, { code });
}

/** zod validation with the presence contract's 422 (the shared validate() answers 400). */
function validate422(schema: ZodSchema, part: "body" | "query"): RequestHandler {
  return (req, _res, next) => {
    try {
      const value = part === "body" ? (req.body ?? {}) : req.query;
      const parsed = schema.parse(value);
      if (part === "body") req.body = parsed;
      else (req as Request & { rk9CoordQuery?: unknown }).rk9CoordQuery = parsed;
      next();
    } catch (err) {
      next(err instanceof ZodError ? unprocessable("Validation error", err.issues) : err);
    }
  };
}

interface AdvisoryIdentity {
  kind?: string;
  host?: string;
  external_id?: string;
  externalId?: string;
}

function requireActor(req: Request): Rk9CoordResolvedActor {
  const actor = req.rk9CoordActor;
  // The middleware already rejects a mutation without an actor id; this is a
  // second line of defence for a router mounted elsewhere by mistake.
  if (!actor) throw coordError(400, "rk9_coord_actor_required", "A coord mutation requires an X-RK9-Actor header");
  return actor;
}

/**
 * The body's kind/host are advisory. A value that contradicts the resolved
 * actor is a spoof attempt or a client bug: reject it instead of storing it.
 */
function checkAdvisory(actor: Rk9CoordResolvedActor, body: AdvisoryIdentity) {
  if (body.kind !== undefined && body.kind !== actor.kind) {
    throw coordError(403, "rk9_coord_actor_spoof", "Body kind differs from the resolved actor");
  }
  if (body.host !== undefined && body.host !== actor.host) {
    throw coordError(
      403,
      "rk9_coord_host_mismatch",
      "Body host differs from the host the server attributes the actor to",
    );
  }
  return body.external_id ?? body.externalId ?? null;
}

/**
 * Fields the server stores verbatim (no redaction) must not carry a secret:
 * answer 422 instead of storing it. Phase and name are redacted instead.
 */
function rejectSecrets(fields: {
  branch?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const bad: string[] = [];
  if (fields.branch && rk9CoordTextHasSecret(fields.branch)) bad.push("branch");
  if (fields.external_id && rk9CoordTextHasSecret(fields.external_id)) bad.push("external_id");
  // String by string: JSON.stringify would escape a tab or newline into `\t`,
  // which the pattern's `\s` no longer sees (verifier round 2).
  if (fields.metadata && rk9CoordMetadataHasSecret(fields.metadata)) bad.push("metadata");
  if (bad.length > 0) {
    throw new HttpError(422, "Field looks like it contains a secret", {
      code: "rk9_coord_secret_in_field",
      fields: bad,
    });
  }
}

/**
 * Credential words, matched as whole name segments (RK9-642). A name is
 * split into segments at every non-alphanumeric character, at camelCase and
 * acronym boundaries (`githubToken`, `DBPassword`) and between letters and
 * digits (`password1`); it is also read with only the non-alphanumeric
 * splits, so `PassWords` and `apiKeys` stay one segment.
 */
const CREDENTIAL_WORDS = new Set([
  "token", "tokens", "secret", "secrets", "password", "passwords", "passwd", "passwds", "apikey", "apikeys",
  // RK9-665: one-word compounds, like `apikey`
  "secretkey", "secretkeys", "privatekey", "privatekeys", "passphrase", "passphrases",
  // RK9-678 (operator decision, the shared keyword set): `pass`, `pw` and
  // `credentials` keys. As a value only an upper-case name or a flag counts
  // (`DB_PASS`, `--pw`); a lower-case `pass` value is a word (VALUE_NAME_WORDS).
  "pass", "pw", "credential", "credentials",
]);
/** Words that form one credential word with a following `key`/`keys` segment. */
const KEY_PREFIXES = new Set(["api", "private"]);
/**
 * A credential word followed by one of these segments names metadata about
 * a credential, not the credential: `secret_scan`, `token_count`,
 * `tokens_used`, `password_policy`, `token_type`, `secret_name`. `id` is not
 * on the list: a Vault AppRole `secret_id` is the credential itself.
 */
const HARMLESS_SUFFIXES = new Set([
  "scan", "scanner", "scanning", "policy", "policies", "rule", "rules", "count", "counts", "used", "usage",
  "limit", "limits", "budget", "max", "min", "total", "totals", "type", "kind", "name", "names",
  "ref", "refs", "arn", "path", "file", "expiry", "expires", "expiration", "ttl", "length", "len",
  "rotation", "rotated", "status", "present", "required", "enabled", "provider", "source", "estimate",
]);
/**
 * Words whose `id` names the credential instead of being it (RK9-665 L2):
 * `token_id`, `api_key_id`. Their value is still checked, but a short
 * identifier passes (ID_VALUE_RX; a UUID only under a token id, see
 * KEY_ID_WORDS). `secret_id` and `password_id` stay credential names: a
 * Vault AppRole `secret_id` is the credential.
 */
const ID_WORDS = new Set(["token", "tokens", "apikey", "apikeys"]);
/**
 * RK9-678: an `api_key_id` gets the `keyid` mode, in which a UUID does not
 * pass: some providers issue UUID API keys, so a UUID under an API key name
 * is the key when the name is wrong. A token id keeps the UUID shape (the
 * RK9-665 L2 case, a token row id).
 */
const KEY_ID_WORDS = new Set(["apikey", "apikeys"]);

function nameSegmentations(name: string): string[][] {
  const text = rk9CoordMatchText(name);
  const plain = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [plain, split];
}

interface CredentialWord {
  word: string;
  /** `token_id`: the word is followed by `id`, so the name names an identifier. */
  id: boolean;
}

/**
 * The credential words a name contains: each credential word segment (`api`
 * + `key` and `private` + `key` count as one word) that is not followed by a
 * harmless suffix. Empty when the name is not a credential name.
 */
function credentialWordsOf(name: string): CredentialWord[] {
  const words: CredentialWord[] = [];
  for (const segments of nameSegmentations(name)) {
    for (let i = 0; i < segments.length; i += 1) {
      let next = i + 1;
      let word = segments[i]!;
      if (KEY_PREFIXES.has(word) && (segments[next] === "key" || segments[next] === "keys")) {
        word = `${word}${segments[next]}`;
        next += 1;
      } else if (!CREDENTIAL_WORDS.has(word)) continue;
      const suffix = segments[next];
      if (suffix !== undefined && HARMLESS_SUFFIXES.has(suffix)) continue;
      words.push({ word, id: (suffix === "id" || suffix === "ids") && ID_WORDS.has(word) });
    }
  }
  return words;
}

/**
 * How strictly a string under a credential name is checked (a string of 6+
 * characters without whitespace or quotes is a secret, SECRET_VALUE_RX):
 * - `strong`: no exemption;
 * - `id`: the name is `token_id`-like, so an identifier shape passes
 *   (ID_VALUE_RX: `tok_abc123`, digits, a UUID);
 * - `keyid`: the name is `api_key_id`-like: as `id`, but a UUID does not
 *   pass (RK9-678, KEY_ID_VALUE_RX);
 * - `word`: the name is a bare lower-case word given as a value
 *   (`["secret", "important"]`, `{"name": "tokens", "value": "unlimited"}`),
 *   so a value made of KNOWN_WORDS passes.
 * The exemptions test the raw value, so an invisible character voids them.
 * They apply only to a string directly at that position: an object or an
 * array below an `id` or `word` name is checked in the `strong` mode.
 * RK9-665: a real secret's shape never passes.
 */
type SecretMode = "none" | "id" | "keyid" | "word" | "strong";

function combineModes(a: SecretMode, b: SecretMode): SecretMode {
  if (a === "none") return b;
  if (b === "none" || a === b) return a;
  return "strong";
}

/**
 * Identifier shapes under a `token_id`-like name: a lower-case prefix and
 * up to 16 lower-case alphanumerics (`tok_abcdef123`), up to 20 digits, or a
 * lower-case UUID. Mixed case never passes: 24 base62 characters are a
 * full-strength secret.
 */
const ID_VALUE_RX = /^(?:[a-z]{2,8}_[a-z0-9]{1,16}|[0-9]{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** ID_VALUE_RX without the UUID shape, for the `keyid` mode. */
const KEY_ID_VALUE_RX = /^(?:[a-z]{2,8}_[a-z0-9]{1,16}|[0-9]{1,20})$/;
/**
 * Known vocabulary after a bare credential word (tags, labels, settings).
 * A value passes in the `word` mode when every `_`/`-` part is on this
 * list, so `reset_flow` passes and `correct-horse-battery-staple` does not.
 * Only words of 6+ letters matter: shorter values never match
 * SECRET_VALUE_RX.
 */
const KNOWN_WORDS = new Set([
  "important", "urgent", "critical", "billing", "usage", "unlimited", "limited", "enabled", "disabled",
  "required", "optional", "default", "pending", "active", "inactive", "expired", "revoked", "rotated",
  "rotation", "missing", "present", "invalid", "unknown", "reset", "flow", "manager", "management",
  "handling", "storage", "scanning", "scanner", "review", "security", "config", "settings", "update",
  "updated", "changed", "removed", "added", "refresh", "refreshed", "leaked", "exposed", "cleanup",
  // RK9-687 (a): a list of pass tags (`["first-pass", "second-pass", "review"]`)
  // puts each tag after a `word`-mode `x-pass` name.
  "first", "second", "third", "final", "pass",
]);

function isKnownVocabulary(value: string): boolean {
  if (!/^[a-z]+(?:[_-][a-z]+){0,3}$/.test(value)) return false;
  return value.split(/[_-]/).every((part) => KNOWN_WORDS.has(part));
}

function keyMode(key: string): SecretMode {
  const words = credentialWordsOf(key);
  if (words.length === 0) return "none";
  if (!words.every((word) => word.id)) return "strong";
  return words.some((word) => KEY_ID_WORDS.has(word.word)) ? "keyid" : "id";
}

/**
 * True when the name, without invisible characters, names a credential: a
 * credential word segment (`api` + `key` counts as one) that is not followed
 * by a harmless suffix. `password`, `SECRET_KEY`, `aws_secret_access_key`,
 * `DB_PASSWORD`, `password1`, `apiKeyProd` and `Password:` are credential
 * names; `tokens_used`, `secret_scan`, `tokenizer` and `secretary` are not,
 * and `token_id` names an identifier (checked in the `id` mode).
 */
export function isRk9CoordCredentialName(name: string): boolean {
  return keyMode(name) === "strong";
}

/**
 * Keys whose string value names the entry in a name/value pair object
 * (`{"name": "PASSWORD", "value": "..."}`, `{"Key": "db_password", "Value":
 * "..."}`, CloudFormation `ParameterKey`).
 */
const PAIR_NAME_KEY_RX = /^(k|id|var|variable|env|field|label|header|param|option|setting|flag|arg)$|(name|key)$/i;
/** Keys that hold the value in such a pair object. */
const PAIR_VALUE_KEY_RX = /^(v|val|data|content|default)$|value$/i;
/** The value part of the key=value branch of RK9_SESSIONS_SECRET_RX. */
const SECRET_VALUE_RX = /[^\s"',;]{6,}/;
/** Stand-in values for the key prefix probe: plain 8-character values. */
const KEY_PROBE_VALUES = ["abcdefgh", "12345678"];
/**
 * Separator items in an argv-style list (`["DB_PASSWORD", "=", "..."]`).
 * RK9-687 (d): the item is trimmed and read in the matching form, and the
 * full-width `＝`/`：` count (`" = "`, `"＝"`).
 */
const ARG_SEPARATOR_RX = /^[=:＝：]$/;

function isArgSeparator(item: unknown): boolean {
  return typeof item === "string" && ARG_SEPARATOR_RX.test(rk9CoordMatchText(item.trim()));
}
/**
 * Credential words that may end a credential name given as a value.
 * `authorization` names the HTTP header (`{"name": "Authorization", ...}`).
 */
const ASSIGN_NAME_WORDS = new Set([...CREDENTIAL_WORDS, "authorization"]);
/**
 * RK9-678: `pass` and `pw` end words such as `first-pass`, so in a plain
 * list position a lower-case `pass` value is a word, not a credential name
 * ("not the bare word"). In an assignment they count (ASSIGN_NAME_WORDS):
 * a pair object name, the name before a `=`/`:` item, a value that ends in
 * `=`/`:` (`"pass="`, `"PW:"`) and any value without lower-case letters
 * (`DB_PASS`, `"DB PW"`).
 */
const VALUE_NAME_WORDS = new Set([...ASSIGN_NAME_WORDS].filter((word) => word !== "pass" && word !== "pw"));
/** The words that VALUE_NAME_WORDS leaves out. */
const PASS_WORDS = new Set(["pass", "pw"]);
/** Words that end a credential name together with a final `key`. */
const VALUE_KEY_PREFIXES = new Set(["api", "secret", "access", "private"]);
/** Upper-case environment variable names: `GITHUB_TOKEN_RW`, `PASSWORD1`. */
const ENV_NAME_RX = /^[A-Z][A-Z0-9_]*$/;
/** Command-line flags: `--token-value`, `--db-password=`, `-password`. */
const FLAG_NAME_RX = /^--?[A-Za-z0-9][A-Za-z0-9_-]*[=:]?$/;
/** A label of up to three upper-case words: `DB PASSWORD`, `API KEY`. */
const UPPER_LABEL_RX = /^[A-Z0-9_-]+( [A-Z0-9_-]+){0,2}:?$/;

/** A bare lower-case word (`"secret"`, `"tokens"`): a tag or a label, not a variable name. */
function isBareWord(text: string): boolean {
  return /^[a-z]+$/.test(text);
}

/**
 * The mode of a string VALUE that names a credential (`"PASSWORD"`,
 * `"DB_PASSWORD"`, `"--db-password"`, `"Password:"`, `"SECRET_KEY"`), or
 * `none`. Stricter than the key rule, because values are often free text.
 * The value must be one word without whitespace or `/` (or an upper-case
 * label of up to three words, `"DB PASSWORD"`), and either:
 * - it is an upper-case environment variable name or a command-line flag and
 *   the key rule accepts it (RK9-665 M2: `GITHUB_TOKEN_RW`, `API_KEY_PROD`,
 *   `PASSWORD1`, `VAULT_SECRET_ID`, `--token-value`; `TOKEN_ID` in the `id`
 *   mode; not `--token-file` or `--password-stdin`, whose value is not
 *   inline); or
 * - a credential word ends it (trailing punctuation allowed), or
 *   `api`/`secret`/`access`/`private` + `key` ends it. A bare lower-case
 *   word (`"secret"`, `"tokens"`) is in the `word` mode.
 * So lower-case free text such as `"rk9-642-secret-check"`,
 * `"src/token-refresh.ts"`, `"token.ts"` and `"Fix password reset flow"` is
 * not a credential name.
 */
function valueNameMode(value: unknown, assign = false): SecretMode {
  if (typeof value !== "string") return "none";
  // RK9-687 (d): a padded separator at the end counts like a glued one
  // (`"password ="`, `"pass ＝"` -> `password=`, `pass=`).
  const text = rk9CoordMatchText(value).replace(/\s+([=:])$/, "$1");
  const nameWords = assign || /[=:]$/.test(text) || !/[a-z]/.test(text) ? ASSIGN_NAME_WORDS : VALUE_NAME_WORDS;
  if (text.length === 0 || text.length > 100 || text.includes("/")) return "none";
  if (/\s/.test(text) && !UPPER_LABEL_RX.test(text)) return "none";
  const segmentations = nameSegmentations(text);
  const isFlag = FLAG_NAME_RX.test(text);
  if (isFlag && segmentations[0]!.at(-1) === "stdin") return "none";
  if (ENV_NAME_RX.test(text) || isFlag) {
    const mode = keyMode(text);
    if (mode !== "none") return mode;
  }
  const named = segmentations.some((segments) => {
    const last = segments.at(-1);
    const prev = segments.at(-2);
    if (last === undefined) return false;
    if (nameWords.has(last)) return true;
    return last === "key" && prev !== undefined && VALUE_KEY_PREFIXES.has(prev);
  });
  if (!named) return nameWords === VALUE_NAME_WORDS ? passNameMode(text, segmentations) : "none";
  return isBareWord(text) ? "word" : "strong";
}

/**
 * RK9-687 (a), operator decision: a lower-case `pass`/`pw` value ending a
 * name of two or more words names a credential. With `_` or a camelCase
 * boundary it is a variable name (`db_pass`, `dbPass`, `DB_Pass`, `db_pw`:
 * `strong`). With only `-` it may be a tag (`first-pass`), so it gets the
 * `word` mode: a known-vocabulary value after it passes, a secret does not
 * (`["mysql-pass", "<secret>"]` is 422). The bare word stays a word.
 */
function passNameMode(text: string, segmentations: string[][]): SecretMode {
  const endsInPass = segmentations.some((segments) => segments.length > 1 && PASS_WORDS.has(segments.at(-1)!));
  if (!endsInPass) return "none";
  if (/_|[a-z0-9][A-Z]/.test(text)) return "strong";
  return text.includes("-") ? "word" : "none";
}

/**
 * True when a string in the given mode looks like a secret. The exemptions
 * test the raw value (RK9-665 verifier round 1): a tag character or a
 * combining mark inside it voids them.
 */
function isSecretValue(mode: SecretMode, value: string): boolean {
  if (mode === "none" || !SECRET_VALUE_RX.test(value)) return false;
  if (mode === "id") return !ID_VALUE_RX.test(value);
  if (mode === "keyid") return !KEY_ID_VALUE_RX.test(value);
  if (mode === "word") return !isKnownVocabulary(value);
  return true;
}

/** The mode for an object or array: the `id`, `keyid` and `word` exemptions cover a string only. */
function structuredMode(mode: SecretMode): SecretMode {
  return mode === "id" || mode === "keyid" || mode === "word" ? "strong" : mode;
}

/** A plural credential word (`tokens`, `secrets`): a label, not one credential's name. */
function isPluralWord(text: string): boolean {
  return isBareWord(text) && CREDENTIAL_WORDS.has(text) && text.endsWith("s");
}

/**
 * The array items that hold a credential value, with their mode: the item
 * after a credential name (`[name, value]`, and in a longer list too:
 * `["PASSWORD", "<secret>", "x"]`, RK9-678), the item after a credential
 * flag (`--password`; `-p` is not covered) and the item after a `=`/`:`
 * separator item that follows a credential name. `flag` lists the items
 * after a strong credential flag that are not flags themselves: they are
 * secrets at any length (`["--secret", "foo"]`, RK9-665).
 */
function credentialValueIndexes(items: unknown[]): { modes: Map<number, SecretMode>; flag: Set<number> } {
  const modes = new Map<number, SecretMode>();
  const flag = new Set<number>();
  const mark = (index: number, mode: SecretMode) => modes.set(index, combineModes(modes.get(index) ?? "none", mode));
  items.forEach((item, index) => {
    const following = items[index + 1];
    const assignment = isArgSeparator(following);
    const mode = valueNameMode(item, assignment);
    if (mode === "none" || typeof item !== "string") return;
    // `name = value` is an assignment, never a tag list: no `word` exemption.
    if (assignment) mark(index + 2, structuredMode(mode));
    else if (item.startsWith("-")) {
      mark(index + 1, mode);
      if (mode === "strong" && typeof following === "string" && !following.startsWith("-")) flag.add(index + 1);
    } else if (index + 1 < items.length) mark(index + 1, mode);
  });
  return { modes, flag };
}

/**
 * A count written as a string: up to 20 digits (`123456`), digits grouped
 * by three (`1,234`, `1 234 567`, up to seven groups), or a short number
 * with a unit (`200k`, `1.5M`). `1234567k` is not a count.
 */
const COUNT_STRING_RX = /^(?:\d{1,20}|\d{1,3}(?:[, ]\d{3}){1,6}|\d{1,4}(?:\.\d{1,2})? ?[kmb])$/i;
/**
 * Name segments that may stand beside `tokens` in a token-count key
 * (`input_tokens`, `cache_read_tokens`, `max_tokens`). `access_tokens` and
 * `recovery_tokens` are not count keys.
 */
const TOKEN_COUNT_WORDS = new Set([
  "tokens", "input", "output", "cache", "cached", "total", "prompt", "completion",
  "context", "reasoning", "used", "remaining", "estimated", "num", "max",
]);
/**
 * Segments allowed only right after `cache` (`cache_read_tokens`,
 * `cache_creation_input_tokens`): a bare `write_tokens` can be a credential.
 */
const CACHE_COUNT_WORDS = new Set(["read", "write", "creation"]);

/**
 * A key that holds token counters: `token`, `tokens` or a token-count key
 * (`input_tokens`). `access_tokens` is a credential, not a counter key.
 */
function isTokenKey(key: string): boolean {
  return /^tokens?$/i.test(rk9CoordMatchText(key)) || isTokenCountKey(key);
}

/** A token-count key: `tokens` plus only TOKEN_COUNT_WORDS segments. */
function isTokenCountKey(key: string): boolean {
  const words = credentialWordsOf(key);
  if (words.length === 0 || !words.every((word) => word.word === "tokens" && !word.id)) return false;
  return nameSegmentations(key).some((segments) =>
    segments.every(
      (segment, index) =>
        TOKEN_COUNT_WORDS.has(segment) || (CACHE_COUNT_WORDS.has(segment) && segments[index - 1] === "cache"),
    ),
  );
}

/**
 * True when a key opens a credential context for masking: the segment rule,
 * or the text pattern that walk() applies to `key: value` (it also finds a
 * glued `rootpassword` or `authtoken`; verifier round 3).
 */
function isCredentialContextKey(key: string): boolean {
  if (keyMode(key) !== "none" || rk9CoordTextHasSecret(`${key}: xxxxxxxx`)) return true;
  return nameSegmentations(key).some((segments) => segments.some((segment) => MASK_CONTEXT_WORDS.has(segment)));
}

/**
 * Credential-like words that are not in the key rule (the shared keyword
 * set is a separate decision) but still stop the token-count masking below
 * them: `{"credential": {"tokens": "83920144"}}`, `{"pwd": ...}`.
 */
const MASK_CONTEXT_WORDS = new Set([
  "credential", "credentials", "cred", "creds", "pwd", "pw", "pass", "passcode", "pin", "auth", "otp", "mfa",
]);

/** The mode a name/value pair object gives its value entries. */
function pairModeOf(entries: [string, unknown][]): SecretMode {
  return entries.reduce<SecretMode>((acc, [key, item]) => {
    if (!PAIR_NAME_KEY_RX.test(rk9CoordMatchText(key))) return acc;
    const named = valueNameMode(item, true);
    // A singular bare name in a pair object names one credential
    // (`{"name": "password", "value": ...}`): no `word` exemption.
    return combineModes(acc, named === "word" && !isPluralWord(rk9CoordMatchText(item as string)) ? "strong" : named);
  }, "none");
}

/**
 * A copy of the metadata in which a count string that is the direct value
 * of a token-count key is a number (RK9-665 L2): `{"tokens": "123456"}`,
 * `{"usage": {"input_tokens": "1234567"}}`. Nothing is masked inside a
 * credential context (verifier rounds 1-3): below a credential-named key
 * (segment rule or text pattern), in an object that holds a credential name
 * given as a value, in the array position after one, or inside an object
 * or array below a token key. So `{"tokens": {"name": "token",
 * "value": "83920144"}}`, `{"password": {"tokens": "83920144"}}` and
 * `{"token": "123456789"}` stay strings. The count pattern tests the raw
 * value.
 */
function maskTokenCounts(value: unknown, credential: boolean, depth: number): unknown {
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const { modes, flag } = credentialValueIndexes(value);
    // A credential-looking string anywhere in the array (`["dbpassword",
    // {...}]`, `["rootpassword", "=", {...}]`) makes every item a credential
    // context.
    const named = value.some((item) => typeof item === "string" && isCredentialContextKey(item));
    return value.map((item, index) =>
      maskTokenCounts(
        item,
        credential || named || (modes.get(index) ?? "none") !== "none" || flag.has(index),
        depth - 1,
      ),
    );
  }
  const entries = Object.entries(value);
  // A credential name in a pair object makes the whole object a credential
  // context: `{"name": "DB_PASSWORD", "tokens": "..."}` (verifier round 3).
  const pairCredential = pairModeOf(entries) !== "none";
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const childCredential = credential || pairCredential || isCredentialContextKey(key);
    out[key] =
      !credential && !pairCredential && isTokenCountKey(key) && typeof item === "string" && COUNT_STRING_RX.test(item)
        ? 0
        : maskTokenCounts(item, childCredential, depth - 1);
  }
  return out;
}

/**
 * Metadata is flagged when any view matches (verifier rounds 2-5):
 * - the JSON text catches key/value pairs such as {"password": "..."};
 * - each key and string value alone, raw and collapsed, catches whitespace
 *   that JSON escapes into `\t` or `\n`;
 * - every string leaf under a credential-named key at ANY depth, so arrays
 *   and nested objects ({"password": ["..."]}, {"secrets": {"db": "..."}})
 *   do not hide the value from the key;
 * - a credential name given as a value: the value entry of a name/value
 *   pair object ({"name": "PASSWORD", "value": "..."}), the second item of a
 *   two-item array (["DB_PASSWORD", "..."]) and the item after a credential
 *   flag or `=` item (["--password", "..."]) count as under a credential key;
 * - under a credential key, every key is a leaf too ({"password":
 *   {"<secret>": true}}, {"password": {"<secret>": 1}}, RK9-678: a number
 *   or a non-empty branch no longer hides the key). The one exemption is a
 *   counter key (isRk9CoordCounterKey) whose nearest credential ancestor is
 *   a `token`/`tokens` key: {"tokens": {"cache_read": 12}};
 * - `key: value` per string leaf, with the full ancestor key path.
 *
 * Numbers are never secrets (RK9-642): `{"max_tokens": 200000}` and
 * `{"tokens": {"input": 1234}}` are token counts, not credentials. A numeric
 * password sent as a JSON number is therefore accepted; send it as a string
 * and it is rejected. A count string under a token key (`{"tokens":
 * "123456"}`) counts as a number (RK9-665 L2, maskTokenCounts).
 */
export function rk9CoordMetadataHasSecret(input: Record<string, unknown>): boolean {
  if (!everyRk9CoordString(input, (text) => !rk9CoordTextHasSecret(text))) return true;
  const metadata = maskTokenCounts(input, false, RK9_COORD_METADATA_MAX_DEPTH + 1) as Record<string, unknown>;
  const json = JSON.stringify(metadata, (_key, value: unknown) => (typeof value === "number" ? 0 : value));
  if (rk9CoordTextHasSecret(json)) return true;
  let found = false;
  // RK9-676: `key: value` was checked for every ancestor key with the full
  // value (15 levels x a 4 KB value: ~0.5 s per request). Only a key that
  // forms a secret prefix (`token: <value>`) can change the result of the
  // joined text, so each key is probed once with a short stand-in value and
  // the value is checked only after those keys.
  const prefixKeys = new Map<string, boolean>();
  const isPrefixKey = (key: string) => {
    let hit = prefixKeys.get(key);
    if (hit === undefined) {
      hit = KEY_PROBE_VALUES.some((probe) => rk9CoordTextHasSecret(`${key}: ${probe}`));
      prefixKeys.set(key, hit);
    }
    return hit;
  };
  // `counters`: the nearest credential context is a `token`/`tokens` key, so
  // a counter key is no secret there (RK9-678).
  const walk = (value: unknown, path: string[], leafMode: SecretMode, depth: number, counters: boolean) => {
    if (found) return;
    if (value === null || typeof value !== "object") {
      if (typeof value !== "string") return;
      if (isSecretValue(leafMode, value)) {
        found = true;
        return;
      }
      for (const key of new Set(path)) {
        if (isPrefixKey(key) && rk9CoordTextHasSecret(`${key}: ${value}`)) {
          found = true;
          return;
        }
      }
      return;
    }
    // The schema caps depth; a deeper value here is treated as suspect.
    if (depth <= 0) {
      found = true;
      return;
    }
    const mode = structuredMode(leafMode);
    if (Array.isArray(value)) {
      // ["DB_PASSWORD", "<secret>"], [..., "--password", "<secret>"]: a credential name, then its value.
      const { modes, flag } = credentialValueIndexes(value);
      value.forEach((item, index) => {
        if (flag.has(index) && typeof item === "string" && rk9CoordMatchText(item).length > 0) found = true;
        const named = (modes.get(index) ?? "none") !== "none";
        walk(item, path, combineModes(mode, modes.get(index) ?? "none"), depth - 1, counters && !named);
      });
      return;
    }
    const entries = Object.entries(value);
    const pairMode = pairModeOf(entries);
    for (const [key, item] of entries) {
      // A key under a credential key may itself be the secret, whatever it
      // labels (RK9-678: `{"password": {"<secret>": 1}}`). Only a counter
      // key below a token key passes (`{"tokens": {"output": null}}`,
      // RK9-676 counter flags; `{"tokens": {"input": 12}}`).
      // RK9-684 item 5: a counter flag (true, false or null) passes under
      // every credential name (`{"passphrase": {"cached": true}}`); a count
      // only below a token key.
      const flag = item === null || typeof item === "boolean";
      if (!((counters || flag) && isRk9CoordCounterKey(key)) && isSecretValue(mode, key)) {
        found = true;
        return;
      }
      const ownMode = keyMode(key);
      let child = combineModes(mode, ownMode);
      // A token key below another credential key does not turn the
      // exemption back on (`{"DB_PASS": {"token": {...}}}`).
      let childCounters = ownMode === "none" ? counters : isTokenKey(key) && (mode === "none" || counters);
      if (PAIR_VALUE_KEY_RX.test(rk9CoordMatchText(key)) && pairMode !== "none") {
        child = combineModes(child, pairMode);
        childCounters = false;
      }
      walk(item, [...path, key], child, depth - 1, childCounters);
    }
  };
  walk(metadata, [], "none", RK9_COORD_METADATA_MAX_DEPTH + 1, false);
  return found;
}

function identityOf(req: Request, actor: Rk9CoordResolvedActor): Rk9CoordPresenceIdentity {
  const isAgent = actor.kind === "agent_run" && req.actor.type === "agent";
  return {
    companyId: req.params.companyId as string,
    kind: actor.kind,
    actorId: actor.actorId,
    host: actor.host,
    trust: actor.trust,
    agentId: isAgent ? (req.actor.agentId ?? null) : null,
    runId: isAgent ? (req.actor.runId ?? null) : null,
  };
}

export function rk9CoordActorRoutes(db: Db, opts: Rk9CoordActorRouteOptions = {}) {
  const router = Router({ mergeParams: true });
  const presence = rk9CoordPresenceService(db, opts);

  router.put("/me", validate422(upsertRk9CoordActorSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      const body = req.body as UpsertRk9CoordActor;
      const clientExternalId = checkAdvisory(actor, body);
      rejectSecrets({
        branch: body.branch,
        external_id: clientExternalId,
        metadata: body.metadata,
      });
      const identity = identityOf(req, actor);
      const publications: ActivityPublication[] = [];
      const result = await presence.upsert(
        identity,
        {
          name: body.name,
          issue: body.issue,
          repo: body.repo,
          branch: body.branch,
          phase: body.phase,
          pid: body.pid,
          livenessSource: body.liveness_source ?? body.livenessSource,
          metadata: body.metadata,
          clientExternalId,
        },
        (tx, rowId) => logRegistration(tx, req, actor, identity, rowId, publications),
      );
      for (const publication of publications) publishActivity(publication);
      res.status(result.inserted ? 201 : 200).json({
        id: result.id,
        actorId: actor.actorId,
        kind: actor.kind,
        host: actor.host,
        trust: actor.trust,
        created: result.inserted,
        ttlS: presence.ttlS(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/phase", validate422(updateRk9CoordActorPhaseSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      const body = req.body as UpdateRk9CoordActorPhase;
      checkAdvisory(actor, body);
      const row = await presence.setPhase(identityOf(req, actor), body.phase);
      if (!row) {
        throw coordError(404, "rk9_coord_actor_not_found", "Register with PUT actors/me before setting a phase");
      }
      res.json({ id: row.id, actorId: actor.actorId, phase: row.phase });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me", validate422(endRk9CoordActorSchema, "body"), async (req, res, next) => {
    try {
      const actor = requireActor(req);
      checkAdvisory(actor, req.body as AdvisoryIdentity);
      await presence.end({
        companyId: req.params.companyId as string,
        actorId: actor.actorId,
        trust: actor.trust,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/", validate422(listRk9CoordActorsQuerySchema, "query"), async (req, res, next) => {
    try {
      const query = (req as Request & { rk9CoordQuery?: ListRk9CoordActorsQuery }).rk9CoordQuery ?? {};
      const actors = await presence.list(req.params.companyId as string, query);
      res.json({ actors, ttlS: presence.ttlS() });
    } catch (err) {
      next(err);
    }
  });

  /** Runs inside the upsert transaction; publications go out after the commit. */
  async function logRegistration(
    tx: Db,
    req: Request,
    actor: Rk9CoordResolvedActor,
    identity: Rk9CoordPresenceIdentity,
    rowId: string,
    publications: ActivityPublication[],
  ) {
    const reqActor = req.actor;
    const who =
      reqActor.type === "agent"
        ? {
            actorType: "agent" as const,
            actorId: reqActor.agentId ?? actor.actorId,
            agentId: reqActor.agentId ?? null,
            runId: reqActor.runId ?? null,
            agentApiKeyId: reqActor.source === "agent_key" ? (reqActor.keyId ?? null) : null,
          }
        : reqActor.type === "board" && reqActor.userId
          ? { actorType: "user" as const, actorId: reqActor.userId }
          : // Coord tokens leave req.actor anonymous; the coord actor is the author.
            { actorType: "system" as const, actorId: actor.actorId };
    await logActivity(
      tx,
      {
        companyId: identity.companyId,
        ...who,
        action: "rk9.coord.actor_registered",
        entityType: "rk9_coord_actor",
        entityId: rowId,
        details: {
          actorRef: actor.actorId,
          kind: actor.kind,
          host: actor.host,
          trust: actor.trust,
          principal: actor.principal,
        },
      },
      publications,
    );
  }

  return router;
}
// --- /RK9 Custom ---
