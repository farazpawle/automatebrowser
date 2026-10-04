/**
 * browser_switch_tab brings back a minimised window and says whether the page is
 * really showing (plan 14, F8, decision D1).
 *
 * The bug: the switch sent `windows.update({focused:true})` only. Chrome documents
 * that focusing does not un-minimise a window, so on a minimised browser the
 * switch "succeeded" and the page stayed hidden — and every later step that needs
 * a drawn page (a real click, a trace, a fast screenshot) failed for a reason the
 * switch had just claimed to remove. The reply now reports what the PAGE says,
 * never what was asked for.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { switchTab as switchTool } from "@/tools/tabs";

import { loadExtensionModule } from "./helpers/extension-harness";

interface TabsModule {
  switchTab(ref: { tabId?: number }): Promise<{ tabId: number; visibilityState?: string }>;
}

/** The real tabs module over a `chrome` double that records every window update. */
function loadTabs(windowState: string, visibility: () => Promise<string> = async () => "visible") {
  const updates: Array<[number, Record<string, unknown>]> = [];
  const chrome = {
    tabs: { update: async (tabId: number) => ({ id: tabId, windowId: 3 }) },
    windows: {
      get: async (id: number) => ({ id, state: windowState }),
      update: async (id: number, info: Record<string, unknown>) => {
        updates.push([id, info]);
        return { id };
      },
    },
  };
  const mod = loadExtensionModule<TabsModule>("Chrome-extension/lib/automation/tabs.ts", {
    globals: { chrome },
    mocks: { "./run-func": { runFunc: visibility } },
  });
  return { tabs: mod.exports, updates, dispose: mod.dispose };
}

/** Objects built inside the vm sandbox have its prototypes; compare their data. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("switching to a tab in a minimised window", () => {
  it("restores the window before focusing it", async () => {
    const { tabs, updates, dispose } = loadTabs("minimized");
    try {
      await tabs.switchTab({ tabId: 7 });
      assert.deepEqual(plain(updates), [
        [3, { state: "normal" }],
        [3, { focused: true }],
      ]);
    } finally {
      dispose();
    }
  });

  it("leaves a window that is not minimised alone, only focusing it", async () => {
    const { tabs, updates, dispose } = loadTabs("maximized");
    try {
      await tabs.switchTab({ tabId: 7 });
      assert.deepEqual(plain(updates), [[3, { focused: true }]]);
    } finally {
      dispose();
    }
  });

  it("returns what the page says about its own visibility", async () => {
    const { tabs, dispose } = loadTabs("normal", async () => "hidden");
    try {
      assert.deepEqual(plain(await tabs.switchTab({ tabId: 7 })), {
        tabId: 7,
        visibilityState: "hidden",
      });
    } finally {
      dispose();
    }
  });

  it("still switches when the page cannot be asked (a settings page)", async () => {
    const { tabs, dispose } = loadTabs("normal", async () => {
      throw new Error("RESTRICTED_PAGE: Cannot run on this page");
    });
    try {
      assert.deepEqual(plain(await tabs.switchTab({ tabId: 7 })), { tabId: 7 });
    } finally {
      dispose();
    }
  });
});

const reply = async (result: Record<string, unknown>) => {
  const ctx = {
    sendSocketMessage: async () => result,
    setActiveTab() {},
  } as unknown as Context;
  const r = await switchTool.handle(ctx, { tabId: 7 });
  return (r.content[0] as { text: string }).text;
};

describe("the switch reply", () => {
  it("warns when the page is still hidden", async () => {
    const t = await reply({ tabId: 7, visibilityState: "hidden" });
    assert.match(t, /^Switched to tab tabId=7/);
    assert.match(t, /still hidden/);
  });

  it("says visible when the page says so", async () => {
    const t = await reply({ tabId: 7, visibilityState: "visible" });
    assert.match(t, /visible/);
    assert.doesNotMatch(t, /hidden/);
  });

  it("claims nothing when the extension did not report it (older build, settings page)", async () => {
    assert.equal(await reply({ tabId: 7 }), "Switched to tab tabId=7");
  });
});
