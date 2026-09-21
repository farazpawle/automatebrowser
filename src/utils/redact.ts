/**
 * The sensitive-header list, in ONE place (plan 09, D15).
 *
 * We already redact cookie values and web-storage values by default and require
 * an explicit `revealValues` to see them. HTTP headers were the hole in that
 * promise: a captured `Authorization` or `Set-Cookie` is the same secret by a
 * different name, and once it reaches a result it is in the agent's context, the
 * transcript and any log the client keeps — none of which can be un-written.
 *
 * Matching is CASE-INSENSITIVE because HTTP header names are. `Authorization`,
 * `authorization` and `AUTHORIZATION` are one header, and a list that only
 * catches the lower-case spelling protects nothing.
 */

/**
 * Exact names. Short deliberately: everything that can be caught by a substring
 * belongs in `SENSITIVE_PARTS` instead of being enumerated twice.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Substrings, for the names we cannot enumerate — every vendor invents its own
 * (`x-api-key`, `x-shopify-access-token`, `x-amz-security-token`, …).
 *
 * The asymmetry decides the width: redacting a harmless header costs one re-call
 * with `revealValues:true`, while missing a real one costs a live credential in
 * a transcript that is already written. So this errs wide — `token` will also
 * catch a pagination `x-continuation-token`, and that is the cheap failure.
 */
const SENSITIVE_PARTS = ["token", "api-key", "apikey", "secret", "password", "credential"];

/** True when this header's VALUE should be treated as a credential. */
export function isSensitiveHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return SENSITIVE_HEADERS.has(n) || SENSITIVE_PARTS.some((p) => n.includes(p));
}

/** What `<redacted>` reads as, matching `browser_get_cookies` rather than inventing a second spelling. */
export const REDACTED = "<redacted>";

export interface RedactedHeaders {
  /** Same keys, same order — only the sensitive VALUES are replaced. */
  headers: Record<string, string>;
  /** How many values were withheld. 0 means "none matched", never "none present". */
  redacted: number;
}

/**
 * Replace sensitive header values with `<redacted>`.
 *
 * Names are always kept. Knowing that a request carried an `Authorization`
 * header is most of the diagnostic value, and it is not the secret — so hiding
 * the name would cost the agent an answer while protecting nothing.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
  reveal: boolean,
): RedactedHeaders {
  const out: Record<string, string> = {};
  let redacted = 0;
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!reveal && isSensitiveHeader(name)) {
      out[name] = REDACTED;
      redacted++;
    } else {
      out[name] = value;
    }
  }
  return { headers: out, redacted };
}
