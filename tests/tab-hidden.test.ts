/**
 * A hidden page is refused up front, with one code (plan 14, F9).
 *
 * The bug: a page-speed trace with `reload` on a tab Chrome was not drawing
 * attached the debugger, reloaded the page and recorded for ~11 s, then said the
 * window was not visible — Chrome reports no LCP for a page loaded in the
 * background, so the whole recording could never have answered. It now refuses
 * before attaching or reloading anything.
 *
 * The same refusal on the trusted click, key and hover gains the code
 * `TAB_HIDDEN`, whose recovery is `browser_switch_tab` (which restores a
 * minimised window, F8).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asToolError } from "@/tools/errors";

import { loadExtensionModule } from "./helpers/extension-harness";

interface Advanced {
  nativeHover(tabId: number, args: { ref: string }): Promise<unknown>;
  perfTrace(
    tabId: number,
    args: { action: "start"; reload?: boolean; autoStop?: boolean },
  ): Promise<Record<string, unknown>>;
}

/** The real advanced module over a recording debugger and a page of the given visibility. */
function load(visibility: "visible" | "hidden") {
  const did: string[] = [];
  const mod = loadExtensionModule<Advanced>("Chrome-extension/lib/automation/advanced.ts", {
    globals: {
      chrome: {
        tabs: {
          reload: async () => void did.push("reload"),
          onUpdated: { addListener() {}, removeListener() {} },
        },
      },
    },
    mocks: {
      "./cdp": {
        requireAttached() {},
        isAttached: () => false,
        wantsTrustedInput: () => false,
        attach: async () => void did.push("attach"),
        detach: async () => void did.push("detach"),
        traceStart: async () => void did.push("traceStart"),
        sendCommand: async (_t: number, _m: string, p: { expression?: string }) =>
          p.expression === "document.visibilityState" ? { result: { value: visibility } } : {},
      },
      "./driver": { parseRef: (ref: string) => ({ frameId: 0, bare: ref }) },
      "./run-func": { runFunc: async () => visibility },
    },
  });
  return { advanced: mod.exports, did, dispose: mod.dispose };
}

describe("TAB_HIDDEN", () => {
  it("is a code an agent can act on: not retryable, recovered by browser_switch_tab", () => {
    const e = asToolError(new Error("TAB_HIDDEN: Chrome is not drawing this tab"));
    assert.equal(e?.code, "TAB_HIDDEN");
    assert.equal(e?.retryable, false);
    assert.equal(e?.recover, "browser_switch_tab");
  });

  it("is what a trusted hover on a hidden tab refuses with, explanation kept", async () => {
    const { advanced, dispose } = load("hidden");
    try {
      await assert.rejects(
        advanced.nativeHover(7, { ref: "e1" }),
        /^Error: TAB_HIDDEN: .*not drawing this tab/,
      );
    } finally {
      dispose();
    }
  });
});

describe("a page-speed trace on a hidden page", () => {
  it("refuses before attaching, tracing or reloading anything", async () => {
    const { advanced, did, dispose } = load("hidden");
    try {
      await assert.rejects(
        advanced.perfTrace(7, { action: "start", reload: true, autoStop: true }),
        /^Error: TAB_HIDDEN: .*browser_switch_tab/,
      );
      assert.deepEqual(did, []);
    } finally {
      dispose();
    }
  });

  it("still records a load on a visible page", async () => {
    const { advanced, did, dispose } = load("visible");
    try {
      const r = await advanced.perfTrace(7, { action: "start", reload: true });
      assert.equal(r.reloaded, true);
      assert.deepEqual([...did], ["attach", "traceStart", "reload"]);
    } finally {
      dispose();
    }
  });

  it("still starts a manual trace with no page load on a hidden page (long tasks need no paint)", async () => {
    const { advanced, did, dispose } = load("hidden");
    try {
      const r = await advanced.perfTrace(7, { action: "start" });
      assert.equal(r.started, true);
      assert.deepEqual([...did], ["attach", "traceStart"]);
    } finally {
      dispose();
    }
  });
});
