/**
 * Hover tells the truth, and advanced mode does a real one (plan 14, F6).
 *
 * The bug: the default hover dispatches synthetic mouse events. Page scripts see
 * them, but the browser's own hover state never moves, so CSS `:hover` rules do
 * not apply — and the reply said "Hovered over", which benchmark runs read as
 * "the hover look is showing". The reply now says what it did, and with the
 * debugger attached hover sends a real mouse move instead.
 *
 * A real move is DISCARDED by Chrome for a tab it is not drawing while the
 * command still reports success, so the trusted hover refuses a hidden tab up
 * front, exactly like the trusted click.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { hover as hoverTool } from "@/tools/snapshot";

import { loadExtensionModule } from "./helpers/extension-harness";

interface AdvancedModule {
  nativeHover(tabId: number, args: { ref: string }): Promise<Record<string, unknown>>;
}

/** The real advanced module over a scripted debugger session. */
function loadAdvanced(visibility: "visible" | "hidden") {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const mod = loadExtensionModule<AdvancedModule>("Chrome-extension/lib/automation/advanced.ts", {
    globals: { chrome: {} },
    mocks: {
      "./cdp": {
        requireAttached() {},
        sendCommand: async (_tab: number, method: string, params: Record<string, unknown>) => {
          sent.push({ method, params });
          if (method !== "Runtime.evaluate") return {};
          return String(params.expression) === "document.visibilityState"
            ? { result: { value: visibility } }
            : { result: { value: { x: 10, y: 20 } } }; // the element's centre
        },
      },
      "./driver": { parseRef: (ref: string) => ({ frameId: 0, bare: ref }) },
      "./run-func": { runFunc: async () => undefined },
    },
  });
  const mouse = () => sent.filter((s) => s.method === "Input.dispatchMouseEvent");
  return { advanced: mod.exports, mouse, dispose: mod.dispose };
}

describe("a real hover (advanced mode)", () => {
  it("is refused on a tab Chrome is not drawing, before any input is sent", async () => {
    const { advanced, mouse, dispose } = loadAdvanced("hidden");
    try {
      await assert.rejects(advanced.nativeHover(7, { ref: "e1" }), /not drawing this tab/);
      assert.equal(mouse().length, 0);
    } finally {
      dispose();
    }
  });

  it("on a visible tab moves the mouse to the element and presses nothing", async () => {
    const { advanced, mouse, dispose } = loadAdvanced("visible");
    try {
      const r = await advanced.nativeHover(7, { ref: "e1" });
      assert.equal(r.trusted, true);
      assert.deepEqual(
        mouse().map((s) => [s.params.type, s.params.x, s.params.y]),
        [["mouseMoved", 10, 20]],
      );
    } finally {
      dispose();
    }
  });
});

const reply = async (result: Record<string, unknown>) => {
  const ctx = { sendSocketMessage: async () => result } as unknown as Context;
  const r = await hoverTool.handle(ctx, { element: "Menu", ref: "e1" });
  return (r.content[0] as { text: string }).text;
};

describe("the hover reply", () => {
  it("by default says CSS hover styles do not apply, and how to get them", async () => {
    const t = await reply({ ok: true });
    assert.match(t, /^Hovered over "Menu"/);
    assert.match(t, /CSS :hover styles do not apply/);
    assert.match(t, /browser_advanced_mode/);
  });

  it("after a real hover says nothing of the sort", async () => {
    const t = await reply({ ok: true, trusted: true });
    assert.match(t, /^Hovered over "Menu"/);
    assert.doesNotMatch(t, /do not apply/);
  });
});
