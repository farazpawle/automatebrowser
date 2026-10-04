/**
 * Every element ref in ONE call must name ONE frame (B07).
 *
 * The bug these assertions pin down was silent by construction. `frameOf` took
 * the FIRST prefixed ref and injected the whole operation into that frame, so a
 * second ref belonging to a different frame — or to the top page, which a bare
 * ref has always meant — was resolved inside the wrong document. Nothing failed:
 * a same-named element there took the place of the one the caller asked for, the
 * click landed on it, and the tool reported success.
 *
 * So the load-bearing assertion in most of these cases is not the message. It is
 * that `runFunc` was never called: the refusal has to land BEFORE injection, or
 * before the stale-ref recovery re-tag, or a drag half-performed across two
 * documents is exactly what "refused" was supposed to prevent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

const DRIVER = "Chrome-extension/lib/automation/driver.ts";

interface DriverModule {
  click(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  type(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  hover(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  selectOption(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  drag(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  evaluate(tabId: number, args: Record<string, unknown>): Promise<unknown>;
  parseRef(ref: string): { frameId: number; bare: string };
}

/** One injection recorded as the driver made it: which frame, which refs. */
interface Injection {
  world?: string;
  frameId?: number;
  refs?: unknown;
}

/**
 * Load the real driver with its three imports replaced, and record every
 * injection instead of performing one. `result` is what the injected op is
 * pretended to have returned, so a same-frame call can be driven to success.
 */
function loadDriver(result: unknown = { ok: true }) {
  const injections: Injection[] = [];
  const mod = loadExtensionModule<DriverModule>(DRIVER, {
    globals: {
      chrome: {
        // `settleAfterAction` and `currentUrl` ask for the tab; a settled,
        // never-navigating tab keeps every case about refs and nothing else.
        tabs: {
          get: async () => ({ url: "https://example.test/", status: "complete" }),
          // Every ref op watches for the tab starting a new load (F4).
          onUpdated: { addListener: () => {}, removeListener: () => {} },
        },
      },
    },
    mocks: {
      "../preserved-logs": { getPreserved: async () => [] },
      "./emulate": { waitMultiplier: () => 1 },
      "./run-func": {
        runFunc: async (
          _tabId: number,
          _fn: unknown,
          args: unknown[],
          world?: string,
          frameId?: number,
        ) => {
          // `refOpPage` takes (op, refs, opts); `evalPage` takes
          // (expression, function, refs, dialogAction). Record the array that
          // holds refs in each, so a wrongly-routed ref list is visible.
          injections.push({ world, frameId, refs: Array.isArray(args[1]) ? args[1] : args[2] });
          return result;
        },
        runFuncAllFrames: async () => [],
        unwrap: <T>(r: T) => r,
      },
    },
  });
  return { ...mod, injections };
}

/**
 * Copy a value the loaded module produced into THIS realm before comparing it.
 *
 * `node:vm` gives the module its own `Array`/`Object`, and `assert/strict`'s deep
 * comparison checks prototype identity — so an array that is right in every
 * element still fails with "same structure but not reference-equal".
 */
const own = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Assert a call was refused, and that the refusal cost the page nothing. */
async function refuses(
  run: () => Promise<unknown>,
  injections: Injection[],
  expected: RegExp,
): Promise<Error> {
  const err = await run().then(
    () => {
      throw new assert.AssertionError({ message: "expected a refusal, got success" });
    },
    (e: Error) => e,
  );
  assert.match(err.message, expected);
  assert.match(err.message, /^BAD_ARGS: /, "the refusal must carry a code the server can adopt");
  assert.equal(
    injections.length,
    0,
    "the refusal must land before injection — nothing may run in any frame",
  );
  return err;
}

