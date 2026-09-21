/**
 * Paging for the console and network logs (D1). Three properties are
 * load-bearing:
 *
 *  - Page 1 is the NEWEST slice. Both tools returned "the most recent N" before
 *    paging existed, so an omitted `page` has to return that same tail — page 1
 *    meaning "oldest" would silently change every existing caller's result.
 *  - An out-of-range page is served, not refused. It comes back as page 1 with
 *    `clamped` set, so the renderer can say the page did not exist rather than
 *    handing back an empty list the agent has to interpret.
 *  - An empty log is one page, not zero. Otherwise page 1 of a quiet tab would
 *    report itself as out of range.
 *
 * `paginate` is pure, so nothing here needs a browser, a relay or a socket.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paginate, pageFooter } from "@/utils/paginate";

/** 1..n, so a slice's contents name the positions it came from. */
const seq = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("paginate", () => {
  it("serves the newest slice as page 1", () => {
    const p = paginate(seq(120), undefined, 50);
    assert.deepEqual(p.items, seq(120).slice(70));
    assert.equal(p.page, 1);
    assert.equal(p.totalPages, 3);
    assert.equal(p.total, 120);
    assert.equal(p.hasNext, true);
    assert.equal(p.clamped, undefined);
  });

  it("walks backwards in time on higher pages", () => {
    const p = paginate(seq(120), 2, 50);
    assert.deepEqual(p.items, seq(120).slice(20, 70));
    assert.equal(p.hasNext, true);
  });

  it("gives the last page the remainder, not a padded slice", () => {
    const p = paginate(seq(120), 3, 50);
    assert.deepEqual(p.items, seq(20));
    assert.equal(p.items.length, 20);
    assert.equal(p.hasNext, false);
  });

  it("treats a log that fits as a single page with no next", () => {
    const p = paginate(seq(12), undefined, 50);
    assert.deepEqual(p.items, seq(12));
    assert.equal(p.totalPages, 1);
    assert.equal(p.hasNext, false);
  });

  it("treats an exact multiple as whole pages, with no empty page beyond", () => {
    const p = paginate(seq(100), 2, 50);
    assert.deepEqual(p.items, seq(50));
    assert.equal(p.totalPages, 2);
    assert.equal(p.hasNext, false);
  });

  it("reports an empty log as one empty page, never out of range", () => {
    const p = paginate([], undefined, 50);
    assert.deepEqual(p.items, []);
    assert.equal(p.page, 1);
    assert.equal(p.totalPages, 1);
    assert.equal(p.total, 0);
    assert.equal(p.hasNext, false);
    assert.equal(p.clamped, undefined);
  });

  it("serves page 1 and records what was asked for when the page is past the end", () => {
    const p = paginate(seq(120), 9, 50);
    assert.equal(p.page, 1);
    assert.equal(p.clamped, 9);
    assert.deepEqual(p.items, seq(120).slice(70), "clamped result is a real page 1");
    assert.equal(p.hasNext, true);
  });

  it("falls back to page 1 for a value the schema would have rejected", () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      const p = paginate(seq(60), bad, 50);
      assert.equal(p.page, 1, `page ${bad}`);
      assert.equal(p.clamped, undefined, `page ${bad} is not "past the end"`);
    }
  });
});

describe("pageFooter", () => {
  it("says nothing when everything fitted on one page", () => {
    assert.equal(pageFooter(paginate(seq(12), undefined, 50), "t", "entries"), "");
  });

  it("names the exact next call while older pages remain", () => {
    const text = pageFooter(paginate(seq(120), 1, 50), "browser_network_requests", "requests");
    assert.match(text, /page 1\/3 of 120 requests/);
    assert.match(text, /Older: browser_network_requests \{"page":2\}/);
  });

  it("says the oldest page is the oldest instead of offering a next call", () => {
    const text = pageFooter(paginate(seq(120), 3, 50), "browser_network_requests", "requests");
    assert.match(text, /oldest page/);
    assert.doesNotMatch(text, /"page":4/);
  });

  it("says the requested page did not exist rather than going silent", () => {
    const text = pageFooter(paginate(seq(120), 9, 50), "browser_get_console_logs", "entries");
    assert.match(text, /page 9 does not exist/);
    assert.match(text, /page 1\/3/);
  });
});
