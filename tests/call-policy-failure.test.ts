/**
 * B03 — read-only mode must survive everything that can go wrong with the origin
 * probe, because read-only has nothing to do with where the tab is.
 *
 * The bug: the read-only rule lived inside `judge`, at the END of the gate, and
 * two shortcuts returned before ever reaching it —
 *
 *   - no browser connected yet, so there was nothing to probe;
 *   - the probe threw, with only a deny-list configured (an unknown location is
 *     not a refusal when nothing is required to be on an allow-list).
 *
 * Both are perfectly reasonable places to stop asking WHERE the call is. Neither
 * is a reason to stop asking WHETHER a page-changing tool may run at all. With
 * `AUTOMATE_BROWSER_READ_ONLY=1` and a deny-list set, a click went through after
 * `getUrl` threw.
 *
 * The matrix at the bottom exists because the fix is an ORDERING change, and an
 * ordering change is exactly the kind that fixes one combination while breaking
 * another: every pairing of read-only, allow-list, deny-list and no-eval is run
 * against a working probe, a throwing probe, a malformed probe, and no browser.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { Context } from "@/context";

import { attempt, fakeContext, stubTool } from "./helpers/policy-harness";
import { ALLOW_ENV, DENY_ENV, NO_EVAL_ENV, READ_ONLY_ENV, resetPolicyCache } from "@/utils/origins";

const DENIED = "https://bank.example.com";
const OTHER_PAGE = "https://anywhere.example.com/page";

/** Set exactly the variables a case names, and nothing else. */
function configure(env: Partial<Record<string, string>>): void {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  resetPolicyCache();
}

afterEach(() => {
  for (const k of [ALLOW_ENV, DENY_ENV, NO_EVAL_ENV, READ_ONLY_ENV]) delete process.env[k];
  resetPolicyCache();
});

/** A context whose origin probe throws, the way a timeout or a dead tab does. */
function probeThrows(): ReturnType<typeof fakeContext> {
  const f = fakeContext(OTHER_PAGE);
  f.context = {
    ...(f.context as unknown as Record<string, unknown>),
    sendSocketMessage: async (type: string) => {
      f.sent.push(type);
      if (type === "getUrl") throw new Error("timeout waiting for getUrl");
      return {};
    },
  } as unknown as Context;
  return f;
}

/** A context with no browser connected: the gate has nothing to probe. */
function noBrowser(): ReturnType<typeof fakeContext> {
  const f = fakeContext(OTHER_PAGE);
  f.context = {
    ...(f.context as unknown as Record<string, unknown>),
    hasClients: () => false,
  } as unknown as Context;
  return f;
}

/** A probe that answers with something that is not a usable address. */
function probeMalformed(value: unknown): ReturnType<typeof fakeContext> {
  const f = fakeContext(OTHER_PAGE);
  f.context = {
    ...(f.context as unknown as Record<string, unknown>),
    sendSocketMessage: async (type: string) => {
      f.sent.push(type);
      if (type === "getUrl") return value;
      return {};
    },
  } as unknown as Context;
  return f;
}

