/**
 * A browser settings page is called a settings page, and refused up front (plan 14, F3).
 *
 * Benchmark T37: `browser_new_tab` opened `chrome://settings/appearance` although
 * `browser_navigate` refuses that scheme, and the next screenshot then said
 * TAB_GONE — "the tab you were driving has closed" — with the tab still open.
 * The relay read Chrome's "Cannot access a chrome:// URL" as a vanished tab and
 * dropped it. Extensions can never script or capture these pages, so the honest
 * answer is one refusal, worded the same by every tool, before anything is sent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { isTabGone } from "@/relay/relay";
import { navigate } from "@/tools/common";
import { asToolError } from "@/tools/errors";
import { newTab } from "@/tools/tabs";

import { loadExtensionModule } from "./helpers/extension-harness";

const SETTINGS = "chrome://settings/appearance";

/** A context that records every send, so "refused before sending" is checkable. */
function recordingContext() {
  const sent: string[] = [];
  const context = {
    sendSocketMessage: async (type: string) => {
      sent.push(type);
      return { tabId: 1, index: 0 };
    },
    setActiveTab: () => undefined,
  } as unknown as Context;
  return { context, sent };
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    return asToolError(e) ?? { code: undefined, message: String(e) };
  }
  assert.fail("expected a refusal");
}

describe("settings pages", () => {
  it("a chrome:// access error is not a closed tab", () => {
    assert.equal(isTabGone("Cannot access a chrome:// URL"), false);
    assert.equal(isTabGone("No tab with id: 42."), true);
  });

  it("browser_new_tab refuses a settings page exactly as browser_navigate does", async () => {
    const opened = recordingContext();
    const viaNewTab = await refusal(() => newTab.handle(opened.context, { url: SETTINGS }));
    assert.deepEqual(opened.sent, [], "refused before anything reached the browser");

    const went = recordingContext();
    const viaNavigate = await refusal(() =>
      navigate(false).handle(went.context, { url: SETTINGS }),
    );

    assert.equal(viaNewTab.code, "RESTRICTED_PAGE");
    assert.match(viaNewTab.message, /browser settings page cannot be read by the agent/);
    assert.match(viaNewTab.message, /a person must look at it/);
    assert.equal(viaNewTab.message, viaNavigate.message);
  });

  it("a screenshot of a settings tab is refused before any capture is tried", async () => {
    const tried: string[] = [];
    const chrome = {
      tabs: {
        get: async () => ({ id: 9, windowId: 1, active: false, url: SETTINGS }),
        captureVisibleTab: async () => {
          tried.push("captureVisibleTab");
          return "data:image/png;base64,";
        },
      },
      windows: { get: async () => ({ id: 1, state: "normal", focused: true }) },
      debugger: {
        attach: async () => {
          tried.push("debugger.attach");
          throw new Error("Cannot access a chrome:// URL");
        },
      },
    };
    const mod = loadExtensionModule<{ screenshot(tabId: number): Promise<unknown> }>(
      "Chrome-extension/lib/automation/navigation.ts",
      { globals: { chrome } },
    );
    try {
      const err = await refusal(() => mod.exports.screenshot(9));
      assert.equal(err.code, "RESTRICTED_PAGE");
      assert.match(err.message, /browser settings page cannot be read by the agent/);
      assert.deepEqual(tried, []);
    } finally {
      mod.dispose();
    }
  });
});
