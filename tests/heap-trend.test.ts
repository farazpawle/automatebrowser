/**
 * The heap trend (D7). One property carries the whole feature:
 *
 *   The slope is a LEAST-SQUARES FIT, not `(last - first) / window`.
 *
 * Chrome's heap saws — every garbage collection drops it a long way — so the
 * endpoints report whatever the last GC happened to leave. A page that is
 * genuinely leaking can easily end a sampling window LOWER than it started, and
 * an endpoint slope would then say "shrinking" about a leak. The fit says
 * "rising", which is the answer the tool exists to give.
 *
 * `heapSlopeBytesPerSec` is pure arithmetic, so nothing here needs a browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { heapSlopeBytesPerSec, renderHeapTrend } from "@/tools/trace-metrics";

const MB = 1_048_576;
const mb = (...values: number[]) => values.map((v) => v * MB);

describe("heapSlopeBytesPerSec", () => {
  it("reports a rise the endpoints would call a fall", () => {
    // Eight readings climbing, then one taken right after a collection. Last
    // (18 MB) is BELOW first (20 MB) — an endpoint slope would be negative.
    const sawtooth = mb(20, 26, 32, 38, 44, 50, 56, 62, 68, 18);
    assert.ok(sawtooth[sawtooth.length - 1] < sawtooth[0], "the endpoints must fall");
    assert.ok(heapSlopeBytesPerSec(sawtooth, 500) > 0, "the fit must still rise");
  });

  it("is exact on an evenly rising line", () => {
    // +1 MB per sample, one sample per second → 1 MB/s.
    assert.equal(heapSlopeBytesPerSec(mb(0, 1, 2, 3), 1000), MB);
  });

  it("scales with the sampling interval, not the sample count", () => {
    // Same readings twice as often → twice the rate.
    assert.equal(heapSlopeBytesPerSec(mb(0, 1, 2, 3), 500), 2 * MB);
  });

  it("calls a flat heap flat", () => {
    assert.equal(heapSlopeBytesPerSec(mb(12, 12, 12, 12), 500), 0);
  });

  it("reports a fall as negative", () => {
    assert.ok(heapSlopeBytesPerSec(mb(40, 30, 20, 10), 500) < 0);
  });

  it("says flat rather than dividing by zero on too few samples", () => {
    assert.equal(heapSlopeBytesPerSec([], 500), 0);
    assert.equal(heapSlopeBytesPerSec(mb(12), 500), 0);
  });
});

describe("renderHeapTrend", () => {
  const trend = {
    supported: true,
    samples: mb(10, 11, 12, 13, 14),
    elapsedMs: 2000,
    limit: 4096 * MB,
  };

  it("reports the cadence it achieved, not the one it asked for", () => {
    // Five samples across a real 2.0s is one every 500ms.
    assert.match(renderHeapTrend(trend), /over 2\.0s — 5 samples, one every ~500ms/);
  });

  it("halves the reported rate when a throttled tab halved the samples", () => {
    // The SAME five readings, but the tab was background-throttled and took 4s to
    // deliver them. The heap grew 4 MB over 4s, so 1 MB/s — not the 2 MB/s a
    // nominal 500ms interval would have claimed.
    const throttled = renderHeapTrend({ ...trend, elapsedMs: 4000 });
    assert.match(throttled, /one every ~1000ms/);
    assert.match(throttled, /trend \+1\.0 MB\/s/);
    assert.match(renderHeapTrend(trend), /trend \+2\.0 MB\/s/);
  });

  it("never presents growth as a leak", () => {
    assert.match(renderHeapTrend(trend), /not proof of a leak/);
  });

  it("has something to say about an empty result", () => {
    assert.match(renderHeapTrend({ ...trend, samples: [] }), /No heap readings/);
  });
});
