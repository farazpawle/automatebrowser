/**
 * The in-flight count behind `waitUntil: "networkidle"` (plan 14, F14).
 *
 * "networkidle" used to be a fixed 500 ms after the load. It now waits until
 * the tab has had no open request for 500 ms, so the count must not lie: a
 * redirect re-announces its request id, and the first announcement never gets
 * an end - counting it would hold every redirected page at the cap.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadNetwork } from "./helpers/fake-network";

describe("inFlight counts the tab's open requests", () => {
  it("counts a request until it ends, and only on its own tab, since the given time", async () => {
    const { net, on, request, dispose } = loadNetwork();
    try {
      request(7, "script", "https://a.test/done.js", 2_000, { status: 200 });
      request(7, "xhr", "https://a.test/old", 500, { status: 200 });
      for (const fn of on.before)
        fn({
          requestId: "open",
          tabId: 7,
          url: "https://a.test/slow",
          type: "xhr",
          timeStamp: 2_100,
        });
      for (const fn of on.before)
        fn({ requestId: "other", tabId: 8, url: "https://b.test/", type: "xhr", timeStamp: 2_100 });
      assert.equal(await net.inFlight(7, 1_000), 1);
      for (const fn of on.completed) fn({ requestId: "open", statusCode: 200, timeStamp: 2_400 });
      assert.equal(await net.inFlight(7, 1_000), 0);
    } finally {
      dispose();
    }
  });

  it("a redirected request counts once, and not at all once it ends", async () => {
    const { net, on, dispose } = loadNetwork();
    try {
      for (const url of ["http://a.test/", "https://a.test/"])
        for (const fn of on.before)
          fn({ requestId: "r", tabId: 7, url, type: "main_frame", timeStamp: 2_000 });
      assert.equal(await net.inFlight(7, 1_000), 1);
      for (const fn of on.completed) fn({ requestId: "r", statusCode: 200, timeStamp: 2_300 });
      assert.equal(await net.inFlight(7, 1_000), 0);
    } finally {
      dispose();
    }
  });
});
