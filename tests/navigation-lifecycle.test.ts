/**
 * A navigation finishes when the navigation we asked for finishes (B09).
 *
 * The bug: `finishNavigation` polled `tab.status === "complete"`. Straight after
 * `chrome.tabs.reload` the tab still reports the PREVIOUS document as complete,
 * so the first poll tick matched — reload came back `settled: true` in 0 ms, and
 * the `finally` pulled the init script down before the new document existed, so
 * a call that answered `initScript: "installed"` had in fact installed nothing
 * that ever ran.
 *
 * These cases pin the five things that make a navigation result trustworthy: it
 * cannot conclude against the document it was leaving, a stray completion that
 * belongs to no requested transition is ignored, a move that never loads (a hash,
 * a `pushState`) still returns instead of hanging, a transition that never begins
 * gives up in about a second rather than the full budget, and every listener is
 * gone on every exit — including the ones a `waitUntil: "none"` caller never
 * waited for.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

const NAVIGATION = "Chrome-extension/lib/automation/navigation.ts";
const TAB_ID = 7;

interface NavResult {
  ok: true;
  navigated: boolean;
  urlBefore?: string;
  urlAfter?: string;
  settled: boolean;
  elapsedMs: number;
}

interface NavigationModule {
  navigate(
    tabId: number,
    url: string | undefined,
    opts?: Record<string, unknown>,
  ): Promise<NavResult & { initScript?: "installed" }>;
  goBack(tabId: number, opts?: Record<string, unknown>): Promise<NavResult>;
  goForward(tabId: number, opts?: Record<string, unknown>): Promise<NavResult>;
}

/** One `chrome.tabs.onUpdated` payload, and how long after the transition to fire it. */
interface Beat {
  afterMs: number;
  status?: "loading" | "complete";
  url?: string;
  /**
   * Change the tab's state WITHOUT delivering an event for it. A real Chrome
   * does this: the tab reports `status: "loading"` while no `loading` update
   * ever reaches the listener, which is the whole of B12.
   */
  silent?: boolean;
}

type Listener = (...args: unknown[]) => void;

/**
 * A `chrome.tabs` double that reports what a real tab reports: a status the
 * module can read at any moment, and events it only ever receives.
 *
 * The default status is `"complete"`, because that is precisely the state the
 * old poll mistook for the new page — a fake that started `"loading"` would hide
 * the bug these cases exist to catch.
 */
function fakeTabs(script: Beat[] = []) {
  const timeline: Array<{ at: number; what: string }> = [];
  const listeners = {
    updated: [] as Listener[],
    removed: [] as Listener[],
    replaced: [] as Listener[],
  };
  const timers: NodeJS.Timeout[] = [];
  const startedAt = Date.now();
  const state = { url: "https://example.test/a", status: "complete" as string };

  const note = (what: string) => timeline.push({ at: Date.now() - startedAt, what });
  const fire = (which: keyof typeof listeners, args: unknown[]) => {
    for (const fn of [...listeners[which]]) fn(...args);
  };

  /** Play the scripted beats, as a real tab would once a transition is issued. */
  const run = () => {
    for (const beat of script) {
      timers.push(
        setTimeout(() => {
          if (beat.status) state.status = beat.status;
          if (beat.url) state.url = beat.url;
          note(
            `tab:${beat.status ?? ""}${beat.url ? " url" : ""}${beat.silent ? " (silent)" : ""}`.trim(),
          );
          if (beat.silent) return;
          fire("updated", [
            TAB_ID,
            {
              ...(beat.status ? { status: beat.status } : {}),
              ...(beat.url ? { url: beat.url } : {}),
            },
          ]);
        }, beat.afterMs),
      );
    }
  };

  const channel = (which: keyof typeof listeners) => ({
    addListener: (fn: Listener) => listeners[which].push(fn),
    removeListener: (fn: Listener) => {
      const i = listeners[which].indexOf(fn);
      if (i >= 0) listeners[which].splice(i, 1);
    },
  });

  return {
    timeline,
    note,
    /** Total listeners still attached — must be 0 once a call has returned. */
    open: () => listeners.updated.length + listeners.removed.length + listeners.replaced.length,
    /** Close the tab mid-flight, the way a user does. */
    close: () => {
      note("tab:removed");
      fire("removed", [TAB_ID, { windowId: 1, isWindowClosing: false }]);
    },
    stop: () => timers.forEach(clearTimeout),
    chrome: {
      tabs: {
        get: async (id: number) => {
          if (id !== TAB_ID) throw new Error("no such tab");
          return { id, windowId: 1, url: state.url, status: state.status };
        },
        reload: async () => {
          note("issued:reload");
          run();
        },
        update: async (_id: number, info: { url?: string }) => {
          note(`issued:update ${info.url ?? ""}`.trim());
          run();
        },
        goBack: async () => {
          note("issued:goBack");
          run();
        },
        goForward: async () => {
          note("issued:goForward");
          run();
        },
        onUpdated: channel("updated"),
        onRemoved: channel("removed"),
        onReplaced: channel("replaced"),
      },
    },
  };
}

