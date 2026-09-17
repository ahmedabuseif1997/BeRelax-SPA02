/**
 * The field names this system treats as personal data. ONE list, two readers.
 *
 *   - `pickAuditFields` strips them from audit snapshots (§9.6) — the audit log
 *     records what changed about the money, not a second copy of the guest
 *     database.
 *   - The pino `redact` paths keep them out of log lines (§12.3).
 *
 * Kept as two lists they would drift, and the day they drift is the day a
 * guest's phone number is sitting in a log file nobody is watching, which is
 * precisely what §11.9 (data minimisation) and the privacy notice say does not
 * happen. Add a field here, not in one of the consumers.
 */
export const PII_FIELDS = [
  'fullName',
  'guestName',
  'phone',
  'guestPhone',
  'email',
  'guestEmail',
  'legalName',
  'notes',
  'passwordHash',
  'tokenHash',
] as const;

export type PiiField = (typeof PII_FIELDS)[number];

/** Membership test for `pickAuditFields`, which walks a row key by key. */
export const PII_FIELD_SET: ReadonlySet<string> = new Set<string>(PII_FIELDS);

/**
 * Secrets. Not personal data, but a token in a log file is a session somebody
 * else can resume, so logs treat them the same way. Separate from PII_FIELDS
 * because the audit log deliberately does NOT strip these names from its
 * snapshots — it never sees them in the first place.
 */
export const CREDENTIAL_FIELDS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordConfirm',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'secret',
  'apiKey',
  'idempotencyKey',
] as const;

/** What replaces a redacted value. Matches pino's own default wording. */
export const REDACTION_CENSOR = '[Redacted]';

/**
 * How deep the wildcard tiers go. `{ guest: { phone } }` is one level,
 * `{ reservation: { guest: { phone } } }` is two. Three tiers covers every
 * shape a service in this codebase actually hands a logger; deeper than that
 * and the object had no business being logged whole.
 */
const WILDCARD_TIERS = ['', '*.', '*.*.'] as const;

function bracket(field: string): string {
  // pino path syntax needs brackets around anything with a hyphen: `set-cookie`
  // read as a path would be "set" minus "cookie".
  return /^[A-Za-z_$][\w$]*$/.test(field) ? field : `["${field}"]`;
}

function tiered(field: string): string[] {
  const name = bracket(field);
  // `*.["set-cookie"]` is not a path; `*["set-cookie"]` is. Drop the dot when
  // the segment is already bracketed.
  return WILDCARD_TIERS.map((prefix) =>
    name.startsWith('[') ? `${prefix.slice(0, -1)}${name}` : `${prefix}${name}`,
  );
}

/**
 * The paths handed to pino's `redact`. Explicit, because a redaction you cannot
 * read is a redaction you cannot audit.
 *
 * The first line of defence is the `req` serialiser, which never emits headers,
 * a body or a query string at all. These paths are the second: they catch a
 * guest object that a service passes to `logger.info` by hand.
 */
export const REDACT_PATHS: readonly string[] = [
  ...new Set<string>([
    ...PII_FIELDS.flatMap(tiered),
    ...CREDENTIAL_FIELDS.flatMap(tiered),

    // Named outright as well as covered by the tiers above, because these are
    // the ones §12.3 calls out by name and a reader should be able to find them.
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',

    // Bodies are never a safe thing to log. A serialiser drops the request
    // body; this catches the copy that error objects from HTTP clients carry.
    'req.body',
    'res.body',
    'err.request.body',
    'error.request.body',
  ]),
];

const SCRUB_PATTERN = new RegExp(
  // an optionally quoted key, then `:` or `=`, then a quoted or bare value
  `(["'\`]?(?:${[...PII_FIELDS, ...CREDENTIAL_FIELDS].join('|')})["'\`]?\\s*[:=]\\s*)` +
    `(?:"[^"]*"|'[^']*'|\`[^\`]*\`|[^,;)}\\]\\s]+)`,
  'gi',
);

/**
 * Masks `field: value` pairs inside a STRING.
 *
 * Path-based redaction only reaches structured values. Some errors arrive with
 * personal data already flattened into prose — Prisma renders the offending
 * arguments into `PrismaClientValidationError.message`, which is how a guest's
 * phone number ends up inside a message that `PrismaErrorFilter` then logs.
 * Applied to error messages only; it is a regex, and regexes belong on the
 * error path, not on every line.
 */
export function scrubPiiFromText(text: string): string {
  SCRUB_PATTERN.lastIndex = 0;
  return text.replace(SCRUB_PATTERN, `$1${REDACTION_CENSOR}`);
}
