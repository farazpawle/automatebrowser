/**
 * Icon-only controls get a name in the snapshot (plan 14, F12).
 *
 * `<button id="buttonGenerate"><i class="fa fa-cog"></i></button>` has no text,
 * so the snapshot printed a bare `- button [ref=…]` and the agent could not
 * tell it from the button next to it (benchmark T15). With no name of its own a
 * control now falls back to its `title`, then an inner image's `alt`, then its
 * `#id`.
 *
 * The fallback must never reach the ref: refs come from attributes, and a ref
 * that changed with this fix would break every ref an agent already holds.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";
import { all, type El, h } from "./helpers/fake-dom";

interface DriverModule {
  snapshot(tabId: number): Promise<string>;
}

/** The real snapshot walk over the page whose <body> is `body`. */
async function snapshotOf(body: El): Promise<string> {
  const els = all(body);
  const mod = loadExtensionModule<DriverModule>("Chrome-extension/lib/automation/driver.ts", {
    globals: {
      document: {
        body,
        title: "t",
        querySelectorAll: () => els.filter((e) => e.attrs["data-bmcp-ref"]),
        getElementById: () => null,
      },
      location: { href: "http://a.test/" },
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
      Node: { TEXT_NODE: 3 },
    },
    mocks: {
      "../preserved-logs": {},
      "./emulate": {},
      "./network": {},
      "./run-func": {
        runFuncAllFrames: async (_t: number, fn: (...a: unknown[]) => unknown, a: unknown[]) => [
          { frameId: 0, result: fn(...a) },
        ],
      },
    },
  });
  try {
    return await mod.exports.snapshot(1);
  } finally {
    mod.dispose();
  }
}

const page = () =>
  h(
    "body",
    {},
    h("button", { id: "buttonGenerate" }, h("i", { class: "fa fa-cog" })),
    h("button", { id: "b2", title: "Refresh" }, h("i", { class: "fa fa-refresh" })),
    h("button", { id: "b3" }, h("img", { alt: "Settings", src: "cog.png" })),
    h("a", { href: "/x" }, h("i", { class: "fa fa-home" })),
    h("button", { id: "b4", title: "unused" }, "Save"),
  );

describe("an icon-only control gets a fallback name", () => {
  it("its #id when it has nothing else", async () => {
    assert.match(await snapshotOf(page()), /- button "#buttonGenerate" \[ref=/);
  });

  it("its title before its id", async () => {
    assert.match(await snapshotOf(page()), /- button "Refresh" \[ref=/);
  });

  it("an inner image's alt before its id", async () => {
    assert.match(await snapshotOf(page()), /- button "Settings" \[ref=/);
  });

  it("nothing when it has no title, image or id - no made-up name", async () => {
    assert.match(await snapshotOf(page()), /- link \[ref=/);
  });

  it("a control with its own text keeps that text", async () => {
    assert.match(await snapshotOf(page()), /- button "Save" \[ref=/);
  });
});

describe("the fallback name does not change refs", () => {
  it("every ref is the one the snapshot gave before the fix", async () => {
    const refs = Array.from((await snapshotOf(page())).matchAll(/\[ref=(\w+)\]/g), (m) => m[1]);
    // Recorded from the snapshot code before F12 on this same page.
    assert.deepEqual(refs, ["enwjg", "evydd", "e1tsw", "ejvdd", "e6qky"]);
  });
});