/**
 * Load the real navigation module against that double.
 *
 * `navigation.ts` pulls in the screenshot, CDP, ref-parsing and injection
 * modules for its OTHER half; none of them takes part in a navigation, so they
 * are stubbed rather than loaded. `cdp` is the exception that matters: the init
 * script's lifetime is the second half of B09, so every call it makes is stamped
 * onto the same timeline as the tab's events, and the order of the two is what
 * the assertion reads.
 */
function loadNavigation(script: Beat[] = []) {
  const tabs = fakeTabs(script);
  const mod = loadExtensionModule<NavigationModule>(NAVIGATION, {
    globals: { chrome: tabs.chrome },
    mocks: {
      "./advanced": { cdpScreenshot: async () => ({ data: "", mimeType: "image/png" }) },
      "./driver": { parseRef: (ref: string) => ({ frameId: 0, bare: ref }) },
      "./run-func": { runFunc: async () => ({ ok: true }) },
      "./cdp": {
        requireAttached: () => {},
        addInitScript: async () => {
          tabs.note("cdp:addInitScript");
          return "init-1";
        },
        removeInitScript: async () => {
          tabs.note("cdp:removeInitScript");
        },
        setDialogPolicy: () => {
          tabs.note("cdp:setDialogPolicy");
          return null;
        },
      },
    },
  });
  return {
    nav: mod.exports,
    tabs,
    dispose: () => {
      tabs.stop();
      mod.dispose();
    },
  };
}

