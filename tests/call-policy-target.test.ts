/**
 * B02 — the safety gate must judge where a call ACTUALLY goes, never an address
 * the caller merely attached to the request.
 *
 * The bug: the gate read `args.url` off the raw request for every tool, so
 * `browser_click { element, ref, url: "https://app.test" }` was authorised on the
 * allowed address and then clicked whatever denied page the tab was on. The
 * click's own parser discards the extra field — but only after the gate has
 * already believed it, which is the worst possible order.
 *
 * Driven through `callTool` with stub tools rather than by unit-testing a
 * predicate, for the same reason `no-eval.test.ts` is: the RULE can be perfect
 * while the call path never consults it, and it is the call path that ships.
 *
 * The sweep at the bottom is the part that survives future tools. It fails when a
 * NEW tool arrives that takes a `url`, until somebody says which kind it is —
 * a destination the call goes to, a filter it matches against, or a tab-management
 * tool the gate deliberately exempts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { categoryOf, selectTools } from "@/tools/registry";
import {
  allowOnly,
  attempt,
  clearPolicy,
  fakeContext as fake,
  stubTool as stub,
} from "./helpers/policy-harness";

/** The one origin the operator allowed, and a page that is not it. */
const ALLOWED = "https://app.test";
const DENIED_PAGE = "https://bank.example.com/accounts";

afterEach(clearPolicy);

describe("B02 — an attached url cannot authorise the page a call really acts on", () => {
  it("refuses a click on a denied page that carries an allowed url", async () => {
    allowOnly(ALLOWED);
    const f = fake(DENIED_PAGE);
    const click = stub("browser_click");

    const r = await attempt(f, click, {
      element: "the transfer button",
      ref: "e1",
      url: `${ALLOWED}/harmless`,
    });

    assert.equal(r.refused, true, "the forged url must not authorise this");
    assert.equal(r.code, "ORIGIN_BLOCKED");
    assert.match(r.message, /bank\.example\.com/, "it is judged on the page, not the argument");
    assert.equal(click.ran, false, "nothing may reach the page");
  });

  it("still asks the browser where it is, rather than trusting the argument", async () => {
    allowOnly(ALLOWED);
    const f = fake(DENIED_PAGE);
    await attempt(f, stub("browser_click"), { element: "b", ref: "e1", url: ALLOWED });
    assert.deepEqual(f.sent, ["getUrl"], "the probe is the whole point");
  });

  it("lets the identical click through on an allowed page — the negative control", async () => {
    allowOnly(ALLOWED);
    const f = fake(`${ALLOWED}/dashboard`);
    const click = stub("browser_click");

    const r = await attempt(f, click, { element: "the button", ref: "e1" });

    assert.equal(r.refused, false, r.message);
    assert.equal(click.ran, true);
  });

  it("refuses a read too — a forged url is not a read/write distinction", async () => {
    allowOnly(ALLOWED);
    const f = fake(DENIED_PAGE);
    const read = stub("browser_read_page", true);

    const r = await attempt(f, read, { url: ALLOWED });

    assert.equal(r.refused, true);
    assert.equal(read.ran, false);
  });

  it("treats a url filter as a filter, not as a destination", async () => {
    // `browser_get_network_request { url }` matches a SUBSTRING against requests
    // already captured. It is not somewhere the tool goes, so it cannot nominate
    // the origin the call is judged against.
    allowOnly(ALLOWED);
    const f = fake(DENIED_PAGE);
    const netReq = stub("browser_get_network_request");

    const r = await attempt(f, netReq, { url: ALLOWED });

    assert.equal(r.refused, true, "a filter must not grant authority");
    assert.match(r.message, /bank\.example\.com/);
    assert.equal(netReq.ran, false);
  });
});

describe("B02 — a declared destination is still judged on that destination", () => {
  it("allows a navigation to an allowed origin from a denied page, with no probe", async () => {
    allowOnly(ALLOWED);
    const f = fake(DENIED_PAGE);
    const nav = stub("browser_navigate");

    const r = await attempt(f, nav, { url: `${ALLOWED}/login` });

    assert.equal(r.refused, false, r.message);
    assert.equal(nav.ran, true, "leaving a denied page for an allowed one is the point");
    assert.deepEqual(f.sent, [], "a declared destination needs no round-trip to judge");
  });

  it("refuses a navigation to a non-allowed origin from an allowed page", async () => {
    allowOnly(ALLOWED);
    const f = fake(`${ALLOWED}/dashboard`);
    const nav = stub("browser_navigate");

    const r = await attempt(f, nav, { url: "https://evil.example.com/" });

    assert.equal(r.refused, true);
    assert.equal(r.code, "ORIGIN_BLOCKED");
    assert.equal(nav.ran, false);
  });

  it("judges browser_perf_field_data on the address it asks about", async () => {
    // It drives no page at all — it queries the CrUX API about a URL — so that
    // URL is the subject of the call and the right thing to judge.
    allowOnly(ALLOWED);
    const f = fake(`${ALLOWED}/dashboard`);
    const field = stub("browser_perf_field_data", true);

    assert.equal((await attempt(f, field, { url: `${ALLOWED}/p` })).refused, false);
    field.ran = false;
    const off = await attempt(f, field, { url: "https://elsewhere.example.com/p" });
    assert.equal(off.refused, true);
    assert.equal(field.ran, false);
  });

  it("falls back to the probe when the declared destination is blank or not a string", async () => {
    // A reload carries no url; an empty or non-string one must not read as "no
    // policy applies", it must mean "ask where this tab is".
    allowOnly(ALLOWED);
    for (const args of [{ reload: true }, { url: "   " }, { url: 123 }, { url: "" }]) {
      const f = fake(DENIED_PAGE);
      const nav = stub("browser_navigate");
      const r = await attempt(f, nav, args as Record<string, unknown>);
      assert.equal(r.refused, true, JSON.stringify(args));
      assert.deepEqual(f.sent, ["getUrl"], JSON.stringify(args));
      assert.equal(nav.ran, false, JSON.stringify(args));
    }
  });
});