describe("B03 — read-only is decided before the probe, not after it", () => {
  it("refuses a mutating call when the probe throws and only a deny-list is set", async () => {
    // The exact reproduction. Deny-only means a failed probe is NOT a refusal on
    // origin grounds — and that shortcut used to carry the call past read-only.
    configure({ [READ_ONLY_ENV]: "1", [DENY_ENV]: DENIED });
    const f = probeThrows();
    const click = stubTool("browser_click");

    const r = await attempt(f, click, { element: "the button", ref: "e1" });

    assert.equal(r.refused, true, "a failed probe is not a licence to change the page");
    assert.equal(r.code, "READ_ONLY");
    assert.equal(click.ran, false);
  });

  it("refuses a mutating call before a browser has ever connected", async () => {
    configure({ [READ_ONLY_ENV]: "1", [DENY_ENV]: DENIED });
    const f = noBrowser();
    const click = stubTool("browser_click");

    const r = await attempt(f, click, { element: "the button", ref: "e1" });

    assert.equal(r.refused, true, "nothing to probe is not nothing to enforce");
    assert.equal(r.code, "READ_ONLY");
    assert.equal(click.ran, false);
  });

  it("refuses without spending a probe at all", async () => {
    // The answer never depended on the page, so paying 2 s to reach the same
    // refusal would be pure latency.
    configure({ [READ_ONLY_ENV]: "1", [ALLOW_ENV]: "https://anywhere.example.com" });
    const f = fakeContext(OTHER_PAGE);

    const r = await attempt(f, stubTool("browser_click"), { element: "b", ref: "e1" });

    assert.equal(r.refused, true);
    assert.deepEqual(f.sent, [], "read-only is settled without asking the browser anything");
  });

  it("refuses a navigation in read-only mode even to an allowed destination", async () => {
    configure({ [READ_ONLY_ENV]: "1", [ALLOW_ENV]: "https://anywhere.example.com" });
    const f = fakeContext(OTHER_PAGE);
    const nav = stubTool("browser_navigate");

    const r = await attempt(f, nav, { url: `${OTHER_PAGE}/next` });

    assert.equal(r.refused, true, "a declared destination does not exempt a page-changing tool");
    assert.equal(r.code, "READ_ONLY");
    assert.equal(nav.ran, false);
  });

  it("still lets reads through on every one of those failure paths", async () => {
    // The control that makes the four refusals above mean something: read-only
    // mode is not "refuse everything".
    configure({ [READ_ONLY_ENV]: "1", [DENY_ENV]: DENIED });
    for (const f of [probeThrows(), noBrowser(), fakeContext(OTHER_PAGE)]) {
      const read = stubTool("browser_read_page", true);
      const r = await attempt(f, read, {});
      assert.equal(r.refused, false, r.message);
      assert.equal(read.ran, true);
    }
  });

  it("keeps no-eval enforced on the same failure paths", async () => {
    // D16's switch was already decided before the probe. This asserts the B03
    // reordering did not disturb it.
    configure({ [NO_EVAL_ENV]: "1", [DENY_ENV]: DENIED });
    for (const f of [probeThrows(), noBrowser()]) {
      const evalTool = stubTool("browser_eval", true);
      const r = await attempt(f, evalTool, { expression: "document.title" });
      assert.equal(r.refused, true);
      assert.equal(r.code, "EVAL_BLOCKED");
      assert.equal(evalTool.ran, false);
    }
  });

  it("leaves the documented tab-management exemption alone", async () => {
    // Read-only mode is keyed off each tool's own annotation, and tab tools are
    // ungated entirely, so opening and closing tabs stays permitted. Changing
    // that here would be a silent policy change nobody asked for.
    configure({ [READ_ONLY_ENV]: "1" });
    for (const name of ["browser_new_tab", "browser_select_tab", "browser_close_tab"]) {
      const tool = stubTool(name);
      const r = await attempt(fakeContext(OTHER_PAGE), tool, {});
      assert.equal(r.refused, false, `${name}: ${r.message}`);
      assert.equal(tool.ran, true, name);
    }
  });
});

describe("B03 — a malformed probe answer is not an allowance", () => {
  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { url: "https://anywhere.example.com" }],
    ["an empty string", ""],
    ["not a URL at all", "not a url"],
  ] as const) {
    it(`refuses a mutating call with an allow-list when getUrl returns ${label}`, async () => {
      configure({ [ALLOW_ENV]: "https://anywhere.example.com" });
      const f = probeMalformed(value);
      const click = stubTool("browser_click");

      const r = await attempt(f, click, { element: "b", ref: "e1" });

      assert.equal(r.refused, true, `${label} must not read as an allowed origin`);
      assert.equal(click.ran, false, label);
    });
  }
});

/**
 * Every combination of the four settings against every probe outcome.
 *
 * `mutating: true` is a click; `false` is a page read. `expect` is what must
 * happen, and the cases where a read is allowed are as much of the point as the
 * refusals — an ordering fix that refused everything would pass a suite made
 * only of refusals.
 */
