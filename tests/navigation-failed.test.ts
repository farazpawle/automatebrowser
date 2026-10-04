/**
 * A navigation that ends on Chrome's error page says so (plan 14, F1).
 *
 * The bug: an unreachable host, a refused connection or a blocked http page
 * still produces a document — Chrome's own error page — and it loads like any
 * other: `loading`, then `complete`. So `browser_navigate` answered ok/settled,
 * and the snapshot that followed failed on the error page and came back as
 * RESTRICTED_PAGE with advice about chrome:// pages. Four benchmark tasks lost
 * time to that misdirection.
 *
 * Three layers, each tested where it lives:
 *  - the request log names the newest top-level request of THIS navigation;
 *  - `browser_navigate` turns a reported load error into NAVIGATION_FAILED,
 *    before it spends a snapshot on a page with nothing on it;
 *  - any tool that lands on an error page anyway says "Chrome error page", not
 *    "restricted page".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { navigate } from "@/tools/common";
import { ToolError } from "@/tools/errors";

import { loadExtensionModule } from "./helpers/extension-harness";
import { loadNetwork } from "./helpers/fake-network";

describe("lastMainFrame names the top-level request of this navigation", () => {
  it("returns the newest main_frame since the given time, with its error", async () => {
    const { net, request, dispose } = loadNetwork();
    try {
      request(7, "main_frame", "https://old.test/", 1_000, { status: 200 });
      request(7, "main_frame", "https://down.test/", 2_000, {
        error: "net::ERR_CONNECTION_REFUSED",
      });
      request(7, "image", "https://down.test/x.png", 2_100, { error: "net::ERR_FAILED" });
      const got = await net.lastMainFrame(7, 1_500);
      assert.equal(got?.url, "https://down.test/");
      assert.equal(got?.error, "net::ERR_CONNECTION_REFUSED");
    } finally {
      dispose();
    }
  });

  it("ignores other tabs and anything older than the navigation", async () => {
    const { net, request, dispose } = loadNetwork();
    try {
      request(7, "main_frame", "https://old.test/", 1_000, { error: "net::ERR_NAME_NOT_RESOLVED" });
      request(8, "main_frame", "https://other-tab.test/", 2_000, { error: "net::ERR_FAILED" });
      assert.equal(await net.lastMainFrame(7, 1_500), undefined);
    } finally {
      dispose();
    }
  });
});

/** A Context that answers `browser_navigate` with one reply, recording every send. */
function contextReturning(reply: Record<string, unknown>) {
  const sent: string[] = [];
  const context = {
    sendSocketMessage: async (type: string) => {
      sent.push(type);
      if (type === "browser_navigate") return reply;
      if (type === "getUrl") return reply.urlAfter;
      return { url: "x", title: "x", snapshot: "- heading" };
    },
  } as unknown as Context;
  return { context, sent };
}

const FAILED = {
  ok: true,
  navigated: true,
  settled: true,
  urlBefore: "https://a.test/",
  urlAfter: "https://down.test/",
  loadError: "net::ERR_CONNECTION_REFUSED",
  failedUrl: "https://down.test/",
  elapsedMs: 40,
};

describe("browser_navigate refuses to call an error page a page", () => {
  it("throws NAVIGATION_FAILED naming the url and the error, before any snapshot", async () => {
    const { context, sent } = contextReturning(FAILED);
    await assert.rejects(
      () => navigate(true).handle(context, { url: "https://down.test/" }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError, String(e));
        assert.equal(e.code, "NAVIGATION_FAILED");
        assert.match(e.message, /https:\/\/down\.test\//);
        assert.match(e.message, /net::ERR_CONNECTION_REFUSED/);
        return true;
      },
    );
    assert.deepEqual(sent, ["browser_navigate"], "a snapshot was attempted on the error page");
  });

  it("says Chrome upgraded http to https when that is what failed", async () => {
    const { context } = contextReturning({
      ...FAILED,
      urlAfter: "https://plain.test/page",
      failedUrl: "https://plain.test/page",
      loadError: "net::ERR_BLOCKED_BY_CLIENT",
    });
    await assert.rejects(
      () => navigate(false).handle(context, { url: "http://plain.test/page" }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.match(e.message, /upgraded it to https/);
        return true;
      },
    );
  });

  it("does not mention an upgrade when the asked url failed as asked", async () => {
    const { context } = contextReturning(FAILED);
    await assert.rejects(
      () => navigate(false).handle(context, { url: "https://down.test/" }),
      (e: unknown) => {
        assert.doesNotMatch((e as Error).message, /upgraded/);
        return true;
      },
    );
  });

  it("a navigation with no load error is untouched", async () => {
    const { context } = contextReturning({ ...FAILED, loadError: undefined, failedUrl: undefined });
    const r = await navigate(false).handle(context, {
      url: "https://down.test/",
      includeSnapshot: false,
    });
    assert.equal(
      r.content[0]?.type === "text" && r.content[0].text,
      "Navigated to https://down.test/",
    );
  });
});

describe("a tool that lands on an error page says so", () => {
  interface RunFuncModule {
    runFunc(tabId: number, func: () => unknown, args: unknown[]): Promise<unknown>;
  }
  const load = (message: string) =>
    loadExtensionModule<RunFuncModule>("Chrome-extension/lib/automation/run-func.ts", {
      globals: {
        chrome: {
          scripting: {
            executeScript: async () => {
              throw new Error(message);
            },
          },
        },
      },
    });

  it("names the Chrome error page, not the chrome:// advice", async () => {
    const mod = load("Frame with ID 0 is showing error page");
    try {
      await assert.rejects(
        () => mod.exports.runFunc(7, () => 1, []),
        (e: unknown) => {
          const m = (e as Error).message;
          assert.match(m, /^NAVIGATION_FAILED: /);
          assert.match(m, /Chrome error page/);
          assert.doesNotMatch(m, /chrome:\/\//);
          return true;
        },
      );
    } finally {
      mod.dispose();
    }
  });

  it("a genuinely restricted page keeps its RESTRICTED_PAGE advice", async () => {
    const mod = load("Cannot access a chrome:// URL");
    try {
      await assert.rejects(
        () => mod.exports.runFunc(7, () => 1, []),
        /^Error: RESTRICTED_PAGE: |^RESTRICTED_PAGE: /,
      );
    } finally {
      mod.dispose();
    }
  });
});
