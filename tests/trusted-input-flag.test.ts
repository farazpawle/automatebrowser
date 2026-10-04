/**
 * Capture must not change how clicks are sent (plan 14, F7).
 *
 * The bug: "the debugger is attached" and "the agent asked for real input" were
 * one flag. Network capture with `keepEnabled` attaches the debugger and leaves
 * it, so every later click, key and hover silently switched to trusted CDP input
 * — which Chrome discards on a hidden tab, so they started being refused (T24).
 * A page-speed trace attached and never detached, which leaked the same way.
 *
 * Real input is now chosen on a separate flag that only `browser_advanced_mode`
 * sets. These tests run the real router, the real advanced module and the real
 * debugger bookkeeping over a fake `chrome.debugger`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

type Fn = (...a: unknown[]) => unknown;

/** The slices of the real modules these tests call. */
interface Cdp {
  attach(tabId: number): Promise<void>;
  isAttached(tabId: number): boolean;
}
interface Advanced {
  setAdvancedMode(
    tabId: number,
    args: { enable?: boolean },
  ): Promise<{ enabled: boolean; attachedTabs: number[] }>;
  perfTrace(tabId: number, args: { action: "start" | "stop" }): Promise<unknown>;
}
type Handlers = Record<string, (p: unknown) => Promise<unknown>>;

/** A `chrome` whose debugger attaches, answers every command and can finish a trace. */
function fakeChrome() {
  const onEvent: Fn[] = [];
  const onDetach: Fn[] = [];
  const chrome = {
    runtime: { lastError: undefined },
    permissions: { contains: async () => true },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      reload: async () => undefined,
    },
    debugger: {
      attach: (_t: unknown, _v: string, cb: Fn) => cb(),
      detach: (_t: unknown, cb: Fn) => cb(),
      sendCommand: (t: { tabId: number }, method: string, _p: unknown, cb: Fn) => {
        cb({});
        if (method === "Tracing.end") {
          setTimeout(() => onEvent.forEach((l) => l(t, "Tracing.tracingComplete", {})), 0);
        }
      },
      onEvent: { addListener: (l: Fn) => onEvent.push(l) },
      onDetach: { addListener: (l: Fn) => onDetach.push(l) },
    },
  };
  /** The user closing the "debugging this browser" banner. */
  const userDetaches = (tabId: number) => onDetach.forEach((l) => l({ tabId }));
  return { chrome, userDetaches };
}

const STUB_MODULES = [
  "./a11y",
  "./content-ops",
  "./dialog",
  "./downloads",
  "./emulate",
  "./forms",
  "./issues",
  "./navigation",
  "./net-policy",
  "./network",
  "./page-tools",
  "./proxy",
  "./state",
  "./tabs",
  "./wait-for",
];

function setup() {
  const { chrome, userDetaches } = fakeChrome();
  const cdp = loadExtensionModule("Chrome-extension/lib/automation/cdp.ts", {
    globals: { chrome },
  });
  const driver = {
    click: async () => "synthetic",
    hover: async () => "synthetic",
    pressKey: async () => "synthetic",
    parseRef: (ref: string) => ({ frameId: 0, bare: ref }),
  };
  const realAdvanced = loadExtensionModule("Chrome-extension/lib/automation/advanced.ts", {
    globals: { chrome },
    mocks: { "./cdp": cdp.exports, "./driver": driver, "./run-func": { runFunc: async () => 0 } },
  });
  // The router's trusted calls are stubbed: which one it picks is the question.
  const advanced = {
    ...realAdvanced.exports,
    nativeClick: async () => "trusted",
    nativeHover: async () => "trusted",
    nativeKey: async () => "trusted",
  };
  const router = loadExtensionModule<{ createHandlerMap(ctx: unknown): Handlers }>(
    "Chrome-extension/lib/automation/index.ts",
    {
      globals: { chrome },
      mocks: {
        "./cdp": cdp.exports,
        "./advanced": advanced,
        "./driver": driver,
        ...Object.fromEntries(STUB_MODULES.map((m) => [m, {}])),
      },
    },
  );
  const h = router.exports.createHandlerMap({ getTabId: async () => 7 });
  const p = { __bmcpTabId: 7, ref: "e1", key: "Enter" };
  const delivery = async () => [
    await h.browser_click(p),
    await h.browser_press_key(p),
    await h.browser_hover(p),
  ];
  const dispose = () => [cdp, realAdvanced, router].forEach((m) => m.dispose());
  return {
    cdp: cdp.exports as unknown as Cdp,
    advanced: realAdvanced.exports as unknown as Advanced,
    delivery,
    userDetaches,
    dispose,
  };
}

describe("F7 — real input is chosen by advanced mode, not by an attached debugger", () => {
  it("a capture that kept the debugger attached leaves click, key and hover synthetic", async () => {
    const s = setup();
    try {
      // What `withAttached(..., keepEnabled: true)` leaves behind.
      await s.cdp.attach(7);
      assert.equal(s.cdp.isAttached(7), true);
      assert.deepEqual(await s.delivery(), ["synthetic", "synthetic", "synthetic"]);
    } finally {
      s.dispose();
    }
  });

  it("advanced mode on sends real input; off goes back to synthetic", async () => {
    const s = setup();
    try {
      await s.advanced.setAdvancedMode(7, { enable: true });
      assert.deepEqual(await s.delivery(), ["trusted", "trusted", "trusted"]);
      await s.advanced.setAdvancedMode(7, { enable: false });
      assert.deepEqual(await s.delivery(), ["synthetic", "synthetic", "synthetic"]);
    } finally {
      s.dispose();
    }
  });

  it("the user closing the debugger banner ends real input too", async () => {
    const s = setup();
    try {
      await s.advanced.setAdvancedMode(7, { enable: true });
      s.userDetaches(7);
      assert.deepEqual(await s.delivery(), ["synthetic", "synthetic", "synthetic"]);
    } finally {
      s.dispose();
    }
  });

  it("the advanced-mode status reports the mode, not a capture's leftover attach", async () => {
    const s = setup();
    try {
      await s.cdp.attach(7);
      const r = await s.advanced.setAdvancedMode(7, {});
      assert.equal(r.enabled, false);
      assert.deepEqual([...r.attachedTabs], [7]); // copied out of the vm's realm
    } finally {
      s.dispose();
    }
  });
});

describe("F7 — a page-speed trace leaves the debugger as it found it", () => {
  it("detaches after stopping when the trace did the attaching", async () => {
    const s = setup();
    try {
      await s.advanced.perfTrace(7, { action: "start" });
      assert.equal(s.cdp.isAttached(7), true);
      await s.advanced.perfTrace(7, { action: "stop" });
      assert.equal(s.cdp.isAttached(7), false);
    } finally {
      s.dispose();
    }
  });

  it("stays attached when advanced mode was already on", async () => {
    const s = setup();
    try {
      await s.advanced.setAdvancedMode(7, { enable: true });
      await s.advanced.perfTrace(7, { action: "start" });
      await s.advanced.perfTrace(7, { action: "stop" });
      assert.equal(s.cdp.isAttached(7), true);
      assert.deepEqual(await s.delivery(), ["trusted", "trusted", "trusted"]);
    } finally {
      s.dispose();
    }
  });
});
