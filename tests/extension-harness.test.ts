/**
 * The harness that lets Node-only tests drive real extension source (B05).
 *
 * Two properties are load-bearing, and both fail silently if they break:
 *
 *   - FRESH STATE. Extension modules keep module-level state — the net-policy
 *     write chain, the network log's ring buffer. If one load could see another's,
 *     a suite would pass because an earlier case left the right value behind, and
 *     the order of `it` blocks would become part of the contract.
 *   - NO LEAKED TIMERS. A module that schedules work on load holds the process
 *     open; the symptom is a hang in whatever test happens to run last.
 *
 * It also has to be the SHIPPED file it runs, not a copy: the last assertion
 * reads a constant out of the real source and checks the loaded module agrees.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { chromeMock, loadExtensionModule } from "./helpers/extension-harness";

const NET_POLICY = "Chrome-extension/lib/automation/net-policy.ts";

interface NetPolicyModule {
  setNetPolicy(args: { deny?: string[]; owner?: string }): Promise<{
    installed: number;
    mine: number;
    owners: number;
  }>;
}

describe("extension harness", () => {
  it("gives each load its own module state", async () => {
    const a = chromeMock();
    const b = chromeMock();
    const first = loadExtensionModule<NetPolicyModule>(NET_POLICY, {
      globals: { chrome: a.chrome },
    });
    const second = loadExtensionModule<NetPolicyModule>(NET_POLICY, {
      globals: { chrome: b.chrome },
    });

    await first.exports.setNetPolicy({ deny: ["one.example"], owner: "A" });

    // The second load starts from nothing: it neither sees A's entry nor writes
    // into A's browser.
    const answer = await second.exports.setNetPolicy({ deny: ["two.example"], owner: "B" });
    assert.equal(answer.owners, 1, "second load must not inherit the first load's owners");
    assert.deepEqual(
      b.rules().map((r) => r.condition?.requestDomains?.[0]),
      ["two.example"],
    );
    assert.deepEqual(
      a.rules().map((r) => r.condition?.requestDomains?.[0]),
      ["one.example"],
      "the first load's browser must be untouched by the second",
    );

    first.dispose();
    second.dispose();
  });

  it("clears timers the loaded module scheduled", async () => {
    const mod = loadExtensionModule<{ count(): number }>("tests/fixtures/timer-module.ts");
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(mod.exports.count() > 0, "the fixture's interval should have fired at least once");

    mod.dispose();
    const stopped = mod.exports.count();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mod.exports.count(), stopped, "dispose() must stop the module's interval");
  });

  it("refuses a bare import it was given no stand-in for", () => {
    assert.throws(
      () => loadExtensionModule("tests/fixtures/bare-import-module.ts"),
      /resolves relative source only/,
    );
  });

  it("substitutes a mocked dependency for the real one", () => {
    // The path Tasks 8-11 need: drive `state.ts` without executing the injection
    // helper it depends on. A real relative import would otherwise be loaded.
    const calls: unknown[][] = [];
    const mod = loadExtensionModule<Record<string, unknown>>(
      "Chrome-extension/lib/automation/state.ts",
      {
        globals: { chrome: chromeMock().chrome },
        mocks: {
          "./run-func": {
            runFunc: (...args: unknown[]) => {
              calls.push(args);
              return Promise.resolve({});
            },
          },
        },
      },
    );
    assert.equal(typeof mod.exports.getCookies, "function", "state.ts should have loaded");
    mod.dispose();
  });

  it("runs the shipped file, not a copy of it", async () => {
    const source = readFileSync(NET_POLICY, "utf8");
    const band = /RULE_ID_BASE = ([\d_]+)/.exec(source);
    assert.ok(band, "net-policy.ts should still declare RULE_ID_BASE");
    const base = Number(band[1].replace(/_/g, ""));

    const c = chromeMock();
    const mod = loadExtensionModule<NetPolicyModule>(NET_POLICY, { globals: { chrome: c.chrome } });
    await mod.exports.setNetPolicy({ deny: ["x.example"], owner: "A" });
    assert.equal(c.rules()[0]?.id, base, "the rule id must come from the real source constant");
    mod.dispose();
  });
});
