/**
 * A click that leaves the page is a navigation, not a timeout (F4).
 *
 * Measured on a real Chrome (2026-10-02): when the document unloads while an
 * injected async function is still pending, `chrome.scripting.executeScript`
 * never settles — still pending after 10 s. The ref op waits in-page for the DOM
 * to go quiet, so a link click on a fast page lost that race every time: the call
 * hung to the 8 s socket deadline, and the server then blamed an open dialog.
 *
 * The fake here reproduces exactly that: the injection never answers, and the
 * tab reports a new load the way Chrome does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

const DRIVER = "Chrome-extension/lib/automation/driver.ts";
const TAB_ID = 7;

interface DriverModule {
  click(tabId: number, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  type(tabId: number, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type Listener = (...args: unknown[]) => void;

/**
 * `unloads`: the injected op never answers and the tab starts a new load, as a
 * followed link does. Otherwise the op answers at once and nothing loads.
 */
function loadDriver({ unloads }: { unloads: boolean }) {
  const listeners: Listener[] = [];
  const state = { url: "https://example.test/a", status: "complete" };
  const timers: NodeJS.Timeout[] = [];
  const fire = (tabId: number, info: Record<string, unknown>) => {
    for (const fn of [...listeners]) fn(tabId, info, { id: tabId });
  };

  const mod = loadExtensionModule<DriverModule>(DRIVER, {
    globals: {
      chrome: {
        tabs: {
          get: async () => ({ id: TAB_ID, url: state.url, status: state.status }),
          onUpdated: {
            addListener: (fn: Listener) => listeners.push(fn),
            removeListener: (fn: Listener) => {
              const i = listeners.indexOf(fn);
              if (i >= 0) listeners.splice(i, 1);
            },
          },
        },
      },
    },
    mocks: {
      "../preserved-logs": { getPreserved: async () => [] },
      "./emulate": { waitMultiplier: () => 1 },
      "./run-func": {
        runFunc: () => {
          if (!unloads) {
            // Another tab loading must not end this tab's wait.
            fire(TAB_ID + 1, { status: "loading" });
            return Promise.resolve({ ok: true, domSettled: true });
          }
          const at = (ms: number, step: () => void) => timers.push(setTimeout(step, ms));
          at(30, () => {
            state.status = "loading";
            fire(TAB_ID, { status: "loading" });
          });
          at(80, () => {
            state.url = "https://example.test/b";
            fire(TAB_ID, { url: state.url });
          });
          at(200, () => {
            state.status = "complete";
            fire(TAB_ID, { status: "complete" });
          });
          return new Promise(() => {}); // the unloaded document never answers
        },
        runFuncAllFrames: async () => [],
        unwrap: <T>(r: T) => r,
      },
    },
  });
  return {
    driver: mod.exports,
    open: () => listeners.length,
    dispose: () => {
      timers.forEach(clearTimeout);
      mod.dispose();
    },
  };
}

/** Fail in 3 s rather than hang to the test runner's own timeout. */
function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

describe("a ref op that leaves the page", () => {
  it("click reports the navigation instead of waiting for an answer that never comes", async () => {
    const { driver, open, dispose } = loadDriver({ unloads: true });
    try {
      const r = await within(driver.click(TAB_ID, { ref: "e1a2" }));
      assert.equal(r.ok, true);
      assert.equal(r.navigated, true);
      assert.equal(r.urlAfter, "https://example.test/b");
      assert.equal(open(), 0, "the load listener was left attached");
    } finally {
      dispose();
    }
  });

  it("type with submit, which leaves the page the same way, does too", async () => {
    const { driver, open, dispose } = loadDriver({ unloads: true });
    try {
      const r = await within(driver.type(TAB_ID, { ref: "e1a2", text: "q", submit: true }));
      assert.equal(r.navigated, true);
      assert.equal(open(), 0);
    } finally {
      dispose();
    }
  });

  it("an op that stays on the page still returns its own answer", async () => {
    const { driver, open, dispose } = loadDriver({ unloads: false });
    try {
      const r = await within(driver.click(TAB_ID, { ref: "e1a2", waitUntil: "none" }));
      assert.equal(r.navigated, false);
      assert.equal(r.domSettled, true, "the in-page answer must not be replaced");
      assert.equal(open(), 0);
    } finally {
      dispose();
    }
  });
});
