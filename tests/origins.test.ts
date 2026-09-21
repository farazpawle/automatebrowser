/**
 * B9's origin fence — the gate that decides which sites an agent may touch in a
 * real, logged-in browser. Every assertion here is a security property: a wrong
 * answer means an agent reaches a site the operator forbade, or is stranded on
 * one they allowed.
 *
 * `judge` is a pure function over an explicit policy, so none of this needs a
 * browser, a relay or an env var. The env-driven half (`policy`) is covered
 * separately, and resets the module cache between cases.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ALLOW_ENV,
  DENY_ENV,
  READ_ONLY_ENV,
  SENSITIVE_ENV,
  type OriginPolicy,
  denyDomains,
  describePolicy,
  judge,
  matchesAny,
  originOf,
  policy,
  resetPolicyCache,
} from "@/utils/origins";
import { selectTools } from "@/tools/registry";

const empty: OriginPolicy = { allow: [], deny: [], sensitive: [], readOnly: false, noEval: false };
const p = (over: Partial<OriginPolicy>): OriginPolicy => ({ ...empty, ...over });

describe("originOf", () => {
  it("keeps scheme, host and port, and drops the path", () => {
    assert.equal(originOf("https://example.com:8443/a/b?c=1"), "https://example.com:8443");
    assert.equal(originOf("http://localhost:3000/"), "http://localhost:3000");
  });

  it("refuses to invent an origin for anything that is not http(s)", () => {
    for (const url of [
      "chrome://settings",
      "about:blank",
      "file:///c:/x",
      "data:text/html,x",
      "not a url",
    ]) {
      assert.equal(originOf(url), undefined, url);
    }
  });
});

describe("matchesAny", () => {
  it("treats a bare host as any scheme", () => {
    assert.equal(matchesAny("https://example.com", ["example.com"]), true);
    assert.equal(matchesAny("http://example.com", ["example.com"]), true);
  });

  it("matches subdomain wildcards without matching the bare apex", () => {
    assert.equal(matchesAny("https://app.example.com", ["https://*.example.com"]), true);
    assert.equal(matchesAny("https://example.com", ["https://*.example.com"]), false);
  });

  it("does not let a wildcard host reach a different domain", () => {
    assert.equal(matchesAny("https://example.com.evil.test", ["https://*.example.com"]), false);
    assert.equal(matchesAny("https://notexample.com", ["example.com"]), false);
  });

  it("matches a port wildcard", () => {
    assert.equal(matchesAny("http://localhost:5173", ["http://localhost:*"]), true);
    assert.equal(matchesAny("http://localhost", ["http://localhost:*"]), false);
  });

  it("is case-insensitive on both sides", () => {
    assert.equal(matchesAny("https://EXAMPLE.com", ["https://example.COM"]), true);
  });
});

describe("judge — read-only mode", () => {
  it("refuses every mutating call and names the switch", () => {
    const v = judge(p({ readOnly: true }), "https://example.com", true);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.message.includes(READ_ONLY_ENV));
  });

  it("still allows reads", () => {
    assert.deepEqual(judge(p({ readOnly: true }), "https://example.com", false), { ok: true });
  });
});

/**
 * The half of read-only mode that lives OUTSIDE `judge`: WHICH tools count as
 * mutating. `call.ts` derives that from `readOnlyHint`, so a tool that wrongly
 * claims to be read-only is never refused, and nothing else notices — the same
 * annotation is what MCP clients read, so it looks deliberate either way.
 *
 * The list is pinned rather than derived. A derived check would agree with
 * whatever the annotations happen to say, which is the one thing that must not
 * go unreviewed: a new tool claiming `readOnlyHint` has to be added here on
 * purpose. The other direction is fail-safe — omit the annotation entirely and
 * the tool is treated as mutating.
 */
