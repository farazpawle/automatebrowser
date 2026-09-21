/**
 * I01 — status has to say whether the link is coming back, not just that it is down.
 *
 * `browser_status` used to render one line for four different situations:
 * "relay: not connected yet (starting / retrying)". A link retrying every half
 * second and a link that has shut down and will never try again produced the
 * same sentence, so the only way to tell "wait a moment" from "this is over" was
 * to call something else and see whether it failed.
 *
 * Two things are pinned here. That the reported state follows the SCHEDULER —
 * the same seam `relay-reconnect.test.ts` drives, replacing `_connect` on the
 * instance rather than standing up a relay, because what matters is what the
 * link says about itself after a dial fails. And that nothing it says can carry
 * the token: a failure reason is quoted back to an agent, so it is the one place
 * a shared secret could leave this process wearing the clothes of a diagnostic.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { RelayLink } from "@/relay-link";
import { describeRecovery } from "@/tools/status";

interface Dialer {
  _connect: () => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Closed unconditionally: a link still retrying holds the suite's process open. */
const made: RelayLink[] = [];
afterEach(async () => {
  for (const l of made.splice(0)) await l.close();
});

/** A link whose dial-out always fails with `message`. */
function failingLink(message: string, token?: string): RelayLink {
  const l = new RelayLink({ version: "test", name: "test", token }, () => {});
  made.push(l);
  (l as unknown as Dialer)._connect = async (): Promise<void> => {
    throw new Error(message);
  };
  return l;
}

describe("relay link — the state it reports follows what it is actually doing", () => {
  it("starts out connecting, with nothing yet to report", async () => {
    const l = failingLink("relay unreachable");
    const r = l.recovery();
    assert.equal(r.state, "connecting");
    assert.equal(r.attempts, 0);
    assert.equal(r.lastError, undefined, "nothing has failed yet");
  });

  it("reports retrying, with the count, the countdown and the reason", async () => {
    const l = failingLink("relay unreachable");
    await assert.rejects(() => l.start(), /relay unreachable/);

    const r = l.recovery();
    assert.equal(r.state, "retrying");
    assert.ok(r.attempts >= 1, `expected a failed attempt, saw ${r.attempts}`);
    assert.ok(
      r.nextRetryInMs !== undefined && r.nextRetryInMs > 0 && r.nextRetryInMs <= 8000,
      `countdown should be bounded by the backoff ceiling, saw ${r.nextRetryInMs}`,
    );
    assert.match(r.lastError ?? "", /relay unreachable/);
  });

  it("counts consecutive failures rather than reporting one forever", async () => {
    const l = failingLink("relay unreachable");
    await assert.rejects(() => l.start(), /relay unreachable/);
    const first = l.recovery().attempts;
    // Attempts land at +500 ms and +1500 ms, so this covers at least one more.
    await sleep(1200);
    assert.ok(
      l.recovery().attempts > first,
      `the count should follow the chain; stayed at ${first}`,
    );
  });

  it("a stopped link NEVER claims to be retrying", async () => {
    const l = failingLink("relay unreachable");
    await assert.rejects(() => l.start(), /relay unreachable/);
    assert.equal(l.recovery().state, "retrying", "a retry must be armed for this to mean anything");

    await l.close();
    const r = l.recovery();
    assert.equal(r.state, "stopped");
    assert.equal(r.nextRetryInMs, undefined, "a stopped link has no next attempt");
  });
});

describe("relay link — a failure reason is safe to print", () => {
  it("never quotes the token back, even when the error contains it", async () => {
    const token = "s3cr3t-shared-token";
    const l = failingLink(`handshake refused for ws://127.0.0.1:9009?token=${token}`, token);
    await assert.rejects(() => l.start());

    const reason = l.recovery().lastError ?? "";
    assert.ok(reason.length > 0, "there should still be a usable reason");
    assert.ok(!reason.includes(token), `the token leaked into the status reply: ${reason}`);
    assert.match(reason, /\*\*\*/, "the removal should be visible, not silent");
    assert.match(reason, /handshake refused/, "the useful half must survive redaction");
  });

  it("bounds one enormous message so it cannot flood the reply", async () => {
    const l = failingLink("x".repeat(5000));
    await assert.rejects(() => l.start());
    const reason = l.recovery().lastError ?? "";
    assert.ok(reason.length <= 201, `reason was ${reason.length} chars`);
  });
});

describe("browser_status — the line an agent reads", () => {
  it("tells a reconnecting link apart from a stopped one", () => {
    const retrying = describeRecovery({ state: "retrying", attempts: 2, nextRetryInMs: 1500 });
    const stopped = describeRecovery({ state: "stopped", attempts: 2 });

    assert.match(retrying, /^link: RETRYING/);
    assert.match(retrying, /2 failed attempts/);
    assert.match(retrying, /1\.5s/);
    assert.match(retrying, /keep trying on its own/);

    assert.match(stopped, /^link: STOPPED/);
    assert.match(stopped, /NOT reconnect/);
    assert.doesNotMatch(stopped, /RETRYING|next attempt/i, "a stopped link must not read as busy");
  });

  it("separates being on the relay from having a browser to drive", () => {
    assert.equal(describeRecovery({ state: "connected", attempts: 0 }), "link: CONNECTED");
    const waiting = describeRecovery({ state: "waiting", attempts: 0 });
    assert.match(waiting, /^link: WAITING/);
    assert.match(waiting, /no browser/);
    assert.match(waiting, /Nothing can be driven/);
  });

  it("carries the reason when there is one, and says nothing when there is not", () => {
    assert.match(
      describeRecovery({
        state: "retrying",
        attempts: 1,
        nextRetryInMs: 500,
        lastError: "ECONNREFUSED",
      }),
      /Last failure: ECONNREFUSED/,
    );
    assert.doesNotMatch(
      describeRecovery({ state: "connecting", attempts: 0 }),
      /Last failure/,
      "a first connect has no failure to report",
    );
  });

  it("uses the singular for exactly one failure", () => {
    assert.match(describeRecovery({ state: "connecting", attempts: 1 }), /1 failed attempt\b/);
  });
});
