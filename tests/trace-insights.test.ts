/**
 * The named performance insights (D18) — LCP breakdown and render-blocking
 * resources, against synthetic trace events. No browser, no relay, no model.
 *
 * The property that matters most is arithmetic: **the spans must sum to the LCP
 * they claim to explain.** A breakdown whose parts do not add up is worse than
 * no breakdown, because the reader acts on the biggest number and the biggest
 * number is then wrong.
 *
 * The second property is honesty. Three different situations look identical in
 * a naive parser — a text LCP with genuinely nothing to download, an image LCP
 * whose request could not be matched, and a trace with no document timing at
 * all — and each has to say which it is rather than reporting a confident zero.
 *
 * Timings mirror the real event shapes: `ts` is microseconds, while
 * `timing.requestTime` and `finishTime` are SECONDS on the same clock, and
 * `receiveHeadersStart` is milliseconds offset from `requestTime`. Getting that
 * mix wrong is the easiest way to produce a plausible, meaningless breakdown,
 * so the fixtures below are written in those units deliberately.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeTrace, renderInsights } from "@/tools/trace-metrics";

const NAV = 1_000_000; // µs
const us = (ms: number) => NAV + ms * 1000;

type Ev = Record<string, unknown>;

const navigationStart = (): Ev => ({ name: "navigationStart", ts: NAV });

/** A request as its three events: sent, headers back, finished. */
function request(opts: {
  id: string;
  url?: string;
  sentMs: number;
  firstByteMs?: number;
  finishMs: number;
  resourceType?: string;
  renderBlocking?: string;
  priority?: string;
}): Ev[] {
  const events: Ev[] = [
    {
      name: "ResourceSendRequest",
      ts: us(opts.sentMs),
      args: {
        data: {
          requestId: opts.id,
          url: opts.url ?? `https://example.test/${opts.id}`,
          resourceType: opts.resourceType,
          renderBlocking: opts.renderBlocking,
          priority: opts.priority,
        },
      },
    },
  ];
  if (opts.firstByteMs !== undefined) {
    // requestTime in seconds, receiveHeadersStart in ms offset from it.
    events.push({
      name: "ResourceReceiveResponse",
      ts: us(opts.firstByteMs),
      args: {
        data: {
          requestId: opts.id,
          timing: {
            requestTime: us(opts.sentMs) / 1_000_000,
            receiveHeadersStart: opts.firstByteMs - opts.sentMs,
          },
        },
      },
    });
  }
  events.push({
    name: "ResourceFinish",
    ts: us(opts.finishMs),
    args: { data: { requestId: opts.id, finishTime: us(opts.finishMs) / 1_000_000 } },
  });
  return events;
}

const lcpCandidate = (atMs: number, nodeId?: number, pid = 7): Ev => ({
  name: "largestContentfulPaint::Candidate",
  ts: us(atMs),
  pid,
  args: { data: { type: nodeId === undefined ? "text" : "image", nodeId } },
});

const imagePaint = (atMs: number, nodeId: number, url: string, pid = 7): Ev => ({
  name: "LargestImagePaint::Candidate",
  ts: us(atMs),
  pid,
  args: { data: { DOMNodeId: nodeId, imageUrl: url } },
});

const paint = (name: "firstPaint" | "firstContentfulPaint", atMs: number): Ev => ({
  name,
  ts: us(atMs),
});

const IMG = "https://example.test/hero.avif";

/** TTFB 200, load delay 300, load time 600, render delay 200 — LCP 1300. */
function imageLcpTrace(): Ev[] {
  return [
    navigationStart(),
    ...request({
      id: "doc",
      sentMs: 10,
      firstByteMs: 200,
      finishMs: 260,
      resourceType: "Document",
    }),
    ...request({ id: "img", url: IMG, sentMs: 500, finishMs: 1100 }),
    imagePaint(1300, 42, IMG),
    lcpCandidate(1300, 42),
    paint("firstPaint", 400),
  ];
}

