/**
 * D15's header redaction. Every assertion here is a security property: a wrong
 * answer puts a live credential into an agent transcript, which is not a thing
 * that can be taken back.
 *
 * `redactHeaders` is a pure function over a plain object, so none of this needs
 * a browser, a relay or CDP.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";
import { getNetworkRequest } from "@/tools/advanced";
import { REDACTED, SENSITIVE_HEADERS, isSensitiveHeader, redactHeaders } from "@/utils/redact";

describe("isSensitiveHeader", () => {
  it("matches the exact list regardless of case", () => {
    for (const name of SENSITIVE_HEADERS) {
      assert.equal(isSensitiveHeader(name), true, name);
      assert.equal(isSensitiveHeader(name.toUpperCase()), true, name.toUpperCase());
      // HTTP header names are case-insensitive, and Chrome hands them back in
      // whatever case the server sent. Title case is the common wire spelling.
      const title = name.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase());
      assert.equal(isSensitiveHeader(title), true, title);
    }
  });

  it("catches vendor names we never enumerated, by substring", () => {
    for (const name of [
      "x-api-key",
      "X-API-Key",
      "apikey",
      "x-shopify-access-token",
      "x-amz-security-token",
      "x-csrf-token",
      "client-secret",
      "x-user-password",
      "x-aws-credential",
    ]) {
      assert.equal(isSensitiveHeader(name), true, name);
    }
  });

  it("leaves ordinary diagnostic headers alone", () => {
    for (const name of [
      "content-type",
      "content-length",
      "cache-control",
      "access-control-allow-origin",
      "date",
      "server",
      "etag",
      "user-agent",
      "referer",
    ]) {
      assert.equal(isSensitiveHeader(name), false, name);
    }
  });

  it("tolerates the whitespace a header name should never have but sometimes does", () => {
    assert.equal(isSensitiveHeader("  Authorization  "), true);
  });
});

describe("redactHeaders", () => {
  const headers = {
    Authorization: "Bearer eyJhbGciOi.SECRET.value",
    "Set-Cookie": "session=abc123; HttpOnly",
    "X-Api-Key": "sk-live-999",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  it("hides the values and counts what it hid", () => {
    const out = redactHeaders(headers, false);
    assert.equal(out.redacted, 3);
    assert.equal(out.headers.Authorization, REDACTED);
    assert.equal(out.headers["Set-Cookie"], REDACTED);
    assert.equal(out.headers["X-Api-Key"], REDACTED);
    assert.equal(out.headers["Content-Type"], "application/json");
    assert.equal(out.headers["Cache-Control"], "no-store");
  });

  it("never lets a secret survive anywhere in the rendered result", () => {
    const rendered = JSON.stringify(redactHeaders(headers, false));
    for (const secret of ["eyJhbGciOi", "SECRET", "abc123", "sk-live-999"]) {
      assert.equal(rendered.includes(secret), false, `leaked ${secret}`);
    }
  });

  it("keeps the NAMES, because knowing a request carried auth is the diagnosis", () => {
    const out = redactHeaders(headers, false);
    assert.deepEqual(Object.keys(out.headers), Object.keys(headers));
  });

  it("returns everything untouched when the caller opts in", () => {
    const out = redactHeaders(headers, true);
    assert.equal(out.redacted, 0);
    assert.deepEqual(out.headers, headers);
  });

  it("treats a missing header map as empty rather than throwing", () => {
    assert.deepEqual(redactHeaders(undefined, false), { headers: {}, redacted: 0 });
    assert.deepEqual(redactHeaders(undefined, true), { headers: {}, redacted: 0 });
  });

  it("reports 0 when nothing matched, which is not the same as nothing present", () => {
    const out = redactHeaders({ "Content-Type": "text/html" }, false);
    assert.equal(out.redacted, 0);
    assert.equal(Object.keys(out.headers).length, 1);
  });
});

/**
 * The render, not just the rule. The unit tests above prove `redactHeaders`
 * withholds the right values; these prove `browser_get_network_request` actually
 * CALLS it — the mistake that would leak everything while every test above stays
 * green is rendering `r.responseHeaders` instead of the redacted copy.
 *
 * The context is faked, so this needs no browser, no relay and no CDP.
 */
describe("browser_get_network_request renders redacted headers", () => {
  const captured = {
    url: "https://api.example.com/me",
    method: "GET",
    status: 200,
    mimeType: "application/json",
    body: '{"ok":true}',
    truncated: false,
    requestId: "42.7",
    requestHeaders: { Authorization: "Bearer LEAKED-TOKEN", Accept: "application/json" },
    responseHeaders: { "Set-Cookie": "sid=LEAKED-SID", "Content-Type": "application/json" },
  };
  const context = { sendSocketMessage: async () => captured } as unknown as Context;
  const render = async (params?: Record<string, unknown>): Promise<string> =>
    (await getNetworkRequest.handle(context, params)).content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");

  it("withholds both secrets by default and says how many", async () => {
    const text = await render();
    assert.equal(text.includes("LEAKED-TOKEN"), false);
    assert.equal(text.includes("LEAKED-SID"), false);
    assert.match(text, /Authorization: <redacted>/);
    assert.match(text, /Set-Cookie: <redacted>/);
    assert.match(text, /2 header value\(s\) redacted/);
  });

  it("still shows the harmless headers and the body", async () => {
    const text = await render();
    assert.match(text, /Accept: application\/json/);
    assert.match(text, /Content-Type: application\/json/);
    assert.match(text, /\{"ok":true\}/);
  });

  it("returns the real values, and no redaction note, when asked", async () => {
    const text = await render({ revealValues: true });
    assert.match(text, /Authorization: Bearer LEAKED-TOKEN/);
    assert.match(text, /Set-Cookie: sid=LEAKED-SID/);
    assert.equal(text.includes("redacted"), false);
  });

  it("renders nothing at all for an older extension that sends no headers", async () => {
    const bare = { ...captured, requestHeaders: undefined, responseHeaders: undefined };
    const older = { sendSocketMessage: async () => bare } as unknown as Context;
    const text = (await getNetworkRequest.handle(older)).content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    assert.equal(text.includes("request headers"), false);
    assert.equal(text.includes("response headers"), false);
    assert.match(text, /\{"ok":true\}/);
  });
});
