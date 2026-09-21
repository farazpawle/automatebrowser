/**
 * The accessibility report (D8). Four properties carry the feature:
 *
 *  - **Worst first, at both scales.** The extension sorts violations worst-LAST
 *    because `paginate` serves the TAIL as page 1; the renderer then reverses
 *    within the page. Two inversions that cancel — get either one backwards and
 *    the agent is handed `minor` findings while `critical` ones sit on a page it
 *    never asks for, and every check still passes. This is the one that needed
 *    pinning.
 *  - **The floor sentence is unconditional.** It is most needed on the clean
 *    result, which is exactly where a "caveat on failure" would omit it.
 *  - **The element count is the TRUE count**, not the number of examples shown.
 *  - **A ref appears when there is one and is silently absent when not** — a
 *    finding is never dropped for being unaddressable.
 *
 * Pure string building, so nothing here needs a browser, a relay or axe itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderA11y, type A11yResult, type A11yViolation } from "@/tools/issues";

/** One violation, worst-last ordering applied by the caller. */
const rule = (id: string, impact: string, nodeCount = 1): A11yViolation => ({
  id,
  impact,
  help: `${id} help text`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
  nodeCount,
  nodes: [{ ref: "eab12", target: `#${id}`, html: `<div id="${id}">` }],
});

/** The extension's contract: ascending severity, so the worst sorts last. */
const result = (violations: A11yViolation[], over: Partial<A11yResult> = {}): A11yResult => ({
  violations,
  passed: 40,
  incomplete: 0,
  version: "4.13.0",
  ...over,
});

describe("renderA11y", () => {
  it("prints the worst impact first within a page", () => {
    const text = renderA11y(
      result([rule("minor-one", "minor"), rule("crit-one", "critical")]),
      undefined,
    );
    assert.ok(text.indexOf("crit-one") < text.indexOf("minor-one"), `critical must lead:\n${text}`);
  });

  it("puts the worst findings on page 1, which is the page nobody has to ask for", () => {
    // 25 rules, page size 20: page 1 is the tail of the ascending list — the 20
    // WORST — and page 2 holds the 5 least severe.
    const many = [
      ...Array.from({ length: 5 }, (_, i) => rule(`least-${i}`, "minor")),
      ...Array.from({ length: 20 }, (_, i) => rule(`worst-${i}`, "critical")),
    ];
    const page1 = renderA11y(result(many), undefined);
    assert.ok(page1.includes("worst-0"), "page 1 must carry the critical rules");
    assert.ok(!page1.includes("least-0"), `page 1 must not carry the minor rules:\n${page1}`);
    assert.match(page1, /page 1\/2 of 25 failing rules, most severe first/);
    assert.match(page1, /Less severe: browser_issues \{"audit":"a11y","page":2\}/);

    const page2 = renderA11y(result(many), 2);
    assert.ok(page2.includes("least-0"), "page 2 must carry the minor rules");
    assert.match(page2, /This is the least severe page/);
  });

  it("serves an out-of-range page as page 1 and says the page did not exist", () => {
    const many = Array.from({ length: 25 }, (_, i) => rule(`r-${i}`, "serious"));
    const text = renderA11y(result(many), 9);
    assert.match(text, /page 9 does not exist, so this is page 1\/2/);
  });

  it("states the floor even when nothing failed", () => {
    const text = renderA11y(result([]), undefined);
    assert.match(text, /No accessibility violations found \(axe-core 4\.13\.0, 40 rules passed\)/);
    assert.match(text, /roughly a third of real accessibility barriers/);
    assert.match(text, /a floor, not a pass/);
  });

  it("reports the true element count, not the number of examples shown", () => {
    // The extension caps examples at 5 per rule; the count must still be 300, or
    // a one-token styling bug reads as a one-element problem.
    const text = renderA11y(result([rule("color-contrast", "serious", 300)]), undefined);
    assert.match(text, /color-contrast .* \(300 elements\)/);
    assert.match(text, /\(\+299 more elements, same rule\)/);
  });

  it("says 'element' for one and 'elements' for more", () => {
    assert.match(
      renderA11y(result([rule("image-alt", "critical", 1)]), undefined),
      /\(1 element\)/,
    );
    assert.match(
      renderA11y(result([rule("image-alt", "critical", 2)]), undefined),
      /\(2 elements\)/,
    );
  });

  it("shows the ref when the element carries one and omits it cleanly when not", () => {
    const withRef = renderA11y(result([rule("label", "critical")]), undefined);
    assert.match(withRef, /eab12 {2}#label/);

    const bare = rule("label", "critical");
    bare.nodes = [{ target: "#label", html: "<div>" }];
    const withoutRef = renderA11y(result([bare]), undefined);
    assert.ok(withoutRef.includes("#label"), "the finding survives without a ref");
    assert.ok(!withoutRef.includes("eab12"), "no stale ref leaks in");
  });

  it("counts the undecided separately from the failed", () => {
    const text = renderA11y(result([], { incomplete: 7 }), undefined);
    assert.match(text, /7 rules need human review/);
  });

  it("does not print a paging footer when everything fitted on one page", () => {
    const text = renderA11y(result([rule("image-alt", "critical")]), undefined);
    assert.ok(!/page 1\/1/.test(text), `no footer for a single page:\n${text}`);
  });
});
