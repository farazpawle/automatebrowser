/**
 * Structured tool errors (roadmap B6).
 *
 * Tools used to `throw new Error("some prose")`, so an agent recovering from a
 * failure had to string-match the message: any rewording silently broke its
 * recovery, and a failure it had never seen was indistinguishable from a
 * permanent one. Every failure an agent can act on now carries a **code**, a
 * **retryable** flag and, where one exists, the **tool to call next**.
 *
 * The prose is deliberately unchanged — this adds a machine-readable head to
 * messages that already read well, it does not reword them.
 */
import type { Tool, ToolResult } from "@/tools/tool";

/**
 * The closed set. A frozen literal union rather than a bare string, so a typo is
 * a compile error instead of a new undocumented code appearing on the wire.
 */
export const ERROR_CODES = [
  // Ownership and connectivity
  "TAB_CLAIMED",
  "TAB_GONE",
  "NO_BROWSER",
  "LEASE_LOST",
  // Element addressing and interaction (Stage 5 already emits STALE_REF prose)
  "STALE_REF",
  "NOT_ACTIONABLE",
  // Caller error — the arguments could not be understood at all, so nothing ran
  "BAD_ARGS",
  // The page did not load: Chrome committed its own error page instead (F1).
  // Not retryable — a host that refused once refuses again until a person acts.
  "NAVIGATION_FAILED",
  // Capability
  "RESTRICTED_PAGE",
  "ADVANCED_MODE_REQUIRED",
  // A private-browsing window was asked for and the extension is not allowed in
  // one. Only a PERSON can change that, which is why it carries no recovery tool.
  "INCOGNITO_BLOCKED",
  "CAPTURE_STALLED",
  // Chrome is not drawing the tab (minimised window, background tab), so real
  // input is discarded and a page load reports no LCP (F9). Not retryable: it
  // stays hidden until something brings it forward.
  "TAB_HIDDEN",
  // Safety policy (B9) — refusals the OPERATOR configured, not browser failures
  "ORIGIN_BLOCKED",
  "READ_ONLY",
  // The no-JavaScript switch (D16). Distinct from READ_ONLY on purpose: this
  // refusal fires on a READ too (`browser_eval {expression:"document.title"}`),
  // so folding it into READ_ONLY would tell an agent the exact wrong thing about
  // what else it may try.
  "EVAL_BLOCKED",
  // Browser-detected issue classes (C4's feed, per the B6 amendment)
  "CSP_BLOCKED",
  "DEPRECATED_API",
  "THIRD_PARTY_COOKIE_BLOCKED",
  "MIXED_CONTENT",
  "CORS_BLOCKED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Failures where the call demonstrably did NOT take effect, matched by message
 * because they originate outside our own throw sites (the link, the worker,
 * Chrome itself).
 *
 * This is the ONE definition of "transient": `retryable` on a `ToolError` is
 * derived from it, and `callTool`'s auto-retry reads `retryable`. Two lists
 * would drift, and the drift would be invisible until a retry either fired when
 * it should not have or failed to fire when it should.
 *
 * A TIMEOUT is deliberately absent: a call that timed out may well have
 * executed, so retrying it is a second click, not a recovery.
 */
export const TRANSIENT_FAILURES = [
  "lost the connection to the automatebrowser relay",
  "relay connection closed",
  "extension context invalidated",
  "receiving end does not exist",
  "the message port closed before a response was received",
  "frame with given id not found",
  "no frame with id",
  "frame was removed",
  "document was detached",
] as const;

export function isTransientMessage(message: string): boolean {
  const m = message.toLowerCase();
  return TRANSIENT_FAILURES.some((t) => m.includes(t));
}

/**
 * The subset of `TRANSIENT_FAILURES` where the REQUEST was already on the wire
 * and it is the REPLY that went missing — the relay link dropping while a call
 * was in flight. Every other entry above is the extension refusing to start
 * (no receiver, no frame, detached document), where nothing ran.
 *
 * Kept as its own list because it answers a different question: `retryable` asks
 * "is re-issuing safe?", this asks "do we know whether it already happened?".
 * They coincide for a read and diverge for a click. `tests/tool-outcomes.test.ts`
 * asserts this stays a subset, so the two cannot drift apart.
 */
export const LOST_RESPONSE = [
  "lost the connection to the automatebrowser relay",
  "relay connection closed",
] as const;

/** True when the call was dispatched and its answer never came back. */
export function isLostResponse(message: string): boolean {
  const m = message.toLowerCase();
  return LOST_RESPONSE.some((t) => m.includes(t));
}

/**
 * Codes that mean the server declined before asking the browser for anything.
 * Every throw site for these is upstream of its own first `sendSocketMessage`.
 */
const REFUSAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "BAD_ARGS",
  "ORIGIN_BLOCKED",
  "READ_ONLY",
  "EVAL_BLOCKED",
  "ADVANCED_MODE_REQUIRED",
]);

/** True when the failure is a refusal — nothing was sent, so nothing happened. */
export function isRefusal(e: unknown): boolean {
  const code = asToolError(e)?.code;
  return code !== undefined && REFUSAL_CODES.has(code);
}