describe("frame reference routing", () => {
  it("refuses two refs from different child frames, instead of resolving both in one", async () => {
    const driver = loadDriver();
    try {
      // The reproduction: `f4:e1a2` used to be looked up inside frame 3, where a
      // same-named element answered to it and got dragged onto.
      await refuses(
        () => driver.exports.drag(1, { startRef: "f3:e9c4", endRef: "f4:e1a2" }),
        driver.injections,
        /same frame/,
      );
    } finally {
      driver.dispose();
    }
  });

  it("names both offending refs so the caller can see which one to change", async () => {
    const driver = loadDriver();
    try {
      const err = await refuses(
        () => driver.exports.drag(1, { startRef: "f3:e9c4", endRef: "f4:e1a2" }),
        driver.injections,
        /same frame/,
      );
      assert.match(err.message, /"f3:e9c4"/);
      assert.match(err.message, /"f4:e1a2"/);
    } finally {
      driver.dispose();
    }
  });

  it("treats a bare ref as the top page, not as a wildcard that joins a frame", async () => {
    const driver = loadDriver();
    try {
      // The quietest half of the bug: `e1a2` alone means the top document, so
      // pairing it with a frame ref is a mismatch — never a shorthand for
      // "whichever frame the other ref named".
      const err = await refuses(
        () => driver.exports.drag(1, { startRef: "e1a2", endRef: "f3:e9c4" }),
        driver.injections,
        /same frame/,
      );
      assert.match(err.message, /top page/);
    } finally {
      driver.dispose();
    }
  });

  it("refuses a child-frame ref paired with a top-page ref in either order", async () => {
    const driver = loadDriver();
    try {
      await refuses(
        () => driver.exports.drag(1, { startRef: "f3:e9c4", endRef: "e1a2" }),
        driver.injections,
        /same frame/,
      );
    } finally {
      driver.dispose();
    }
  });

  it("refuses a mixed-frame eval before running any of the caller's JavaScript", async () => {
    const driver = loadDriver();
    try {
      await refuses(
        () =>
          driver.exports.evaluate(1, {
            function: "(a, b) => a.textContent + b.textContent",
            args: ["f3:e9c4", "f4:e1a2"],
          }),
        driver.injections,
        /same frame/,
      );
    } finally {
      driver.dispose();
    }
  });

  it("refuses a malformed frame prefix rather than retargeting it at the top page", async () => {
    const driver = loadDriver();
    try {
      // Each of these has a colon and does not parse as `f<digits>:`. Before the
      // fix every one fell through to the top document as a literal ref, so a
      // mistyped frame number aimed the call at a different document in silence.
      for (const ref of ["f3:", "fx:e1a2", "f:e1a2", "frame3:e1a2", ":e1a2", "f-1:e1a2"]) {
        const err = await refuses(
          () => driver.exports.click(1, { ref, waitUntil: "none" }),
          driver.injections,
          /not a usable element ref/,
        );
        assert.match(err.message, /browser_snapshot/, `${ref} should say how to get a good ref`);
      }
    } finally {
      driver.dispose();
    }
  });

  it("refuses a malformed prefix on every ref-taking tool, not just click", async () => {
    const driver = loadDriver();
    try {
      await refuses(
        () => driver.exports.hover(1, { ref: "fx:e1a2" }),
        driver.injections,
        /not a usable element ref/,
      );
      await refuses(
        () => driver.exports.type(1, { ref: "fx:e1a2", text: "hi", waitUntil: "none" }),
        driver.injections,
        /not a usable element ref/,
      );
      await refuses(
        () => driver.exports.selectOption(1, { ref: "fx:e1a2", values: ["one"] }),
        driver.injections,
        /not a usable element ref/,
      );
    } finally {
      driver.dispose();
    }
  });

  it("still runs a same-frame pair, in that frame, with the prefix stripped", async () => {
    const driver = loadDriver();
    try {
      await driver.exports.drag(1, { startRef: "f3:e9c4", endRef: "f3:e1a2" });
      assert.equal(driver.injections.length, 1, "one injection, not one per ref");
      assert.equal(driver.injections[0]!.frameId, 3, "the op must run inside frame 3");
      assert.deepEqual(
        own(driver.injections[0]!.refs),
        ["e9c4", "e1a2"],
        "the frame prefix is stripped at the injection boundary, in order",
      );
    } finally {
      driver.dispose();
    }
  });

  it("still runs a bare-ref pair in the top frame, as every pre-frame caller meant", async () => {
    const driver = loadDriver();
    try {
      await driver.exports.drag(1, { startRef: "e9c4", endRef: "e1a2" });
      assert.equal(driver.injections[0]!.frameId, 0);
      assert.deepEqual(own(driver.injections[0]!.refs), ["e9c4", "e1a2"]);
    } finally {
      driver.dispose();
    }
  });

  it("still runs an eval with no refs at all, which names no frame", async () => {
    const driver = loadDriver({ ok: true, value: "Example" });
    try {
      const value = await driver.exports.evaluate(1, { expression: "document.title" });
      assert.equal(value, "Example");
      assert.equal(driver.injections[0]!.frameId, 0);
    } finally {
      driver.dispose();
    }
  });

  it("parses a well-formed ref exactly as before", async () => {
    const driver = loadDriver();
    try {
      assert.deepEqual(own(driver.exports.parseRef("f3:e9c4")), { frameId: 3, bare: "e9c4" });
      assert.deepEqual(own(driver.exports.parseRef("e9c4")), { frameId: 0, bare: "e9c4" });
      // The disambiguator a colliding signature adds is still part of the bare ref.
      assert.deepEqual(own(driver.exports.parseRef("f12:e9c4.1")), { frameId: 12, bare: "e9c4.1" });
    } finally {
      driver.dispose();
    }
  });
});
