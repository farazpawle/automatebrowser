/**
 * B05, server half — WHICH browser the deny-list actually reaches.
 *
 * The bug was a single module-scoped boolean: the first browser to be driven set
 * it, and every browser selected afterwards was skipped. The tool gate still
 * refused calls aimed at a denied origin, so nothing looked broken — but the
 * network half was missing on browser B, and that half exists precisely because
 * the tool gate cannot see a `fetch()` the page makes on its own.
 *
 * What these hold to:
 *
 *   - every browser this server drives gets the rules, not just the first;
 *   - a browser that already has THIS policy is not asked again;
 *   - a changed deny-list reinstalls rather than riding on the old confirmation;
 *   - a reconnect (same browser, new relay id) revalidates, because nothing the
 *     server can see proves the rules survived it;
 *   - a failed install is retried on the next call and never latched — on that
 *     browser or on any other;
 *   - an extension that installs fewer rules than we asked for is not treated as
 *     protected, while one too old to report the count still is.
 *
 * Each case uses its own relay id where it can, because acknowledgements are
 * process-wide by design — that is what lets a second call skip a needless
 * install — and a shared id would make these pass or fail in file order.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Context } from "@/context";
import type { Fake } from "./helpers/policy-harness";

import { attempt, fakeContext, stubTool } from "./helpers/policy-harness";
import { DENY_ENV, resetPolicyCache } from "@/utils/origins";

const DENIED = "https://*.tracker.example";
const ALLOWED_PAGE = "https://safe.example/page";

/** Payloads of every net-policy push a case made, in order. */
interface Push {
  browserId?: string;
  deny: string[];
  owner?: string;
}

interface Rig extends Fake {
  pushes: Push[];
  /** How the extension answers the next push: `undefined` throws. */
  answer: { mine?: number } | undefined;
}

/**
 * A context whose net-policy pushes are recorded rather than sent, and whose
 * browser can be swapped the way `browser_select_client` swaps it.
 */
function rig(browserId: string): Rig {
  const f = fakeContext(ALLOWED_PAGE) as Rig;
  f.browserId = browserId;
  f.pushes = [];
  f.answer = { mine: 1 };
  const base = f.context as unknown as Record<string, unknown>;
  f.context = {
    ...base,
    sendSocketMessage: async (type: string, payload: unknown, options?: { browserId?: string }) => {
      f.sent.push(type);
      if (type === "getUrl") return ALLOWED_PAGE;
      if (type === "browser_net_policy") {
        const p = payload as { deny: string[]; owner?: string };
        f.pushes.push({ browserId: options?.browserId, deny: p.deny, owner: p.owner });
        if (!f.answer) throw new Error("extension unreachable");
        return f.answer;
      }
      return {};
    },
  } as unknown as Context;
  return f;
}

/** Drive one gated, mutating call through the whole gate. */
async function drive(f: Rig): Promise<void> {
  const tool = stubTool("browser_click");
  const result = await attempt(f, tool, { element: "the button", ref: "e1" });
  assert.equal(result.refused, false, `the call should have been allowed: ${result.message}`);
}

function withDeny(patterns: string): void {
  process.env[DENY_ENV] = patterns;
  resetPolicyCache();
}

afterEach(() => {
  delete process.env[DENY_ENV];
  resetPolicyCache();
});

