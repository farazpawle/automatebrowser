/**
 * D17's screenshot size ceiling — the half of it that can be tested without a
 * browser.
 *
 * The resize itself lives in the extension, where `OffscreenCanvas` can do it
 * before the bytes cross the socket. What is testable here is the POLICY: which
 * numbers the server sends, and what it does with a value someone typed wrong.
 * That is where the dangerous failure lives — a ceiling that silently reads as
 * "no limit" restores exactly the unbounded capture this item exists to stop,
 * and nothing in the reply would say so.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { MAX_HEIGHT_ENV, MAX_WIDTH_ENV, screenshotCeiling } from "@/tools/custom";

/** Set both vars for one assertion; `undefined` deletes. */
function withEnv(width?: string, height?: string) {
  if (width === undefined) delete process.env[MAX_WIDTH_ENV];
  else process.env[MAX_WIDTH_ENV] = width;
  if (height === undefined) delete process.env[MAX_HEIGHT_ENV];
  else process.env[MAX_HEIGHT_ENV] = height;
}

afterEach(() => withEnv(undefined, undefined));

describe("screenshotCeiling", () => {
  it("defaults to the measured 1536x4096 box", () => {
    withEnv(undefined, undefined);
    assert.deepEqual(screenshotCeiling(), { maxWidth: 1536, maxHeight: 4096 });
  });

  it("takes both overrides", () => {
    withEnv("800", "600");
    assert.deepEqual(screenshotCeiling(), { maxWidth: 800, maxHeight: 600 });
  });

  it("lets each half be switched off independently with 0", () => {
    withEnv("0", undefined);
    assert.deepEqual(screenshotCeiling(), { maxWidth: 0, maxHeight: 4096 });
    withEnv(undefined, "0");
    assert.deepEqual(screenshotCeiling(), { maxWidth: 1536, maxHeight: 0 });
  });

  it("falls back to the default — never to unlimited — on a value it cannot use", () => {
    // The security-shaped property: every one of these is a typo, and a typo
    // that read as 0 would uncap the capture without saying anything.
    for (const bad of ["", "  ", "wide", "-1", "1536px", "1e3x", "NaN", "1536.5"]) {
      withEnv(bad, bad);
      assert.deepEqual(
        screenshotCeiling(),
        { maxWidth: 1536, maxHeight: 4096 },
        `${JSON.stringify(bad)} should fall back to the default`,
      );
    }
  });

  it("is read fresh every call, so a change mid-process takes effect", () => {
    withEnv("1000", "1000");
    assert.equal(screenshotCeiling().maxWidth, 1000);
    withEnv("2000", "2000");
    assert.equal(screenshotCeiling().maxWidth, 2000);
  });
});

/**
 * The scale the extension applies, restated here as the contract the defaults
 * were chosen against. This is not the extension's code — it is the arithmetic
 * the defaults are only defensible under, pinned so that changing one of the two
 * numbers has to face the consequence.
 */
function fit(w: number, h: number, mw: number, mh: number) {
  const scale = Math.min(1, mw ? mw / w : 1, mh ? mh / h : 1);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

describe("the default box, against real captures measured on 2026-09-09", () => {
  const { maxWidth, maxHeight } = { maxWidth: 1536, maxHeight: 4096 };

  it("shrinks a 2K viewport on width alone", () => {
    assert.deepEqual(fit(2560, 1440, maxWidth, maxHeight), { width: 1536, height: 864 });
  });

  it("leaves a 2K full page legibly wide rather than squashing it", () => {
    // The whole reason the two defaults differ. At a matching 1536 height this
    // would come back 613 px wide, which is an unreadable picture of a page.
    assert.deepEqual(fit(2545, 6362, maxWidth, maxHeight), { width: 1536, height: 3840 });
  });

  it("never enlarges an element crop that is already small", () => {
    assert.deepEqual(fit(450, 225, maxWidth, maxHeight), { width: 450, height: 225 });
  });

  it("trades width for length only once a page is taller than the height ceiling allows", () => {
    assert.deepEqual(fit(2545, 20000, maxWidth, maxHeight), { width: 521, height: 4096 });
  });

  it("returns the capture untouched with both halves off", () => {
    assert.deepEqual(fit(2545, 6362, 0, 0), { width: 2545, height: 6362 });
  });
});