describe("navigation waits for the navigation it asked for", () => {
  it("a reload cannot finish against the document it is replacing", async () => {
    // The tab sits at `complete` the whole time the new load is in flight — the
    // exact state the old poll resolved on immediately.
    const { nav, tabs, dispose } = loadNavigation([
      { afterMs: 30, status: "loading" },
      { afterMs: 220, status: "complete" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, undefined, { reload: true });
      assert.equal(r.settled, true);
      assert.ok(
        r.elapsedMs >= 150,
        `resolved in ${r.elapsedMs}ms — that is the old document's status, not the new load`,
      );
      assert.equal(tabs.open(), 0, "listeners left attached");
    } finally {
      dispose();
    }
  });

  it("ignores a completion that belongs to no requested transition", async () => {
    // A stray `complete` with no `loading` in front of it is the previous
    // document reporting itself, or an unrelated load landing late. Taking it
    // would be the same bug arriving by a different route.
    const { nav, tabs, dispose } = loadNavigation([
      { afterMs: 20, status: "complete" },
      { afterMs: 60, status: "loading" },
      { afterMs: 240, status: "complete", url: "https://example.test/b" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/b", {});
      assert.equal(r.settled, true);
      assert.ok(r.elapsedMs >= 180, `took the stray completion at ${r.elapsedMs}ms`);
      assert.equal(r.urlAfter, "https://example.test/b");
      assert.equal(r.navigated, true);
      assert.equal(tabs.open(), 0);
    } finally {
      dispose();
    }
  });

  it("returns for a move that never loads, instead of waiting out the budget", async () => {
    // A hash or `pushState` step changes the url and never leaves `complete`.
    // Waiting for a load event here would hang the call for its full 10 s.
    const { nav, dispose } = loadNavigation([{ afterMs: 40, url: "https://example.test/a#two" }]);
    try {
      const r = await nav.goBack(TAB_ID, {});
      assert.equal(r.settled, true);
      assert.ok(r.elapsedMs < 900, `same-document move took ${r.elapsedMs}ms`);
      assert.equal(r.urlAfter, "https://example.test/a#two");
    } finally {
      dispose();
    }
  });

  it("gives up about a second after a transition that never begins", async () => {
    // A url that turns into a download, a forward entry that was not there, a
    // prompt nobody answered: nothing loads, and `settled` must be false rather
    // than the old true — but the caller must not be held for the whole budget.
    const { nav, dispose } = loadNavigation([]);
    try {
      const r = await nav.goForward(TAB_ID, {});
      assert.equal(r.settled, false);
      assert.ok(r.elapsedMs >= 900 && r.elapsedMs < 4000, `gave up after ${r.elapsedMs}ms`);
    } finally {
      dispose();
    }
  });

  it("waits when the TAB says it is loading, even though no event said so", async () => {
    // B12. Measured on a real Chrome: a certificate interstitial — which Chrome
    // re-attempts after ~3 s once a host has failed — is `status: "loading"` at
    // every expiry of the 1 s grace, with no `loading` update ever delivered,
    // and then commits at 3.08 s. Believing the events alone reported "nothing
    // began" about a navigation that was in flight, and the caller was told its
    // page had not loaded while the browser was still fetching it.
    const { nav, dispose } = loadNavigation([
      { afterMs: 20, status: "loading", silent: true },
      { afterMs: 1600, status: "complete", url: "https://example.test/b" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/b", {});
      assert.equal(r.settled, true, "a transition the tab itself reports must not be given up on");
      assert.equal(r.navigated, true);
      assert.equal(r.urlAfter, "https://example.test/b");
      assert.ok(r.elapsedMs >= 1500, `concluded after only ${r.elapsedMs}ms`);
    } finally {
      dispose();
    }
  });

  it("still gives up on a silent tab that is NOT loading", async () => {
    // The other half: the grace exists so a download, an unanswered prompt or a
    // missing forward entry cannot hold the caller for the whole budget. Those
    // leave the tab `complete`, so asking it keeps them exactly as fast.
    const { nav, dispose } = loadNavigation([{ afterMs: 20, status: "complete", silent: true }]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/download", {});
      assert.equal(r.settled, false);
      assert.ok(r.elapsedMs >= 900 && r.elapsedMs < 4000, `gave up after ${r.elapsedMs}ms`);
    } finally {
      dispose();
    }
  });

  it("stops waiting when the tab is closed under it", async () => {
    const { nav, tabs, dispose } = loadNavigation([{ afterMs: 20, status: "loading" }]);
    try {
      const pending = nav.navigate(TAB_ID, "https://example.test/b", {});
      setTimeout(() => tabs.close(), 120);
      const r = await pending;
      assert.equal(r.settled, false);
      assert.ok(r.elapsedMs < 1500, `closure took ${r.elapsedMs}ms to register`);
      assert.equal(tabs.open(), 0);
    } finally {
      dispose();
    }
  });

  it("honours settleMs as a ceiling without ever reporting an early success", async () => {
    const { nav, dispose } = loadNavigation([
      { afterMs: 20, status: "loading" },
      { afterMs: 3000, status: "complete" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/slow", { settleMs: 400 });
      assert.equal(r.settled, false, "a page still loading must not report settled");
      // The start grace is capped by this budget rather than added to it, so a
      // 400 ms cap gives up at 400 ms and not at the grace's full second.
      assert.ok(r.elapsedMs >= 350 && r.elapsedMs < 900, `waited ${r.elapsedMs}ms for a 400ms cap`);
    } finally {
      dispose();
    }
  });

  it('waitUntil "none" returns at once and leaves nothing watching', async () => {
    const { nav, tabs, dispose } = loadNavigation([
      { afterMs: 20, status: "loading" },
      { afterMs: 200, status: "complete" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/b", { waitUntil: "none" });
      assert.equal(r.settled, false);
      assert.ok(r.elapsedMs < 120, `no-wait took ${r.elapsedMs}ms`);
      assert.equal(tabs.open(), 0);
    } finally {
      dispose();
    }
  });

  it("keeps the init script installed until the new document exists, even with no wait", async () => {
    // The half of B09 that silently produced nothing: `waitUntil: "none"` returns
    // before the navigation commits, and the old teardown ran there — so the
    // script the call reported as installed was removed before any document could
    // run it.
    const { nav, tabs, dispose } = loadNavigation([
      { afterMs: 30, status: "loading" },
      { afterMs: 260, status: "complete" },
    ]);
    try {
      const r = await nav.navigate(TAB_ID, "https://example.test/b", {
        waitUntil: "none",
        initScript: "window.__armed = 1",
      });
      assert.equal(r.initScript, "installed");
      const order = tabs.timeline.map((e) => e.what);
      const loaded = order.indexOf("tab:complete");
      const removed = order.indexOf("cdp:removeInitScript");
      assert.ok(loaded >= 0 && removed >= 0, order.join(" -> "));
      assert.ok(removed > loaded, `removed before the new document loaded: ${order.join(" -> ")}`);
      assert.equal(tabs.open(), 0);
    } finally {
      dispose();
    }
  });

  it("removes every listener when the transition itself throws", async () => {
    const { nav, tabs, dispose } = loadNavigation([]);
    try {
      await assert.rejects(() => nav.navigate(TAB_ID, undefined, {}));
      assert.equal(tabs.open(), 0, "a rejected call left the tab being watched");
    } finally {
      dispose();
    }
  });
});
