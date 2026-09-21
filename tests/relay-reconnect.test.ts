/**
 * B06 — one failed reconnect used to end automatic recovery for good.
 *
 * The scheduling lived inside the close handler: a drop armed exactly one timer,
 * that attempt called `start()`, and when `start()` rejected the rejection was
 * logged and nothing else was ever armed. So a relay that was down for a second
 * longer than the first retry left the controller disconnected until some other
 * caller happened to reach `start()` again — which, for an idle agent, is the
 * next tool call the human makes. Startup was worse: a server that came up while
 * the relay was briefly unreachable scheduled nothing at all.
 *
 * The seam. These drive the SCHEDULER, so they replace the one method that dials
 * out (`_connect`) on the instance rather than standing up a relay. That is
 * deliberate: bringing up a real relay proves discovery works and tells you
 * nothing about what happens after it fails, which is the entire bug. The real
 * end-to-end recovery is covered in `scripts/connection-smoke.cjs`, against a
 * relay that is genuinely killed.
 *
 * Timing. `BASE_RECONNECT_MS` is 500 and doubles, so attempts land at +500 ms and
 * +1500 ms and a case that wants three of them waits about two seconds. Each
 * assertion counts attempts rather than measuring delays, and allows more time
 * than it needs — a test that pinned exact timings would fail on a loaded
 * machine and teach everyone to re-run it rather than read it.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { RelayLink } from "@/relay-link";

/** The private seam these tests drive. Named once so a rename fails loudly. */
interface Dialer {
  _connect: () => Promise<void>;
  _retryTimer: NodeJS.Timeout | undefined;
  _reconnectMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every link a case made. Closed unconditionally afterwards, because a FAILING
 * assertion skips the shutdown at the end of its own test — and a link that is
 * still retrying keeps the whole suite's process alive. That cost 60 s of hang
 * for one wrong number the first time these were run.
 */
const made: RelayLink[] = [];

afterEach(async () => {
  for (const l of made.splice(0)) await l.close();
});

/**
 * A link whose dial-out is under the test's control. `outcomes` is consumed one
 * per attempt; anything past the end repeats the last one.
 */
function link(outcomes: Array<"fail" | "ok">): {
  link: RelayLink;
  dialer: Dialer;
  attempts: () => number;
} {
  let attempts = 0;
  const l = new RelayLink({ version: "test", name: "test" }, () => {});
  made.push(l);
  const dialer = l as unknown as Dialer;
  dialer._connect = async (): Promise<void> => {
    const outcome = outcomes[Math.min(attempts, outcomes.length - 1)] ?? "fail";
    attempts += 1;
    if (outcome === "fail") throw new Error("relay unreachable");
  };
  return { link: l, dialer, attempts: () => attempts };
}

describe("relay link — a failed attempt schedules the next one", () => {
  it("keeps retrying after the first reconnect fails", async () => {
    const { link: l, attempts } = link(["fail"]);

    await assert.rejects(() => l.start(), /relay unreachable/);
    assert.equal(attempts(), 1, "the first attempt is the caller's own");

    // Attempts land at +500 ms and +1500 ms (the delay doubles each time), so
    // this window covers three with room to spare on a loaded machine.
    await sleep(2000);
    assert.ok(attempts() >= 3, `a chain of attempts should have continued; saw ${attempts()}`);
  });

  it("recovers without another tool call once the relay comes back", async () => {
    // Two failures, then success — the exact shape of a relay restarting.
    const { link: l, attempts } = link(["fail", "fail", "ok"]);

    await assert.rejects(() => l.start(), /relay unreachable/);
    await sleep(2200);

    assert.equal(attempts(), 3, "it should have stopped trying once one succeeded");
  });

  it("arms one timer, not one per caller", async () => {
    const { link: l, dialer, attempts } = link(["fail"]);

    // Three callers race into a link that cannot connect — three tool calls
    // arriving at once on a dead relay.
    await Promise.allSettled([l.start(), l.start(), l.start()]);
    assert.equal(attempts(), 1, "concurrent starts share one attempt");
    assert.ok(dialer._retryTimer !== undefined, "one retry should be pending");
  });

  it("does not multiply timers when a close arrives while a retry is pending", async () => {
    const { link: l, dialer, attempts } = link(["fail"]);
    await assert.rejects(() => l.start(), /relay unreachable/);

    const armed = dialer._retryTimer;
    // Repeated close notifications, the way a socket that errors and then closes
    // delivers them.
    const onClose = (l as unknown as { _onClose: (ws: unknown) => void })._onClose.bind(l);
    onClose(undefined);
    onClose(undefined);
    assert.equal(dialer._retryTimer, armed, "the pending timer is reused, never replaced");

    await sleep(800);
    assert.ok(attempts() >= 2);
  });
});

describe("relay link — backoff and shutdown", () => {
  it("backs off rather than hammering a relay that is down", async () => {
    const { link: l, dialer } = link(["fail"]);
    const first = dialer._reconnectMs;

    await assert.rejects(() => l.start(), /relay unreachable/);
    await sleep(800);

    assert.ok(
      dialer._reconnectMs > first,
      `the delay should grow between attempts; still ${dialer._reconnectMs}`,
    );
  });

  it("resets the delay only on a completed handshake, not on a socket that opened", async () => {
    const { link: l, dialer } = link(["fail"]);
    await assert.rejects(() => l.start(), /relay unreachable/);
    await sleep(800);
    const backedOff = dialer._reconnectMs;
    assert.ok(backedOff > 500);

    // A relay that accepts the socket and then refuses us never welcomes. Only
    // the welcome may reset the delay — otherwise a rejected controller loops at
    // the 500 ms floor forever.
    const onMessage = (l as unknown as { _onMessage: (raw: unknown) => void })._onMessage.bind(l);
    onMessage(JSON.stringify({ type: "control.browsers", payload: { browsers: [] } }));
    assert.equal(dialer._reconnectMs, backedOff, "a roster push is not a validated connection");

    onMessage(JSON.stringify({ type: "control.welcome", payload: { ctrlId: "c1" } }));
    assert.equal(dialer._reconnectMs, 500, "the welcome is what proves the link works");
  });

  it("stops for good once the controller is closed", async () => {
    const { link: l, dialer, attempts } = link(["fail"]);
    await assert.rejects(() => l.start(), /relay unreachable/);
    const after = attempts();

    await l.close();
    assert.equal(dialer._retryTimer, undefined, "shutdown must disarm the pending retry");

    await sleep(1200);
    assert.equal(attempts(), after, "a deliberately stopped controller must not come back");
    // And nothing can re-arm it afterwards.
    await l.start();
    assert.equal(attempts(), after);
    assert.equal(dialer._retryTimer, undefined);
  });

  it("settles an in-flight request instead of leaving it hanging", async () => {
    const { link: l } = link(["ok"]);
    await l.start();

    // A request that reached the wire and is waiting for its reply when the link
    // goes away. Its rejection is what lets the tool layer retry.
    const pending = (l as unknown as { _pending: Map<string, unknown> })._pending;
    let settled: Error | undefined;
    pending.set("req-1", {
      resolve: () => {},
      reject: (e: Error) => {
        settled = e;
      },
      timer: setTimeout(() => {}, 60_000),
    });

    await l.close();
    assert.match(String(settled?.message), /relay connection closed/);
    assert.equal(pending.size, 0);
  });
});
