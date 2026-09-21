/**
 * B05, browser half — what `setNetPolicy` does to the rule table when more than
 * one agent is driving the same browser.
 *
 * The bug: it cleared the whole reserved band and wrote the caller's deny-list
 * into it. Two IDEs share one browser routinely, so the second one to be driven
 * deleted the first one's block rules — and the first one had already recorded
 * that browser as protected, so it never reinstalled them. Nothing failed,
 * nothing was logged, and `browser_eval` from the first agent could reach a
 * denied origin from then on.
 *
 * The contract these hold to:
 *
 *   - an owner replaces its OWN list and nobody else's;
 *   - the band is the union of every owner's list, which cannot block less than
 *     any single owner asked for — the one merge that is safe because these rules
 *     only ever block;
 *   - rules outside the reserved band belong to the user's other extensions and
 *     are never in `removeRuleIds`;
 *   - a union that does not fit FAILS, and installs nothing, rather than writing
 *     a prefix and reporting success.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChromeMock } from "./helpers/extension-harness";

import { chromeMock, loadExtensionModule } from "./helpers/extension-harness";

const NET_POLICY = "Chrome-extension/lib/automation/net-policy.ts";
/** Kept in step with the source constants by the harness's own suite. */
const RULE_ID_BASE = 91_000;
const MAX_RULES = 500;

interface NetPolicyModule {
  setNetPolicy(args: { deny?: string[]; owner?: string }): Promise<{
    installed: number;
    mine: number;
    owners: number;
  }>;
}

function load(c: ChromeMock): NetPolicyModule {
  return loadExtensionModule<NetPolicyModule>(NET_POLICY, { globals: { chrome: c.chrome } })
    .exports;
}

/** The domains currently blocked, sorted so assertions do not depend on id order. */
function blocked(c: ChromeMock): string[] {
  return c
    .rules()
    .filter((r) => r.id >= RULE_ID_BASE && r.id < RULE_ID_BASE + MAX_RULES)
    .flatMap((r) => r.condition?.requestDomains ?? [])
    .sort();
}

describe("net policy — two controllers, one browser", () => {
  it("keeps the first agent's rules when the second installs its own", async () => {
    const c = chromeMock();
    const net = load(c);

    await net.setNetPolicy({ deny: ["tracker.example"], owner: "ide-a" });
    const second = await net.setNetPolicy({ deny: ["ads.example"], owner: "ide-b" });

    assert.deepEqual(blocked(c), ["ads.example", "tracker.example"]);
    assert.equal(second.owners, 2, "both agents should be on record");
    assert.equal(second.mine, 1, "the second agent asked for one domain and got it");
    assert.equal(second.installed, 2, "the band now covers both agents");
  });

  it("replaces an owner's own list rather than accumulating it", async () => {
    const c = chromeMock();
    const net = load(c);

    await net.setNetPolicy({ deny: ["old.example"], owner: "ide-a" });
    await net.setNetPolicy({ deny: ["new.example"], owner: "ide-a" });

    assert.deepEqual(blocked(c), ["new.example"], "a shortened deny-list must stop blocking");
  });

  it("does not let one agent's change drop another's domain", async () => {
    const c = chromeMock();
    const net = load(c);

    await net.setNetPolicy({ deny: ["a.example", "shared.example"], owner: "ide-a" });
    await net.setNetPolicy({ deny: ["b.example", "shared.example"], owner: "ide-b" });
    // A drops the shared domain. B still requires it, so it stays.
    await net.setNetPolicy({ deny: ["a.example"], owner: "ide-a" });

    assert.deepEqual(blocked(c), ["a.example", "b.example", "shared.example"]);
  });

  it("serializes concurrent installs so neither is lost", async () => {
    const c = chromeMock();
    const net = load(c);

    await Promise.all([
      net.setNetPolicy({ deny: ["a.example"], owner: "ide-a" }),
      net.setNetPolicy({ deny: ["b.example"], owner: "ide-b" }),
    ]);

    assert.deepEqual(blocked(c), ["a.example", "b.example"]);
  });

  it("treats a server that names no owner as one shared bucket", async () => {
    const c = chromeMock();
    const net = load(c);

    await net.setNetPolicy({ deny: ["one.example"] });
    const again = await net.setNetPolicy({ deny: ["two.example"] });

    assert.deepEqual(blocked(c), ["two.example"], "an unnamed owner replaces its own list");
    assert.equal(again.owners, 1);
  });
});

describe("net policy — the reserved rule band", () => {
  it("leaves rules outside the band alone", async () => {
    const c = chromeMock({
      rules: [
        { id: 1, condition: { requestDomains: ["someone-elses-adblocker.example"] } },
        { id: RULE_ID_BASE + MAX_RULES, condition: { requestDomains: ["just-above.example"] } },
      ],
    });
    const net = load(c);

    await net.setNetPolicy({ deny: ["tracker.example"], owner: "ide-a" });

    const removed = c.updates.flatMap((u) => u.removeRuleIds ?? []);
    assert.deepEqual(removed, [], "nothing outside the band may be removed");
    assert.deepEqual(
      c
        .rules()
        .map((r) => r.id)
        .sort((a, b) => a - b),
      [1, RULE_ID_BASE, RULE_ID_BASE + MAX_RULES],
      "the other extension's rules survive alongside ours",
    );
  });

  it("clears only its own band ids when reinstalling", async () => {
    const c = chromeMock({ rules: [{ id: 2, condition: { requestDomains: ["keep.example"] } }] });
    const net = load(c);

    await net.setNetPolicy({ deny: ["one.example", "two.example"], owner: "ide-a" });
    await net.setNetPolicy({ deny: ["three.example"], owner: "ide-a" });

    assert.deepEqual(c.updates[1]?.removeRuleIds, [RULE_ID_BASE, RULE_ID_BASE + 1]);
    assert.ok(
      c.rules().some((r) => r.id === 2),
      "the unrelated rule is still installed after two rounds",
    );
  });

  it("refuses a union that does not fit, and installs nothing", async () => {
    const c = chromeMock();
    const net = load(c);

    const half = Array.from({ length: MAX_RULES - 1 }, (_, i) => `a${i}.example`);
    await net.setNetPolicy({ deny: half, owner: "ide-a" });
    const updatesBefore = c.updates.length;

    await assert.rejects(
      () => net.setNetPolicy({ deny: ["b0.example", "b1.example"], owner: "ide-b" }),
      /reserved band holds 500/,
    );
    assert.equal(c.updates.length, updatesBefore, "a refused install must not touch the rules");
    assert.equal(blocked(c).length, MAX_RULES - 1, "the first agent keeps exactly its own rules");
  });

  it("still refuses outright when the extension predates the permission", async () => {
    const c = chromeMock({ noDeclarativeNetRequest: true });
    const net = load(c);

    await assert.rejects(
      () => net.setNetPolicy({ deny: ["tracker.example"], owner: "ide-a" }),
      /declarativeNetRequest permission not granted/,
    );
  });

  it("installs even when the session mirror is unavailable", async () => {
    // The mirror is what survives a worker eviction; losing it degrades the
    // multi-agent guarantee, never the install the caller just asked for.
    const c = chromeMock({ brokenStorage: true });
    const net = load(c);

    const answer = await net.setNetPolicy({ deny: ["tracker.example"], owner: "ide-a" });
    assert.equal(answer.mine, 1);
    assert.deepEqual(blocked(c), ["tracker.example"]);
  });
});
