/**
 * Which callers may open a socket to the relay.
 *
 * This is a trust boundary and it had **no test at all** until 2026-09-21, the
 * day the check changed. It used to compare the Origin header against one pinned
 * `chrome-extension://` id — the id the manifest `key` forced. That key was
 * browsermcp.io's, inherited in the fork, and removing it meant the pinned
 * default would have refused the extension this server exists to drive. Nothing
 * would have caught that: the smoke harness is a Node client, and Node clients
 * send no Origin.
 *
 * So the cases below are written around the two things that must stay true
 * whatever the id is:
 *
 *  1. **A web page cannot drive your browser.** An `http(s)` Origin is refused.
 *     This is the whole point of the check and the only attack it closes.
 *  2. **The extension can connect without anyone knowing its id in advance** —
 *     random per profile when unpacked, different again once a store assigns it.
 *
 * And the third, stated so it is not mistaken for a hole later: a caller with NO
 * Origin is allowed unconditionally, because every controller is one.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isAllowedWsOrigin } from "@/ws";

const ENV = "AUTOMATE_BROWSER_EXTENSION_ORIGINS";

afterEach(() => {
  delete process.env[ENV];
});

describe("websocket origin — with no allow-list configured", () => {
  it("accepts an extension origin whose id nobody knew in advance", () => {
    assert.equal(isAllowedWsOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
    assert.equal(isAllowedWsOrigin("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"), true);
  });

  it("refuses a web page, which is the attack this check exists for", () => {
    assert.equal(isAllowedWsOrigin("https://evil.example"), false);
    assert.equal(isAllowedWsOrigin("http://localhost:3000"), false);
    assert.equal(isAllowedWsOrigin("file://"), false);
  });

  it("refuses an origin that merely CONTAINS the extension scheme", () => {
    // A prefix check, not a substring one: `startsWith`, so a hostile origin
    // cannot smuggle the scheme in later in the string.
    assert.equal(isAllowedWsOrigin("https://evil.example/chrome-extension://x"), false);
    assert.equal(isAllowedWsOrigin("https://chrome-extension.evil.example"), false);
  });

  it("allows a caller that sends no Origin, because every controller is one", () => {
    assert.equal(isAllowedWsOrigin(undefined), true);
    assert.equal(isAllowedWsOrigin(""), true);
  });
});

describe("websocket origin — with an explicit allow-list", () => {
  it("narrows to exactly what the operator listed", () => {
    process.env[ENV] = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.equal(isAllowedWsOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
    assert.equal(isAllowedWsOrigin("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
  });

  it("takes several, and ignores spacing around the commas", () => {
    process.env[ENV] = " chrome-extension://aaa ,chrome-extension://bbb , ";
    assert.equal(isAllowedWsOrigin("chrome-extension://aaa"), true);
    assert.equal(isAllowedWsOrigin("chrome-extension://bbb"), true);
    assert.equal(isAllowedWsOrigin("chrome-extension://ccc"), false);
  });

  it("still refuses a web page", () => {
    process.env[ENV] = "chrome-extension://aaa";
    assert.equal(isAllowedWsOrigin("https://evil.example"), false);
  });

  it("reads set-but-empty as unset rather than as 'allow nothing'", () => {
    // Deliberate: the variable exists to NARROW, and a stray value that severed
    // the extension outright would surface only as a 403 in an unread log.
    process.env[ENV] = "  ,  ";
    assert.equal(isAllowedWsOrigin("chrome-extension://anything"), true);
    assert.equal(isAllowedWsOrigin("https://evil.example"), false);
  });
});