describe("LCP breakdown", () => {
  it("splits an image LCP into four spans that sum to the LCP", () => {
    const b = analyzeTrace(imageLcpTrace()).lcpBreakdown;
    assert.ok(b, "an image LCP with a matchable request must produce a breakdown");
    assert.deepEqual(
      { ttfb: b.ttfbMs, delay: b.loadDelayMs, load: b.loadDurationMs, render: b.renderDelayMs },
      { ttfb: 200, delay: 300, load: 600, render: 200 },
    );
    // The whole contract of the feature, and the [User] check on a real page.
    assert.equal(b.ttfbMs + b.loadDelayMs! + b.loadDurationMs! + b.renderDelayMs, b.totalMs);
    assert.equal(b.totalMs, analyzeTrace(imageLcpTrace()).lcpMs);
  });

  it("gives a text LCP two spans and says why, rather than four with zeroes", () => {
    const b = analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      lcpCandidate(900),
      paint("firstPaint", 400),
    ]).lcpBreakdown;
    assert.ok(b);
    assert.equal(b.loadDelayMs, undefined);
    assert.equal(b.loadDurationMs, undefined);
    assert.equal(b.ttfbMs + b.renderDelayMs, b.totalMs);
    assert.match(b.note ?? "", /text LCP/);
  });

  it("distinguishes an unmatched image request from a text LCP", () => {
    // The image paint names a URL that no request in the trace carries — the
    // download is real but unmeasured, and saying "text LCP" here would be a lie.
    const b = analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      imagePaint(1300, 42, "https://cdn.example.test/never-requested.avif"),
      lcpCandidate(1300, 42),
    ]).lcpBreakdown;
    assert.ok(b);
    assert.equal(b.loadDurationMs, undefined);
    assert.match(b.note ?? "", /could not be matched/);
    assert.doesNotMatch(b.note ?? "", /text LCP/);
  });

  it("matches the image on process as well as node id", () => {
    // Same node id in a different renderer. Node ids are only unique per
    // process, so ignoring the pid would attach an iframe's image to the LCP.
    const m = analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      ...request({ id: "img", url: IMG, sentMs: 500, finishMs: 1100 }),
      imagePaint(1300, 42, IMG, 999),
      lcpCandidate(1300, 42, 7),
    ]);
    assert.equal(m.lcpBreakdown?.loadDurationMs, undefined, "a foreign process must not match");
  });

  it("reports no breakdown, and says why, when the document has no timing", () => {
    const m = analyzeTrace([
      navigationStart(),
      ...request({ id: "doc", sentMs: 10, finishMs: 260, resourceType: "Document" }),
      lcpCandidate(900),
    ]);
    assert.equal(m.lcpBreakdown, undefined);
    assert.ok(
      m.insightGaps.some((g) => /time to first byte cannot be measured/.test(g)),
      "the gap has to name what was missing",
    );
  });

  it("fails closed when a span comes out negative rather than printing nonsense", () => {
    // The image was already in flight before the document's headers arrived, so
    // "resource load delay" is negative. No ordering of the four spans describes
    // that, and a breakdown whose parts do not sum to LCP is worth less than
    // none — so it is suppressed and the reason is said out loud.
    const m = analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 400,
        finishMs: 460,
        resourceType: "Document",
      }),
      ...request({ id: "img", url: IMG, sentMs: 100, finishMs: 800 }),
      imagePaint(1300, 42, IMG),
      lcpCandidate(1300, 42),
    ]);
    assert.equal(m.lcpBreakdown, undefined);
    assert.ok(
      m.insightGaps.some((g) => /one came out negative/.test(g)),
      "the gap must say what went wrong, not just disappear",
    );
  });

  it("ignores a request that predates the navigation entirely", () => {
    // A trace recorded with {reload:true} carries the previous page's tail. Its
    // document request must not be mistaken for this navigation's.
    const m = analyzeTrace([
      {
        name: "ResourceSendRequest",
        ts: NAV - 500_000,
        args: {
          data: { requestId: "old", url: "https://example.test/old", resourceType: "Document" },
        },
      },
      {
        name: "ResourceReceiveResponse",
        ts: NAV - 400_000,
        args: {
          data: {
            requestId: "old",
            timing: { requestTime: (NAV - 500_000) / 1_000_000, receiveHeadersStart: 50 },
          },
        },
      },
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      lcpCandidate(900),
    ]);
    assert.equal(m.lcpBreakdown?.ttfbMs, 200, "the current navigation's document must win");
  });
});

