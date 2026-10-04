/**
 * A click the page ignored is reported (plan 14, F5).
 *
 * The bug: the default click is synthetic, and some pages only act on a real
 * (trusted) click. Nothing recorded whether the page reacted, so a click that
 * did nothing came back as "Clicked" — benchmark run T05 believed it.
 *
 * The in-page op now watches from BEFORE it dispatches (a synchronous handler's
 * changes land during the dispatch itself) and reports `mutated`. It counts DOM
 * changes, a checkbox flipping, and focus moving to a field or elsewhere; the
 * worker adds a request the tab started. None of those is a DOM mutation, and
 * each one is a click that worked.
 *
 * The page function runs for real against a tiny hand-built DOM — see
 * `form-radio-values.test.ts` for why not jsdom.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { click as clickTool } from "@/tools/snapshot";

import { loadExtensionModule } from "./helpers/extension-harness";

const DRIVER = "Chrome-extension/lib/automation/driver.ts";
const TAB_ID = 7;

interface DriverModule {
  click(tabId: number, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Every live observer, so a fake "page change" reaches them like a real one. */
const observers = new Set<FakeObserver>();
class FakeObserver {
  private pending = 0;
  constructor(private cb: (records: unknown[]) => void) {}
  observe() {
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
  takeRecords() {
    const n = this.pending;
    this.pending = 0;
    return new Array(n).fill({});
  }
  /** Delivered as a microtask, as the browser does. */
  record() {
    this.pending++;
    void Promise.resolve().then(() => {
      if (this.pending && observers.has(this)) this.cb(this.takeRecords());
    });
  }
}
const mutate = () => observers.forEach((o) => o.record());

interface Page {
  document: { activeElement: unknown };
}

/** One element: the surface `refOpPage` touches on a click target. */
function element(page: Page, tagName: string, extra: Record<string, unknown> = {}) {
  const el: Record<string, unknown> = {
    tagName,
    shadowRoot: null,
    isContentEditable: false,
    scrollIntoView() {},
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
    }),
    getAttribute: () => null,
    closest: () => null,
    contains: (o: unknown) => o === el,
    getRootNode: () => page.document,
    dispatchEvent: () => true,
    focus() {
      page.document.activeElement = el;
    },
    click() {
      if (el.type === "checkbox") el.checked = !el.checked;
      (el.onClick as (() => void) | undefined)?.();
    },
    ...extra,
  };
  return el;
}

/**
 * Load the real driver with `target` as the one element on the page.
 * `requests`: what the request log answers when asked whether the tab sent one.
 */
function loadDriver(build: (page: Page) => Record<string, unknown>, requests = false) {
  const body = { tagName: "BODY" };
  const page: Page = { document: { activeElement: body } };
  const target = build(page);
  Object.assign(page.document, {
    documentElement: {},
    querySelector: () => target,
    querySelectorAll: () => [],
    elementFromPoint: () => target,
  });
  class Event {
    constructor(public type: string) {}
  }
  const mod = loadExtensionModule<DriverModule>(DRIVER, {
    globals: {
      document: page.document,
      window: { innerWidth: 1000, innerHeight: 800 },
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      MutationObserver: FakeObserver,
      MouseEvent: Event,
      PointerEvent: Event,
      HTMLIFrameElement: class {},
      chrome: {
        tabs: {
          get: async () => ({ id: TAB_ID, url: "https://example.test/a", status: "complete" }),
          onUpdated: { addListener() {}, removeListener() {} },
        },
      },
    },
    mocks: {
      "../preserved-logs": { getPreserved: async () => [] },
      "./emulate": { waitMultiplier: () => 1 },
      "./network": { requestSince: async () => requests },
      "./run-func": {
        runFunc: async (_t: number, fn: (...a: unknown[]) => unknown, args: unknown[]) =>
          fn(...args),
        runFuncAllFrames: async () => [],
        unwrap: <T>(r: T) => r,
      },
    },
  });
  return { driver: mod.exports, dispose: mod.dispose };
}

async function clickOn(build: (page: Page) => Record<string, unknown>, requests = false) {
  const { driver, dispose } = loadDriver(build, requests);
  try {
    return await driver.click(TAB_ID, { ref: "e1", waitUntil: "none" });
  } finally {
    dispose();
    observers.clear();
  }
}

describe("a click the page ignored (worker)", () => {
  it("a button with no handler reports mutated:false", async () => {
    const r = await clickOn((page) => element(page, "BUTTON"));
    assert.equal(r.ok, true);
    assert.equal(r.mutated, false);
  });

  it("a handler that changes the DOM while the click is dispatched counts", async () => {
    const r = await clickOn((page) => element(page, "BUTTON", { onClick: mutate }));
    assert.equal(
      r.mutated,
      true,
      "the change landed before an after-the-fact observer would start",
    );
  });

  it("a handler that changes the DOM a moment later counts", async () => {
    const r = await clickOn((page) =>
      element(page, "BUTTON", { onClick: () => setTimeout(mutate, 30) }),
    );
    assert.equal(r.mutated, true);
  });

  it("a checkbox that flipped counts, though the DOM did not change", async () => {
    const r = await clickOn((page) => element(page, "INPUT", { type: "checkbox", checked: false }));
    assert.equal(r.mutated, true);
  });

  it("a handler that moved focus elsewhere counts", async () => {
    const r = await clickOn((page) => {
      const field = { tagName: "INPUT" };
      return element(page, "BUTTON", {
        onClick: () => {
          page.document.activeElement = field;
        },
      });
    });
    assert.equal(r.mutated, true);
  });

  it("clicking into a text field counts - it took the focus", async () => {
    const r = await clickOn((page) => element(page, "INPUT", { type: "text" }));
    assert.equal(r.mutated, true);
  });

  it("a click that only sent a request counts", async () => {
    const r = await clickOn((page) => element(page, "BUTTON"), true);
    assert.equal(r.mutated, true);
  });
});

/** A context whose browser answers the click with `result`. */
function context(result: Record<string, unknown>) {
  return { sendSocketMessage: async () => result } as unknown as Context;
}

const text = async (result: Record<string, unknown>) => {
  const r = await clickTool.handle(context(result), { element: "Go", ref: "e1" });
  return (r.content[0] as { text: string }).text;
};

describe("a click the page ignored (reply)", () => {
  it("no change and no navigation adds the note", async () => {
    const t = await text({ ok: true, mutated: false, navigated: false });
    assert.match(t, /^Clicked "Go"/);
    assert.match(t, /No change seen on the page/);
    assert.match(t, /browser_advanced_mode/);
  });

  it("a change seen adds no note", async () => {
    assert.doesNotMatch(
      await text({ ok: true, mutated: true, navigated: false }),
      /No change seen/,
    );
  });

  it("a navigation adds no note, whatever the DOM did", async () => {
    assert.doesNotMatch(
      await text({ ok: true, mutated: false, navigated: true }),
      /No change seen/,
    );
  });

  it("a result that does not say (point click, real input) adds no note", async () => {
    assert.doesNotMatch(await text({ ok: true, navigated: false }), /No change seen/);
  });
});