describe("B02 — the probe and the action must land on the same tab", () => {
  it("refuses when the drive target moves between the check and the action", async () => {
    allowOnly(ALLOWED);
    // Another call selected a different browser while the probe was in flight.
    const f = fake(`${ALLOWED}/dashboard`, { browser: 'chrome "B" [bbbbbbbb]', tabId: 9 });
    const click = stub("browser_click");

    const r = await attempt(f, click, { element: "b", ref: "e1" });

    assert.equal(r.refused, true, "a verdict about tab 7 cannot license tab 9");
    assert.equal(r.code, "ORIGIN_BLOCKED");
    assert.match(r.message, /moved between the safety check and the action/);
    assert.equal(click.ran, false);
  });

  it("refuses when only the tab changed, browser unchanged", async () => {
    allowOnly(ALLOWED);
    const f = fake(`${ALLOWED}/dashboard`, { browser: 'chrome "A" [aaaaaaaa]', tabId: 8 });
    const click = stub("browser_click");
    assert.equal((await attempt(f, click, { element: "b", ref: "e1" })).refused, true);
    assert.equal(click.ran, false);
  });

  it("accepts a target the gate learned DURING the probe — the first call", async () => {
    // The probe's own claiming send is what provisions this controller's tab, so
    // "unknown, then known" is the normal first call and not a mismatch.
    allowOnly(ALLOWED);
    const f = fake(`${ALLOWED}/dashboard`);
    f.target = {};
    const click = stub("browser_click");
    const r = await attempt(f, click, { element: "b", ref: "e1" });
    assert.equal(r.refused, false, r.message);
    assert.equal(click.ran, true);
  });

  it("costs nothing when no policy is configured", async () => {
    clearPolicy();
    const f = fake(`${ALLOWED}/dashboard`, { browser: "other", tabId: 99 });
    const click = stub("browser_click");
    const r = await attempt(f, click, { element: "b", ref: "e1" });
    assert.equal(r.refused, false, "no policy means no probe and nothing to compare");
    assert.deepEqual(f.sent, []);
    assert.equal(click.ran, true);
  });
});

/**
 * Every registered tool that takes a `url`, and what that `url` MEANS. A tool
 * missing from here fails the sweep below — which is the point: the next tool
 * with a `url` argument gets classified on purpose rather than by whichever
 * branch it happens to fall into.
 */
const URL_ARG_KIND: Record<string, "destination" | "filter" | "ungated"> = {
  // Where the call is going.
  browser_navigate: "destination",
  // The address the CrUX API is asked about; drives no page.
  browser_perf_field_data: "destination",
  // A substring matched against already-captured requests.
  browser_get_network_request: "filter",
  // Tab management, exempt from the gate entirely so an agent is never stranded.
  browser_new_tab: "ungated",
  browser_select_tab: "ungated",
};

describe("B02 — every url argument in the registry is classified", () => {
  /** Tools whose input schema declares a top-level `url`. */
  const urlTools = selectTools()
    .tools.filter((t) => {
      const s = t.schema.inputSchema as { properties?: Record<string, unknown> };
      return !!s?.properties && Object.prototype.hasOwnProperty.call(s.properties, "url");
    })
    .map((t) => t.schema.name);

  it("finds the url-taking tools it expects to find", () => {
    assert.ok(urlTools.length >= 5, "the registry should still have url-taking tools");
    assert.deepEqual(
      [...urlTools].sort(),
      Object.keys(URL_ARG_KIND).sort(),
      "a tool gained or lost a `url` argument — classify it in URL_ARG_KIND, then make " +
        "sure call.ts agrees: a destination belongs in TARGET_URL_ARG, a filter does not.",
    );
  });

  it("lets only a destination speak for the origin", async () => {
    allowOnly(ALLOWED);
    for (const name of urlTools) {
      const kind = URL_ARG_KIND[name];
      const f = fake(DENIED_PAGE);
      const tool = stub(name);
      const r = await attempt(f, tool, { url: `${ALLOWED}/x` });

      if (kind === "filter") {
        assert.equal(r.refused, true, `${name}: a filter must not authorise the denied page`);
        assert.equal(tool.ran, false, name);
      } else {
        assert.equal(r.refused, false, `${name}: ${r.message}`);
        assert.equal(tool.ran, true, name);
      }
    }
  });

  it("classifies every ungated entry as a tool the gate really does exempt", () => {
    for (const [name, kind] of Object.entries(URL_ARG_KIND)) {
      const exempt = ["clients", "tabs"].includes(categoryOf(name) ?? "");
      assert.equal(exempt, kind === "ungated", `${name} is in category ${categoryOf(name)}`);
    }
  });
});
