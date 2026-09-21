/**
 * The typed-error layer (B6). Two properties matter more than the rest:
 *
 *  - `retryable` decides whether callTool silently re-issues a call. Get it
 *    wrong in one direction and a click happens twice; wrong in the other and a
 *    recoverable blip surfaces as a failure.
 *  - The extension prefixes its own messages with the code, and the server
 *    adopts it. That handshake is a string contract between two builds that ship
 *    separately, which is exactly the kind that rots unnoticed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ERROR_CODES,
  TRANSIENT_FAILURES,
  ToolError,
  asToolError,
  errorContent,
  isRetryable,
  isTransientMessage,
  issueCode,
  renderError,
} from "@/tools/errors";

describe("issueCode — C4's issue kinds map onto B6's codes", () => {
  it("maps every kind that has a code", () => {
    assert.equal(issueCode("csp-violation"), "CSP_BLOCKED");
    assert.equal(issueCode("deprecation"), "DEPRECATED_API");
    assert.equal(issueCode("mixed-content"), "MIXED_CONTENT");
    assert.equal(issueCode("cors"), "CORS_BLOCKED");
    assert.equal(issueCode("cors-violation"), "CORS_BLOCKED");
    assert.equal(issueCode("third-party-cookie"), "THIRD_PARTY_COOKIE_BLOCKED");
    assert.equal(issueCode("cookie-blocked"), "THIRD_PARTY_COOKIE_BLOCKED");
  });

  it("is case-insensitive", () => {
    assert.equal(issueCode("CSP-Violation"), "CSP_BLOCKED");
  });

  it("returns undefined rather than forcing an approximate code", () => {
    for (const kind of ["intervention", "crash", "http-503", ""]) {
      assert.equal(issueCode(kind), undefined, kind);
    }
  });

  it("only ever returns a code from the closed set", () => {
    const codes = new Set<string>(ERROR_CODES);
    for (const kind of [
      "csp-violation",
      "deprecation",
      "mixed-content",
      "cors",
      "third-party-cookie",
    ]) {
      assert.ok(codes.has(issueCode(kind) as string), kind);
    }
  });
});

describe("isTransientMessage", () => {
  it("recognises every documented transient failure, whatever the surrounding prose", () => {
    for (const t of TRANSIENT_FAILURES) {
      assert.equal(isTransientMessage(`Error: ${t} while doing the thing`), true, t);
      assert.equal(isTransientMessage(t.toUpperCase()), true, t);
    }
  });

  it("does NOT treat a timeout as transient — a call that timed out may have landed", () => {
    assert.equal(isTransientMessage("Socket message timeout"), false);
    assert.equal(isTransientMessage("Timed out after 30000ms"), false);
  });

  it("does not fire on unrelated prose", () => {
    assert.equal(isTransientMessage("element not found"), false);
  });
});

describe("asToolError — adopting the extension's code prefix", () => {
  it("adopts every code in the closed set", () => {
    for (const code of ERROR_CODES) {
      const te = asToolError(new Error(`${code}: something went wrong`));
      assert.equal(te?.code, code, code);
    }
  });

  it("strips the prefix so renderError does not print it twice", () => {
    const te = asToolError(new Error("STALE_REF: ref e7 is no longer on the page"));
    assert.equal(te?.message, "ref e7 is no longer on the page");
    assert.equal(renderError(new Error("STALE_REF: gone")).startsWith("STALE_REF: gone"), true);
    assert.equal(renderError(new Error("STALE_REF: gone")).includes("STALE_REF: STALE_REF"), false);
  });

  it("attaches the recovery tool for codes that have a useful next move", () => {
    assert.equal(asToolError(new Error("STALE_REF: x"))?.recover, "browser_snapshot");
    assert.equal(asToolError(new Error("TAB_CLAIMED: x"))?.recover, "browser_force_claim");
    assert.equal(asToolError(new Error("ORIGIN_BLOCKED: x"))?.recover, "browser_status");
  });

  it("attaches no recovery tool where none would help", () => {
    assert.equal(asToolError(new Error("CSP_BLOCKED: x"))?.recover, undefined);
  });

  it("passes a ToolError through unchanged", () => {
    const original = new ToolError("TAB_GONE", "the tab closed");
    assert.equal(asToolError(original), original);
  });

  it("returns undefined for an unmapped, non-transient failure rather than inventing a code", () => {
    assert.equal(asToolError(new Error("something ordinary broke")), undefined);
    assert.equal(asToolError(undefined), undefined);
    assert.equal(asToolError(""), undefined);
  });

  it("does not adopt a code that merely appears mid-message", () => {
    assert.equal(asToolError(new Error("the page said STALE_REF: nope")), undefined);
  });
});

describe("isRetryable — the property callTool's auto-retry depends on", () => {
  it("is true for a transient link failure, which demonstrably did not take effect", () => {
    assert.equal(isRetryable(new Error("relay connection closed")), true);
  });

  it("is true for CAPTURE_STALLED, because a screenshot changes nothing on the page", () => {
    assert.equal(isRetryable(new Error("CAPTURE_STALLED: chrome did not draw the tab")), true);
  });

  it("is false for every other code — re-issuing them would repeat a real action", () => {
    for (const code of ERROR_CODES.filter((c) => c !== "CAPTURE_STALLED")) {
      assert.equal(isRetryable(new Error(`${code}: x`)), false, code);
    }
  });

  it("is false for a timeout", () => {
    assert.equal(isRetryable(new Error("Socket message timeout")), false);
  });
});

describe("errorContent — the machine-readable half", () => {
  it("carries the code for a classified failure", () => {
    const content = errorContent(new Error("TAB_CLAIMED: held by codex"));
    assert.equal(content?.code, "TAB_CLAIMED");
  });

  it("is undefined for an unclassified one, rather than an empty shell", () => {
    assert.equal(errorContent(new Error("plain failure")), undefined);
  });
});