describe("net policy — one server, several browsers", () => {
  it("installs on the second browser after the selection changes", async () => {
    withDeny(DENIED);
    const f = rig("browser-A");
    await drive(f);
    assert.equal(f.pushes.length, 1, "browser A should have been given the rules");

    // What `browser_select_client` does: the same server, a different browser.
    f.browserId = "browser-B";
    await drive(f);

    assert.deepEqual(
      f.pushes.map((p) => p.browserId),
      ["browser-A", "browser-B"],
      "the second browser must get the deny-list too",
    );
  });

  it("pins each push to the browser it was resolved for", async () => {
    withDeny(DENIED);
    const f = rig("browser-pinned");
    await drive(f);
    assert.equal(
      f.pushes[0]?.browserId,
      "browser-pinned",
      "an unpinned push could be answered by a browser the acknowledgement is not filed under",
    );
  });

  it("does not ask the same browser twice for the same policy", async () => {
    withDeny(DENIED);
    const f = rig("browser-repeat");
    await drive(f);
    await drive(f);
    await drive(f);
    assert.equal(f.pushes.length, 1, "a confirmed policy must not be reinstalled every call");
  });

  it("reinstalls when the deny-list itself changes", async () => {
    withDeny(DENIED);
    const f = rig("browser-changed");
    await drive(f);

    withDeny("https://*.tracker.example,https://ads.example");
    f.answer = { mine: 2 };
    await drive(f);

    assert.equal(f.pushes.length, 2);
    assert.deepEqual(f.pushes[1]?.deny, ["tracker.example", "ads.example"]);
  });

  it("does not reinstall when the same policy is merely spelled differently", async () => {
    withDeny("https://ads.example,https://*.tracker.example");
    const f = rig("browser-reordered");
    f.answer = { mine: 2 };
    await drive(f);

    withDeny("https://*.tracker.example,https://ads.example/path");
    await drive(f);

    assert.equal(f.pushes.length, 1, "the same domains in another order are the same policy");
  });

  it("revalidates after a reconnect brings the browser back under a new id", async () => {
    withDeny(DENIED);
    const f = rig("browser-before-reconnect");
    await drive(f);

    // A relay id belongs to a socket. The same browser, reconnected, is a new
    // one — and whether its dynamic rules survived is not something the server
    // can see from here.
    f.browserId = "browser-after-reconnect";
    await drive(f);

    assert.equal(f.pushes.length, 2, "an unverified acknowledgement must not be reused");
  });

  it("names the controller that owns the deny-list", async () => {
    withDeny(DENIED);
    const f = rig("browser-owner");
    await drive(f);
    assert.equal(
      f.pushes[0]?.owner,
      "test",
      "without an owner the extension cannot tell a replacement from a clobber",
    );
  });

  it("sends nothing when no policy is configured", async () => {
    const f = rig("browser-unset");
    await drive(f);
    assert.deepEqual(f.pushes, []);
    assert.deepEqual(f.sent, [], "not one extra byte crosses the wire — no probe, no push");
  });
});

describe("net policy — a failed install is never latched", () => {
  it("retries on the next call after the push throws", async () => {
    withDeny(DENIED);
    const f = rig("browser-flaky");
    f.answer = undefined; // the push throws, the way a timeout does
    await drive(f);
    assert.equal(f.pushes.length, 1);

    f.answer = { mine: 1 };
    await drive(f);
    assert.equal(f.pushes.length, 2, "a failure must be retried, not remembered as a success");

    await drive(f);
    assert.equal(f.pushes.length, 2, "and once it succeeds, it stops being retried");
  });

  it("lets the action through when the rules cannot be installed", async () => {
    // The tool gate is doing its job; refusing every call because the network
    // half is unavailable would brick a server whose policy is being enforced.
    withDeny(DENIED);
    const f = rig("browser-old-extension");
    f.answer = undefined;
    const tool = stubTool("browser_click");
    const result = await attempt(f, tool, { element: "the button", ref: "e1" });
    assert.equal(result.refused, false);
    assert.equal(tool.ran, true);
  });

  it("does not record protection when the extension installed fewer rules than asked", async () => {
    withDeny("https://*.tracker.example,https://ads.example");
    const f = rig("browser-partial");
    f.answer = { mine: 1 }; // two were asked for
    await drive(f);
    await drive(f);
    assert.equal(f.pushes.length, 2, "a partial install must be retried");
  });

  it("accepts an older extension that reports no per-owner count", async () => {
    withDeny(DENIED);
    const f = rig("browser-no-count");
    f.answer = {}; // pre-B05 extension: `{ installed }` only
    await drive(f);
    await drive(f);
    assert.equal(f.pushes.length, 1, "the documented capability limit is not a failure");
  });
});
