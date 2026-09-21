/**
 * A navigation that did not happen must not be reported as one that did.
 *
 * The bug this closes: `browser_navigate` answered `Navigated to <url>` whatever
 * the browser actually did. The extension has always reported the truth —
 * `navigated: false`, `settled: false`, and the url the tab is really on — but
 * that only ever reached `structuredContent`, and the snapshot branch throws
 * `structuredContent` away entirely. So the common case handed an agent the
 * PREVIOUS page's snapshot under a success message, with nothing to read as a
 * warning. B09's navigation regression sat behind exactly that sentence: the
 * tab stopped moving, every call still said it had moved, and the only check
 * that noticed blamed a certificate bypass instead.
 *
 * The rule under test: the question is whether the tab is WHERE THE CALL ASKED
 * it to go, confirmed against the browser before it is said out loud — not
 * whether the browser settled, which it will happily do on the document that was
 * already there. Stay quiet wherever an unchanged url is correct: a reload,
 * `waitUntil: "none"` (which asked not to wait and therefore cannot know), a
 * navigation to the page already open, and a redirect that lands elsewhere.
 *
 * The message is an observation over a named window ("after 2.0s the tab was
 * still on X"), never a verdict, because a verdict is not available: the browser
 * is still moving while this is read, and a page that lands just after the
 * window would make "did not navigate" false.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { navigate } from "@/tools/common";

// The confirmation window is a wall-clock wait, and every assertion here is
// about WORDING, not about how long the browser is given. At its 2 s default
// these twelve tests would add eight seconds to a gate that runs in nine.
process.env.AUTOMATE_BROWSER_NAV_CONFIRM_MS = "100";

/**
 * A Context that answers `browser_navigate` with one canned extension reply.
 *
 * `urlNow` is what the tab reports when the reply is checked against the
 * browser. It defaults to the url the tab started on — the tab really did not
 * move — and is set to somewhere else by the test for a navigation that was
 * merely slow to commit.
 */
function contextReturning(reply: Record<string, unknown>, urlNow?: string): Context {
  return {
    sendSocketMessage: async (type: string) => {
      if (type === "browser_navigate") return reply;
      if (type === "getUrl") return urlNow ?? reply.urlBefore;
      if (type === "browser_snapshot_full") {
        return { url: "http://a.test/one", title: "one", snapshot: "- heading" };
      }
      return {};
    },
  } as unknown as Context;
}

/** The text of a tool reply, however many blocks it came in. */
async function replyText(
  reply: Record<string, unknown>,
  params: Record<string, unknown>,
  snapshotDefault = false,
  urlNow?: string,
): Promise<string> {
  const result = await navigate(snapshotDefault).handle(contextReturning(reply, urlNow), params);
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** What the extension sends when the tab never left the page it was on. */
const MISSED = {
  ok: true,
  navigated: false,
  settled: false,
  urlBefore: "http://a.test/one",
  urlAfter: "http://a.test/one",
  elapsedMs: 1010,
};

describe("browser_navigate reports a navigation that did not happen", () => {
  it("says it did NOT navigate, rather than claiming it did", async () => {
    const text = await replyText(MISSED, {
      url: "https://b.test/two",
      includeSnapshot: false,
    });
    assert.match(text, /Did NOT reach https:\/\/b\.test\/two/);
    assert.doesNotMatch(text, /^Navigated to/m);
    // The window it actually watched for, so the sentence is checkable.
    assert.match(text, /after 0\.1s/);
  });

  it("still reports it when the browser claims the page SETTLED", async () => {
    // Measured on a real Chrome: a dropped navigation can settle on the document
    // that was already there, so `settled: true` says nothing about whether the
    // call went anywhere. Keying off it left this silent on two visits in six.
    const text = await replyText(
      { ...MISSED, settled: true },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.match(text, /Did NOT reach https:\/\/b\.test\/two/);
  });

  it("names the page the tab is actually still on", async () => {
    const text = await replyText(MISSED, {
      url: "https://b.test/two",
      includeSnapshot: false,
    });
    assert.match(text, /the tab was still on http:\/\/a\.test\/one/);
  });

  it("warns inside the SNAPSHOT reply too, which is where it used to vanish", async () => {
    const text = await replyText(MISSED, { url: "https://b.test/two" }, true);
    assert.match(text, /Did NOT reach/);
    // Still a real snapshot — the warning is added to it, not swapped for it.
    assert.match(text, /Page Snapshot/);
  });

  it("keeps the extension's own account in structuredContent", async () => {
    const result = await navigate(false).handle(contextReturning(MISSED), {
      url: "https://b.test/two",
      includeSnapshot: false,
    });
    assert.deepEqual(result.structuredContent, { action: MISSED });
  });
});

describe("browser_navigate stays quiet when an unchanged url is correct", () => {
  it("a navigation that worked still reads as one that worked", async () => {
    const text = await replyText(
      { ok: true, navigated: true, settled: true, urlAfter: "https://b.test/two" },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("a redirect that lands somewhere else is a navigation, not a miss", async () => {
    const text = await replyText(
      {
        ok: true,
        navigated: true,
        settled: true,
        urlBefore: "http://a.test/one",
        urlAfter: "https://b.test/landed-here",
      },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("a trailing slash is the same page, not a miss", async () => {
    const text = await replyText(
      {
        ok: true,
        navigated: false,
        settled: true,
        urlBefore: "http://a.test/",
        urlAfter: "http://a.test/",
      },
      { url: "http://a.test", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to http://a.test");
  });

  it("a same-url navigation settles, so it is not a miss", async () => {
    const text = await replyText(
      {
        ok: true,
        navigated: false,
        settled: true,
        urlBefore: "https://b.test/two",
        urlAfter: "https://b.test/two",
      },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("waitUntil none asked not to wait, so it cannot call anything a miss", async () => {
    const text = await replyText(MISSED, {
      url: "https://b.test/two",
      waitUntil: "none",
      includeSnapshot: false,
    });
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("a reload is still a reload", async () => {
    const text = await replyText(MISSED, { reload: true, includeSnapshot: false });
    assert.equal(text, "Reloaded");
  });

  it("a navigation that was merely SLOW is not accused once it lands", async () => {
    // Measured on a real Chrome: an interstitial reports this exact shape and
    // then commits ~700 ms later. Reporting the first answer as failure was the
    // first version of this fix, and it was wrong twice out of three visits.
    const text = await replyText(
      MISSED,
      { url: "https://b.test/two", includeSnapshot: false },
      false,
      "https://b.test/two",
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("says nothing when the extension did not report where the tab started", async () => {
    const text = await replyText(
      { ok: true, navigated: false, settled: false },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });

  it("an older extension that reports neither field is never accused", async () => {
    const text = await replyText(
      { ok: true, urlAfter: "http://a.test/one" },
      { url: "https://b.test/two", includeSnapshot: false },
    );
    assert.equal(text, "Navigated to https://b.test/two");
  });
});