const PROBES = {
  works: () => fakeContext(OTHER_PAGE),
  throws: probeThrows,
  malformed: () => probeMalformed(undefined),
  noBrowser,
} as const;

type Case = {
  env: Partial<Record<string, string>>;
  probe: keyof typeof PROBES;
  mutating: boolean;
  refused: boolean;
  why: string;
};

const MATRIX: Case[] = [
  // Read-only, every probe outcome: a page change is refused, a read is not.
  ...(["works", "throws", "malformed", "noBrowser"] as const).flatMap<Case>((probe) => [
    {
      env: { [READ_ONLY_ENV]: "1" },
      probe,
      mutating: true,
      refused: true,
      why: "read-only refuses a page change however the probe went",
    },
    {
      env: { [READ_ONLY_ENV]: "1" },
      probe,
      mutating: false,
      refused: false,
      why: "read-only still allows reading",
    },
  ]),
  // Read-only combined with each origin list, on the failure paths that used to
  // skip it entirely.
  {
    env: { [READ_ONLY_ENV]: "1", [DENY_ENV]: DENIED },
    probe: "throws",
    mutating: true,
    refused: true,
    why: "the deny-only shortcut no longer returns past read-only",
  },
  {
    env: { [READ_ONLY_ENV]: "1", [ALLOW_ENV]: "https://anywhere.example.com" },
    probe: "throws",
    mutating: true,
    refused: true,
    why: "an allow-list refuses an unknown location anyway; read-only refuses first",
  },
  {
    env: { [READ_ONLY_ENV]: "1", [DENY_ENV]: DENIED },
    probe: "noBrowser",
    mutating: true,
    refused: true,
    why: "no browser yet is not an exemption",
  },
  // Without read-only, the pre-existing behaviour is unchanged: deny-only plus a
  // failed probe is NOT a refusal, and an allow-list plus a failed probe IS.
  {
    env: { [DENY_ENV]: DENIED },
    probe: "throws",
    mutating: true,
    refused: false,
    why: "deny-only keeps its documented behaviour on an unknown location",
  },
  {
    env: { [ALLOW_ENV]: "https://anywhere.example.com" },
    probe: "throws",
    mutating: true,
    refused: true,
    why: "an allow-list refuses rather than guessing",
  },
  {
    env: { [DENY_ENV]: DENIED },
    probe: "noBrowser",
    mutating: true,
    refused: false,
    why: "nothing can happen before a browser connects",
  },
  // The ordinary successful controls.
  {
    env: { [ALLOW_ENV]: "https://anywhere.example.com" },
    probe: "works",
    mutating: true,
    refused: false,
    why: "an allowed page is driveable",
  },
  {
    env: { [DENY_ENV]: DENIED },
    probe: "works",
    mutating: true,
    refused: false,
    why: "a page that is not denied is driveable",
  },
  // no-eval is orthogonal to all of it and must stay so.
  {
    env: { [NO_EVAL_ENV]: "1" },
    probe: "works",
    mutating: true,
    refused: false,
    why: "no-eval does not refuse a click",
  },
  {
    env: { [NO_EVAL_ENV]: "1", [READ_ONLY_ENV]: "1" },
    probe: "works",
    mutating: false,
    refused: false,
    why: "both switches on still leaves reading alone",
  },
];

describe("B03 — the policy combination matrix", () => {
  for (const c of MATRIX) {
    const names = Object.keys(c.env).join("+") || "nothing";
    const what = c.mutating ? "a click" : "a read";
    it(`${names}, probe ${c.probe}, ${what}: ${c.refused ? "refused" : "allowed"} — ${c.why}`, async () => {
      configure(c.env);
      const f = PROBES[c.probe]();
      const tool = stubTool(c.mutating ? "browser_click" : "browser_read_page", !c.mutating);

      const r = await attempt(f, tool, c.mutating ? { element: "b", ref: "e1" } : {});

      assert.equal(r.refused, c.refused, `${c.why} — got ${r.message}`);
      assert.equal(tool.ran, !c.refused, c.why);
    });
  }
});