describe("render-blocking resources", () => {
  const withBlockers = (extra: Ev[]) =>
    analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      paint("firstPaint", 900),
      ...extra,
    ]).renderBlocking;

  it("lists a blocking stylesheet with the time it took", () => {
    const found = withBlockers(
      request({
        id: "css",
        url: "https://example.test/app.css",
        sentMs: 300,
        finishMs: 800,
        renderBlocking: "blocking",
      }),
    );
    assert.deepEqual(found, [{ url: "https://example.test/app.css", ms: 500 }]);
  });

  it("ignores an async script, which is already doing the right thing", () => {
    // `potentially_blocking` is what an async script carries. Reporting it would
    // be advice to fix something that is not broken.
    assert.deepEqual(
      withBlockers(
        request({ id: "s", sentMs: 300, finishMs: 800, renderBlocking: "potentially_blocking" }),
      ),
      [],
    );
    assert.deepEqual(
      withBlockers(
        request({ id: "s", sentMs: 300, finishMs: 800, renderBlocking: "non_blocking" }),
      ),
      [],
    );
  });

  it("ignores a resource that finished after the paint it could not have blocked", () => {
    assert.deepEqual(
      withBlockers(
        request({ id: "late", sentMs: 300, finishMs: 1500, renderBlocking: "blocking" }),
      ),
      [],
    );
  });

  it("counts an in-body parser-blocking script only at a high enough priority", () => {
    const low = withBlockers(
      request({
        id: "s",
        sentMs: 300,
        finishMs: 800,
        renderBlocking: "in_body_parser_blocking",
        resourceType: "Script",
        priority: "Low",
      }),
    );
    assert.deepEqual(low, [], "a low-priority in-body script holds nothing up");

    const high = withBlockers(
      request({
        id: "s",
        sentMs: 300,
        finishMs: 800,
        renderBlocking: "in_body_parser_blocking",
        resourceType: "Script",
        priority: "High",
      }),
    );
    assert.equal(high.length, 1);
  });

  it("measures against first paint, not first contentful paint", () => {
    // A resource finishing between the two blocked neither — crediting it to
    // FCP would report a blocker that came too late to block anything.
    const between = analyzeTrace([
      navigationStart(),
      ...request({
        id: "doc",
        sentMs: 10,
        firstByteMs: 200,
        finishMs: 260,
        resourceType: "Document",
      }),
      paint("firstPaint", 500),
      paint("firstContentfulPaint", 1200),
      ...request({ id: "css", sentMs: 300, finishMs: 900, renderBlocking: "blocking" }),
    ]).renderBlocking;
    assert.deepEqual(between, []);
  });

  it("sorts the worst offender first", () => {
    const found = withBlockers([
      ...request({
        id: "a",
        url: "https://example.test/a.css",
        sentMs: 300,
        finishMs: 450,
        renderBlocking: "blocking",
      }),
      ...request({
        id: "b",
        url: "https://example.test/b.css",
        sentMs: 300,
        finishMs: 850,
        renderBlocking: "blocking",
      }),
    ]);
    assert.deepEqual(
      found.map((r) => r.url),
      ["https://example.test/b.css", "https://example.test/a.css"],
    );
  });
});

describe("what the reader is told", () => {
  it("names the cause and the fix for the biggest span, not a generic one", () => {
    const slowServer = renderInsights(
      analyzeTrace([
        navigationStart(),
        ...request({
          id: "doc",
          sentMs: 10,
          firstByteMs: 1900,
          finishMs: 1950,
          resourceType: "Document",
        }),
        lcpCandidate(2100),
      ]),
    ).join("\n");
    assert.match(slowServer, /cause: the server took 1900ms/);
    assert.match(slowServer, /fix: cache the document at the edge/);

    const slowImage = renderInsights(analyzeTrace(imageLcpTrace())).join("\n");
    assert.match(slowImage, /cause: the LCP image itself took 600ms to download/);
    assert.match(slowImage, /fix: serve it smaller/);
  });

  it("gives every span a percentage, so the biggest one is obvious at a glance", () => {
    const text = renderInsights(analyzeTrace(imageLcpTrace())).join("\n");
    assert.match(text, /time to first byte\s+200ms \(15%\)/);
    assert.match(text, /resource load time\s+600ms \(46%\)/);
  });

  it("prints a gap rather than staying silent about an insight it could not compute", () => {
    const text = renderInsights(
      analyzeTrace([
        navigationStart(),
        ...request({ id: "doc", sentMs: 10, finishMs: 260, resourceType: "Document" }),
        lcpCandidate(900),
      ]),
    ).join("\n");
    assert.match(text, /LCP breakdown: no document-request timing/);
  });

  it("says nothing at all when the trace carries no insights either way", () => {
    assert.deepEqual(renderInsights(analyzeTrace([])), []);
  });
});