describe("read-only mode — which tools it covers", () => {
  const READ_ONLY = [
    "browser_downloads",
    "browser_find",
    "browser_get_console_logs",
    "browser_get_cookies",
    "browser_get_html",
    "browser_get_network_request",
    "browser_issues",
    "browser_list_clients",
    "browser_list_tabs",
    "browser_network_requests",
    "browser_perf_field_data",
    "browser_read_page",
    "browser_screenshot",
    "browser_snapshot",
    "browser_status",
    "browser_wait",
    "browser_wait_for",
  ];

  it("pins exactly which tools claim to be read-only", () => {
    const claimed = selectTools("full")
      .tools.filter((t) => t.schema.annotations?.readOnlyHint === true)
      .map((t) => t.schema.name)
      .sort();
    assert.deepEqual(claimed, [...READ_ONLY].sort());
  });

  it("refuses every mutating tool and lets every read-only one through", () => {
    const readOnlyPolicy = p({ readOnly: true });
    for (const tool of selectTools("full").tools) {
      // Derived exactly as call.ts derives it, so this fails if that changes.
      const mutating = tool.schema.annotations?.readOnlyHint !== true;
      const verdict = judge(readOnlyPolicy, "https://example.com", mutating);
      assert.equal(verdict.ok, !mutating, tool.schema.name);
    }
  });
});

describe("judge — allow and deny", () => {
  it("lets deny beat allow for the same origin", () => {
    const policyBoth = p({ allow: ["example.com"], deny: ["example.com"] });
    const v = judge(policyBoth, "https://example.com", false);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.message.includes(DENY_ENV));
  });

  it("refuses an origin that is not on a non-empty allow list", () => {
    const v = judge(p({ allow: ["example.com"] }), "https://other.test", false);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.message.includes(ALLOW_ENV));
  });

  it("allows anything when no allow list is set", () => {
    assert.deepEqual(judge(empty, "https://anything.test", true), { ok: true });
  });
});

describe("judge — an unjudgeable target", () => {
  it("refuses when an allow list is set, because 'unknown' must never mean 'go ahead'", () => {
    for (const url of ["chrome://settings", "about:blank", undefined]) {
      const v = judge(p({ allow: ["example.com"] }), url, false);
      assert.equal(v.ok, false, String(url));
    }
  });

  it("permits it when no allow list is set", () => {
    assert.deepEqual(judge(empty, "about:blank", false), { ok: true });
  });
});

describe("judge — the sensitive tier", () => {
  it("is readable", () => {
    assert.deepEqual(judge(p({ sensitive: ["bank.test"] }), "https://bank.test", false), {
      ok: true,
    });
  });

  it("is not driveable, and says why", () => {
    const v = judge(p({ sensitive: ["bank.test"] }), "https://bank.test", true);
    assert.equal(v.ok, false);
    assert.ok(v.ok === false && v.message.includes(SENSITIVE_ENV));
  });
});

describe("denyDomains — the network-layer half", () => {
  it("strips scheme, port and leading wildcard, because the network layer matches by domain", () => {
    assert.deepEqual(denyDomains(["https://*.example.com"]), ["example.com"]);
    assert.deepEqual(denyDomains(["http://localhost:3000"]), ["localhost"]);
  });

  it("drops a pattern it cannot reduce to a domain rather than guessing", () => {
    assert.deepEqual(denyDomains(["*"]), []);
    assert.deepEqual(denyDomains(["a*b.test"]), []);
  });

  it("de-duplicates", () => {
    assert.deepEqual(denyDomains(["example.com", "https://example.com", "*.example.com"]), [
      "example.com",
    ]);
  });
});

describe("policy — read from the environment", () => {
  const vars = [ALLOW_ENV, DENY_ENV, SENSITIVE_ENV, READ_ONLY_ENV];
  afterEach(() => {
    for (const v of vars) delete process.env[v];
    resetPolicyCache();
  });

  it("is undefined when nothing is configured — the default must stay frictionless", () => {
    resetPolicyCache();
    assert.equal(policy(), undefined);
    assert.equal(describePolicy(), undefined);
  });

  it("does not treat an empty string as a configured empty allow-list", () => {
    process.env[ALLOW_ENV] = "";
    resetPolicyCache();
    assert.equal(policy(), undefined);
  });

  it("splits a comma list and trims it", () => {
    process.env[ALLOW_ENV] = " a.test , b.test ";
    resetPolicyCache();
    assert.deepEqual(policy()?.allow, ["a.test", "b.test"]);
  });

  it("accepts the documented truthy spellings for read-only, and nothing else", () => {
    for (const on of ["1", "on", "true", "yes", "TRUE"]) {
      process.env[READ_ONLY_ENV] = on;
      resetPolicyCache();
      assert.equal(policy()?.readOnly, true, on);
    }
    for (const off of ["0", "off", "false", "no", "maybe"]) {
      process.env[READ_ONLY_ENV] = off;
      resetPolicyCache();
      assert.equal(policy()?.readOnly ?? false, false, off);
    }
  });
});