/**
 * Codes that are safe to re-issue exactly as they were sent.
 *
 * `TRANSIENT_FAILURES` above matches on prose because those failures originate
 * outside our throw sites. These come from our OWN code carrying its own name,
 * so they are recognised by code and never by wording.
 *
 * `CAPTURE_STALLED` is the exception the TIMEOUT rule above was written to
 * exclude, and it is worth being explicit about why it is not a contradiction.
 * Timeouts are not retryable in general because a click that timed out may have
 * landed, so re-issuing it clicks twice. A screenshot changes nothing on the
 * page, so there is no second click to worry about — and the stall it reports
 * (Chrome not drawing a backgrounded tab) is exactly the kind that clears on
 * its own.
 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["CAPTURE_STALLED"]);

export interface ToolErrorInit {
  /** Whether re-issuing the identical call could succeed. See TRANSIENT_FAILURES. */
  retryable?: boolean;
  /** The tool an agent should call to get itself unstuck. */
  recover?: string;
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly recover?: string;

  constructor(code: ErrorCode, message: string, init: ToolErrorInit = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.recover = init.recover;
  }
}

/**
 * The tool that gets an agent unstuck, per code. Only codes with a genuine next
 * action appear — inventing one for the rest would send the agent somewhere
 * useless, which is worse than saying nothing.
 */
const RECOVER: Partial<Record<ErrorCode, string>> = {
  STALE_REF: "browser_snapshot",
  TAB_CLAIMED: "browser_force_claim",
  TAB_GONE: "browser_list_tabs",
  ADVANCED_MODE_REQUIRED: "browser_advanced_mode",
  LEASE_LOST: "browser_select_tab",
  TAB_HIDDEN: "browser_switch_tab",
  // An origin refusal is not recoverable in place — but browser_status prints
  // the policy that refused it, which is the only useful next move.
  ORIGIN_BLOCKED: "browser_status",
  READ_ONLY: "browser_status",
  EVAL_BLOCKED: "browser_status",
};

/**
 * Failures raised inside the EXTENSION arrive here as a plain `Error` — the wire
 * carries a message, not a class. Rather than have the server re-recognise them
 * by prose (the exact fragility B6 exists to remove), the extension prefixes its
 * own message with the code and this adopts it.
 */
const CODE_PREFIX = new RegExp(`^(${ERROR_CODES.join("|")}):\\s*`);

/**
 * Classify any thrown value. An error that never went through a mapped throw
 * site still gets its `retryable` right, which is what the auto-retry depends on.
 */
export function asToolError(e: unknown): ToolError | undefined {
  if (e instanceof ToolError) return e;
  const message = String((e as Error)?.message ?? e ?? "");
  if (!message) return undefined;

  const prefixed = CODE_PREFIX.exec(message);
  if (prefixed) {
    const code = prefixed[1] as ErrorCode;
    // Strip the prefix: `renderError` puts it back, and keeping both would
    // render `STALE_REF: STALE_REF: …`.
    return new ToolError(code, message.slice(prefixed[0].length), {
      recover: RECOVER[code],
      retryable: RETRYABLE_CODES.has(code),
    });
  }

  // An unmapped failure has no code to give, but it can still be recognised as
  // transient — that is the bit the retry needs and the bit that must not drift.
  if (isTransientMessage(message)) {
    return new ToolError("NO_BROWSER", message, { retryable: true });
  }
  return undefined;
}

/** True when re-issuing the identical call could succeed. */
export function isRetryable(e: unknown): boolean {
  return asToolError(e)?.retryable === true;
}

/**
 * The text an agent reads. A code prefix and a recovery line, then the original
 * prose unchanged — an agent that ignores the structure entirely still ends up
 * better off than with a bare sentence.
 */
export function renderError(e: unknown): string {
  const te = asToolError(e);
  if (!te) return String(e);
  const recover = te.recover ? `\nRecover: call ${te.recover}.` : "";
  return `${te.code}: ${te.message}${recover}`;
}

/**
 * The taxonomy code for one of `browser_issues`' kinds, when there is one.
 *
 * C4 feeds B6 (the roadmap's own amendment): an issue IS the machine-readable
 * reason a call silently did nothing, so the two must name the same failure the
 * same way. Kinds with no code — `intervention`, `crash`, an arbitrary `http-503`
 * — keep their own label rather than being forced into an approximate one.
 */
export function issueCode(kind: string): ErrorCode | undefined {
  const k = kind.toLowerCase();
  if (k === "csp-violation") return "CSP_BLOCKED";
  if (k === "deprecation") return "DEPRECATED_API";
  if (k === "mixed-content") return "MIXED_CONTENT";
  if (k === "cors" || k === "cors-violation") return "CORS_BLOCKED";
  if (k === "third-party-cookie" || k === "cookie-blocked") return "THIRD_PARTY_COOKIE_BLOCKED";
  return undefined;
}

/** The machine-readable half, attached to the error result's structuredContent. */
export function errorContent(e: unknown): Record<string, unknown> | undefined {
  const te = asToolError(e);
  if (!te) return undefined;
  return {
    code: te.code,
    message: te.message,
    retryable: te.retryable,
    ...(te.recover ? { recover: te.recover } : {}),
  };
}

/**
 * The MCP result for a failure: the rendered text always, and B6's machine-
 * readable head only when it can survive the trip.
 *
 * The client validates ANY `structuredContent` against the tool's declared
 * `outputSchema` — failure results included — and `zodToJsonSchema` emits
 * `additionalProperties: false`. So on the nine tools that declare one, sending
 * the error head there replaced a readable failure with "structured content does
 * not match the tool's output schema", and the real reason never reached the
 * agent. Withheld for those; the text carries the same code and recovery line
 * either way (I04).
 */
export function errorResult(tool: Tool, e: unknown): ToolResult {
  const structured = tool.schema.outputSchema ? undefined : errorContent(e);
  return {
    content: [{ type: "text", text: renderError(e) }],
    ...(structured ? { structuredContent: structured } : {}),
    isError: true,
  };
}
