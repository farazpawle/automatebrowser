/**
 * A6 — offline Core Web Vitals parser for a recorded Chrome trace.
 *
 * `browser_perf_trace` already captures the raw trace events; this turns "here's
 * a 40 MB file, open DevTools yourself" into an answer. It is a PURE function
 * over the event array on purpose: no chrome.*, no CDP, no Context — so the
 * smoke harness can exercise it against synthetic events with no browser and no
 * relay, which is the only way this logic is testable at all.
 *
 * Trace timestamps (`ts`, `dur`) are MICROSECONDS. Everything reported here is
 * milliseconds, measured from navigation start, because a metric in wall time is
 * a number nobody can act on.
 */

/** Google's published good / needs-improvement boundaries, in ms (CLS unitless). */
const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export type Rating = "good" | "needs improvement" | "poor";

export function rate(metric: string, value: number): Rating {
  const t = THRESHOLDS[metric];
  if (!t) return "good";
  if (value <= t[0]) return "good";
  if (value <= t[1]) return "needs improvement";
  return "poor";
}

/**
 * A trace field is a string only if it says so. Chrome writes whatever an event
 * means into `args.data`, so every read is narrowed rather than coerced — a
 * `renderBlocking` that arrived as a number must read as absent, not as "3".
 */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

type TraceEvent = {
  name?: string;
  ts?: number;
  dur?: number;
  ph?: string;
  /** Process/thread, used only to tell one task from its alias under another name. */
  pid?: number;
  tid?: number;
  args?: { data?: Record<string, unknown>; [k: string]: unknown };
};

export interface TraceMetrics {
  /** Milliseconds from navigation start; undefined when the trace has no such event. */
  lcpMs?: number;
  fcpMs?: number;
  /** Worst interaction latency in ms (INP proxy — the trace's slowest interaction). */
  inpMs?: number;
  /** Cumulative layout shift, user-initiated shifts excluded. */
  cls?: number;
  /** What the LCP element was, when the trace named it. */
  lcpType?: string;
  /** Slowest interactions, worst first. */
  interactions: Array<{ type: string; ms: number }>;
  /** Main-thread tasks ≥ 50 ms, worst first. */
  longTasks: Array<{ ms: number; atMs?: number }>;
  /** Total events seen — a sanity check for "did I analyse the right file?". */
  eventCount: number;
  /** Metrics the trace simply did not contain, so a gap reads as a gap, not a zero. */
  missing: string[];
  /** Where the LCP time actually went. Absent when the trace cannot support it. */
  lcpBreakdown?: LcpBreakdown;
  /** Requests that finished before first paint and held it up, slowest first. */
  renderBlocking: RenderBlocker[];
  /**
   * Insights that could NOT be computed, each saying which event was missing.
   *
   * Separate from `missing`, which is about metrics. An insight that silently
   * disappears reads as "your page is fine"; one that says "no document-request
   * timing in this trace" sends the reader to record a better one.
   */
  insightGaps: string[];
}

/**
 * The four spans that add up to LCP, in ms, as DevTools defines them.
 *
 * `loadDelayMs` and `loadDurationMs` are present only for an image LCP whose
 * request could be identified. A text LCP genuinely has no resource to load, so
 * two subparts is the correct answer there rather than a degraded one — `note`
 * says which case this is.
 */
export interface LcpBreakdown {
  ttfbMs: number;
  loadDelayMs?: number;
  loadDurationMs?: number;
  renderDelayMs: number;
  totalMs: number;
  note?: string;
}

export interface RenderBlocker {
  url: string;
  ms: number;
}

const LONG_TASK_US = 50_000;
const MAX_LISTED = 5;

// ── D18 · named insights ─────────────────────────────────────────────────────
//
// Everything below turns a number into a task: not "LCP was 3.2s" but "1.9s of
// it was the server thinking". The algorithms mirror Chrome DevTools' own
// LCPBreakdown and RenderBlocking insights, read from
// `front_end/models/trace/insights/` rather than reconstructed from memory,
// because a breakdown that disagrees with the panel the user can open is worse
// than no breakdown.
//
// **Two clocks, both microseconds, and they are comparable.** Event `ts` is a
// trace timestamp; `timing.requestTime` and `ResourceFinish.finishTime` are
// SECONDS on the same monotonic base, and `receiveHeadersStart/End` are
// milliseconds *offset from `requestTime`*. DevTools multiplies the first two by
// 1e6 and subtracts trace timestamps from the result, which is the proof that
// the bases match.

const SEC_TO_US = 1_000_000;
const MS_TO_US = 1_000;

/**
 * Chrome tags each request with the part it plays in the first paint. Three of
 * the five values do not hold the paint up, so only the other two count.
 * `potentially_blocking` is excluded deliberately: an `async` script carries it,
 * and reporting async scripts as render-blocking would be advice to "fix"
 * something already done correctly.
 */
const NON_BLOCKING = new Set([
  "non_blocking",
  "dynamically_injected_non_blocking",
  "potentially_blocking",
]);

/** One request, reassembled from the three events Chrome emits for it. */
interface Req {
  url?: string;
  resourceType?: string;
  renderBlocking?: string;
  priority?: string;
  sendTs?: number;
  /** When the response headers began arriving — the request's own "first byte". */
  firstByteTs?: number;
  finishTs?: number;
}

/**
 * Fold `ResourceSendRequest` / `ResourceReceiveResponse` / `ResourceFinish` into
 * one row per request id. All three live in `devtools.timeline`, which the
 * extension records by default, so this needs no new category and no new param.
 */
function collectRequests(list: TraceEvent[]): Map<string, Req> {
  const byId = new Map<string, Req>();
  const at = (id: unknown): Req | undefined => {
    if (typeof id !== "string" || !id) return undefined;
    let r = byId.get(id);
    if (!r) byId.set(id, (r = {}));
    return r;
  };

  for (const e of list) {
    const d = e?.args?.data;
    if (!d) continue;

    if (e.name === "ResourceSendRequest") {
      const r = at(d.requestId);
      if (!r) continue;
      r.url = str(d.url);
      r.resourceType = str(d.resourceType);
      r.renderBlocking = str(d.renderBlocking);
      r.priority = str(d.priority);
      // A redirect emits a second send for the same id; the FIRST one is when
      // the browser actually started asking, which is what every span measures
      // from. Keeping the later one would hide the redirect inside the gap.
      if (r.sendTs === undefined && typeof e.ts === "number") r.sendTs = e.ts;
      continue;
    }

    if (e.name === "ResourceReceiveResponse") {
      const r = at(d.requestId);
      if (!r) continue;
      const t = d.timing as
        | { requestTime?: number; receiveHeadersStart?: number; receiveHeadersEnd?: number }
        | undefined;
      if (t && typeof t.requestTime === "number") {
        // `receiveHeadersStart` landed in Chrome 116. On an older trace the end
        // of the headers is within a hair of their start, and DevTools makes the
        // same substitution rather than dropping the metric.
        const headers =
          typeof t.receiveHeadersStart === "number"
            ? t.receiveHeadersStart
            : typeof t.receiveHeadersEnd === "number"
              ? t.receiveHeadersEnd
              : undefined;
        if (headers !== undefined) {
          r.firstByteTs = t.requestTime * SEC_TO_US + headers * MS_TO_US;
        }
      }
      continue;
    }

    if (e.name === "ResourceFinish") {
      const r = at(d.requestId);
      if (!r) continue;
      r.finishTs =
        typeof d.finishTime === "number"
          ? d.finishTime * SEC_TO_US
          : typeof e.ts === "number"
            ? e.ts
            : undefined;
    }
  }
  return byId;
}

/** Enough of a URL to recognise it, tail-first — the filename is the useful end. */
function shortUrl(url: string, max = 72): string {
  return url.length <= max ? url : `…${url.slice(-(max - 1))}`;
}

/** An image paint candidate, keyed by process and node so the LCP can find its URL. */
type ImagePaint = { ts: number; url: string };

/**
 * Split LCP into the spans that produced it.
 *
 * The chain is indirect on purpose, because Chrome never says "the LCP resource
 * was X": `largestContentfulPaint::Candidate` carries a `nodeId`, and a separate
 * `LargestImagePaint::Candidate` carries the same id as `DOMNodeId` **plus** the
 * image URL. Joining the two is the only way to name the request — and node ids
 * are unique per renderer process, so the join must include the pid or a busy
 * page with iframes will match the wrong image.
 *
 * Returns undefined and records a gap rather than guessing. An estimated
 * breakdown is worse than none: the whole value of the feature is that the
 * reader can act on the biggest number, and acting on a fabricated one costs
 * them a day.
 */
function computeLcpBreakdown(
  anchor: number,
  lcpTs: number,
  lcpKey: string | undefined,
  imagePaints: Map<string, ImagePaint>,
  requests: Map<string, Req>,
  gaps: string[],
): LcpBreakdown | undefined {
  // The main document's first byte. Earliest Document response in this
  // navigation's window — an iframe's document is requested later, so earliest
  // is the top-level one.
  let firstByteTs: number | undefined;
  for (const r of requests.values()) {
    if (r.resourceType !== "Document" || r.firstByteTs === undefined) continue;
    if (r.firstByteTs < anchor || r.firstByteTs > lcpTs) continue;
    if (firstByteTs === undefined || r.firstByteTs < firstByteTs) firstByteTs = r.firstByteTs;
  }
  if (firstByteTs === undefined) {
    gaps.push(
      "LCP breakdown: no document-request timing in this trace, so time to first byte cannot be " +
        "measured. Record with the default categories (devtools.timeline carries ResourceReceiveResponse).",
    );
    return undefined;
  }

  const ms = (us: number) => Math.round(us / 1000);
  const ttfbMs = ms(firstByteTs - anchor);

  const paint = lcpKey ? imagePaints.get(lcpKey) : undefined;
  let lcpReq: Req | undefined;
  if (paint) {
    for (const r of requests.values()) {
      if (r.url !== paint.url || r.sendTs === undefined || r.finishTs === undefined) continue;
      if (r.sendTs < anchor || r.sendTs >= paint.ts) continue;
      if (!lcpReq || r.sendTs < lcpReq.sendTs!) lcpReq = r;
    }
  }

  let out: LcpBreakdown;
  if (lcpReq?.sendTs !== undefined && lcpReq.finishTs !== undefined) {
    out = {
      ttfbMs,
      loadDelayMs: ms(lcpReq.sendTs - firstByteTs),
      loadDurationMs: ms(lcpReq.finishTs - lcpReq.sendTs),
      renderDelayMs: ms(lcpTs - lcpReq.finishTs),
      totalMs: ms(lcpTs - anchor),
    };
  } else {
    out = {
      ttfbMs,
      renderDelayMs: ms(lcpTs - firstByteTs),
      totalMs: ms(lcpTs - anchor),
      // Two different facts, and the reader needs to know which. A text LCP has
      // nothing to download; an image whose request went unmatched means the
      // middle of this breakdown is unmeasured, not zero.
      note: paint
        ? "the LCP image's network request could not be matched in this trace, so the download is folded into render delay"
        : "text LCP — there is no resource to load, so two spans is the whole story",
    };
  }

  // Fail closed on a negative span. The spans are only meaningful because they
  // sum to LCP, and a negative one means the join picked a request that does not
  // belong to this paint — most often an image already in flight before the
  // document's headers arrived, which no ordering of these four can describe.
  // Reporting "-100ms" would be nonsense; suppressing it with the reason lets
  // the reader go and look.
  const spans = [out.ttfbMs, out.loadDelayMs, out.loadDurationMs, out.renderDelayMs];
  if (spans.some((v) => v !== undefined && v < 0)) {
    gaps.push(
      "LCP breakdown: the spans do not line up — one came out negative, which means the LCP " +
        "resource or the document request does not belong to the navigation this trace anchored " +
        "to. Record the load itself with {action:'start', reload:true, autoStop:true}.",
    );
    return undefined;
  }
  return out;
}

/**
 * Requests that finished before the first paint and were tagged as holding it up.
 *
 * Bounded by the paint rather than by the whole trace: a stylesheet that arrives
 * after the page has already painted did not block that paint, however
 * blocking its tag says it is.
 */
function computeRenderBlocking(requests: Map<string, Req>, paintTs: number): RenderBlocker[] {
  const out: RenderBlocker[] = [];
  for (const r of requests.values()) {
    if (!r.renderBlocking || NON_BLOCKING.has(r.renderBlocking)) continue;
    if (r.sendTs === undefined || r.finishTs === undefined) continue;
    if (r.finishTs > paintTs) continue;
    // `in_body_parser_blocking` is only genuinely blocking at a high enough
    // priority — a script fetched after a non-preloaded image carries the tag
    // without holding anything up. DevTools applies the same narrowing.
    if (r.renderBlocking === "in_body_parser_blocking") {
      const blockingScript = r.resourceType === "Script" && r.priority === "High";
      if (r.priority !== "VeryHigh" && !blockingScript) continue;
    }
    out.push({
      url: shortUrl(r.url ?? "(unnamed request)"),
      ms: Math.round((r.finishTs - r.sendTs) / 1000),
    });
  }
  out.sort((a, b) => b.ms - a.ms);
  return out;
}

/** Chrome names the main-thread task differently across versions; accept both. */
const TASK_NAMES = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);

/**
 * A real Chrome emits ONE task under BOTH names, microseconds apart — a 2026-08-30
 * recording carried `RunTask` at ts 8500917512 and `ThreadControllerImpl::RunTask`
 * at 8500917513, same thread, both 182ms. Accepting both names without this made
 * every long task appear TWICE, so a page looked twice as janky as it is. Neither
 * name can simply be dropped: which one a build emits varies, and dropping the
 * wrong one reports no long tasks at all.
 *
 * The two copies do NOT agree exactly — the pair above differed by 1us in start
 * and 28us in duration, because one wraps the other — so this matches on a 1ms
 * tolerance. That cannot merge two REAL long tasks: a thread runs one task at a
 * time and every task counted here is at least 50ms long, so two of them can
 * never begin within 1ms of each other.
 */
const DUPLICATE_TASK_TOLERANCE_US = 1_000;

export function analyzeTrace(events: unknown): TraceMetrics {
  const list: TraceEvent[] = Array.isArray(events) ? (events as TraceEvent[]) : [];

  // Navigation start anchors every offset. Falling back to the earliest
  // timestamp keeps a partial trace (one recorded without a reload) usable —
  // the numbers are then "since recording began", which the caller is told.
  let navStart: number | undefined;
  let earliest = Infinity;
  for (const e of list) {
    if (typeof e?.ts !== "number") continue;
    if (e.ts < earliest) earliest = e.ts;
    // The LAST navigationStart, not the first. `{reload:true}` records the old
    // page's tail before the reload, so a real page-load trace carries TWO — and
    // anchoring to the earlier one measures from a navigation the trace was not
    // recording (seen on a real trace 2026-08-27).
    if (e.name === "navigationStart" && (navStart === undefined || e.ts > navStart)) {
      navStart = e.ts;
    }
  }
  const anchor = navStart ?? (Number.isFinite(earliest) ? earliest : 0);
  const since = (ts: number) => Math.round((ts - anchor) / 1000);

  let lcpTs: number | undefined;
  let lcpType: string | undefined;
  let fcpTs: number | undefined;
  let firstPaintTs: number | undefined;
  let cls: number | undefined;
  /** `<pid>:<nodeId>` of the winning LCP element — the join key to its image. */
  let lcpKey: string | undefined;
  const imagePaints = new Map<string, ImagePaint>();
  const interactions: Array<{ type: string; ms: number }> = [];
  const longTasks: Array<{ ms: number; atMs?: number }> = [];
  /** Identity of each long task kept, so its alias under the other name is not re-counted. */
  const rawLongTasks: Array<{ pid?: number; tid?: number; ts: number; dur: number }> = [];

  for (const e of list) {
    const name = e?.name;
    if (!name) continue;

    if (name === "largestContentfulPaint::Candidate" && typeof e.ts === "number") {
      // Candidates are emitted repeatedly as the page paints; the LAST one wins,
      // which is what "largest" means once the page has settled.
      if (lcpTs === undefined || e.ts > lcpTs) {
        lcpTs = e.ts;
        lcpType = str(e.args?.data?.type);
        const nodeId = e.args?.data?.nodeId;
        lcpKey = nodeId === undefined ? undefined : `${e.pid}:${nodeId}`;
      }
      continue;
    }

    // Carries the URL the LCP candidate does not, joined on the node id below.
    if (name === "LargestImagePaint::Candidate" && typeof e.ts === "number") {
      const d = e.args?.data;
      if (d?.DOMNodeId !== undefined && typeof d.imageUrl === "string") {
        imagePaints.set(`${e.pid}:${d.DOMNodeId}`, { ts: e.ts, url: d.imageUrl });
      }
      continue;
    }

    if (name === "firstContentfulPaint" && typeof e.ts === "number") {
      if (fcpTs === undefined || e.ts < fcpTs) fcpTs = e.ts;
      continue;
    }

    // First paint, not first CONTENTFUL paint — a render-blocking resource
    // blocks the earlier of the two, and using FCP would credit a resource that
    // finished in between with blocking a paint it did not.
    if (name === "firstPaint" && typeof e.ts === "number") {
      if (firstPaintTs === undefined || e.ts < firstPaintTs) firstPaintTs = e.ts;
      continue;
    }

    if (name === "LayoutShift") {
      const d = e.args?.data ?? {};
      // A shift the user just caused (a tap, a keypress) is not layout
      // instability — excluding it is part of the CLS definition, not a filter.
      if (d.had_recent_input === true) continue;
      const score = typeof d.weighted_score_delta === "number" ? d.weighted_score_delta : d.score;
      if (typeof score === "number") cls = (cls ?? 0) + score;
      continue;
    }

    if (name === "EventTiming") {
      const d = e.args?.data ?? {};
      // Only a real INTERACTION counts: Chrome stamps those with a non-zero
      // interactionId, and without that filter every mousemove would compete
      // for "worst".
      if (!d.interactionId) continue;
      const ms =
        typeof d.duration === "number"
          ? d.duration
          : typeof e.dur === "number"
            ? e.dur / 1000
            : undefined;
      if (ms === undefined) continue;
      interactions.push({ type: String(d.type ?? "interaction"), ms: Math.round(ms) });
      continue;
    }

    if (TASK_NAMES.has(name) && typeof e.dur === "number" && e.dur >= LONG_TASK_US) {
      // Same thread, same duration, started within a hair of each other = the same
      // task seen under its two names, not two tasks.
      const ts = typeof e.ts === "number" ? e.ts : 0;
      const dup = rawLongTasks.some(
        (t) =>
          t.pid === e.pid &&
          t.tid === e.tid &&
          Math.abs(t.dur - e.dur!) <= DUPLICATE_TASK_TOLERANCE_US &&
          Math.abs(t.ts - ts) <= DUPLICATE_TASK_TOLERANCE_US,
      );
      if (!dup) {
        rawLongTasks.push({ pid: e.pid, tid: e.tid, ts, dur: e.dur });
        longTasks.push({
          ms: Math.round(e.dur / 1000),
          atMs: typeof e.ts === "number" ? since(e.ts) : undefined,
        });
      }
    }
  }

  interactions.sort((a, b) => b.ms - a.ms);
  longTasks.sort((a, b) => b.ms - a.ms);

  // The insights (D18). Requests are folded once and both insights read the
  // same table, so a 100k-event trace is still one extra pass, not two.
  const insightGaps: string[] = [];
  const requests = collectRequests(list);
  const paintTs = firstPaintTs ?? fcpTs;
  const lcpBreakdown =
    lcpTs === undefined
      ? undefined
      : computeLcpBreakdown(anchor, lcpTs, lcpKey, imagePaints, requests, insightGaps);
  const renderBlocking = paintTs === undefined ? [] : computeRenderBlocking(requests, paintTs);
  if (paintTs === undefined && requests.size > 0) {
    insightGaps.push(
      "Render-blocking resources: this trace has no first paint, so there is no paint for a " +
        "resource to have blocked.",
    );
  }

  const metrics: TraceMetrics = {
    lcpMs: lcpTs !== undefined ? since(lcpTs) : undefined,
    fcpMs: fcpTs !== undefined ? since(fcpTs) : undefined,
    inpMs: interactions[0]?.ms,
    cls,
    lcpType,
    interactions: interactions.slice(0, MAX_LISTED),
    longTasks: longTasks.slice(0, MAX_LISTED),
    eventCount: list.length,
    missing: [],
    lcpBreakdown,
    renderBlocking: renderBlocking.slice(0, MAX_LISTED),
    insightGaps,
  };

  // A metric that is absent and a metric that is zero are different facts, and
  // an agent told "CLS 0" for a trace that never recorded layout shifts will
  // report a page as perfect that was never measured.
  if (metrics.lcpMs === undefined) metrics.missing.push("LCP");
  if (metrics.fcpMs === undefined) metrics.missing.push("FCP");
  if (metrics.cls === undefined) metrics.missing.push("CLS");
  if (metrics.inpMs === undefined) metrics.missing.push("INP");

  return metrics;
}

/**
 * The insight block (D18) — the part that turns the numbers above into a task.
 *
 * Every insight owes the reader two lines: what caused it, and what to do. A
 * span with no cause line is a number they cannot act on, which is the exact
 * complaint this feature exists to answer.
 */
export function renderInsights(m: TraceMetrics): string[] {
  const out: string[] = [];
  const b = m.lcpBreakdown;

  if (b) {
    const pct = (v: number) => (b.totalMs > 0 ? ` (${Math.round((v / b.totalMs) * 100)}%)` : "");
    const span = (label: string, v: number | undefined) =>
      v === undefined ? undefined : `  ${label.padEnd(22)}${String(v).padStart(6)}ms${pct(v)}`;

    out.push(`LCP breakdown — ${b.totalMs}ms total:`);
    for (const line of [
      span("time to first byte", b.ttfbMs),
      span("resource load delay", b.loadDelayMs),
      span("resource load time", b.loadDurationMs),
      span("render delay", b.renderDelayMs),
    ]) {
      if (line) out.push(line);
    }
    if (b.note) out.push(`  (${b.note})`);

    // Name the biggest span. The advice for a slow server and the advice for a
    // late image have nothing in common, so one generic "optimise LCP" line
    // would be worth less than nothing.
    const parts: Array<[string, number]> = [
      ["ttfb", b.ttfbMs],
      ["delay", b.loadDelayMs ?? -1],
      ["download", b.loadDurationMs ?? -1],
      ["render", b.renderDelayMs],
    ];
    const [worst, worstMs] = parts.reduce((a, c) => (c[1] > a[1] ? c : a));
    const advice: Record<string, [string, string]> = {
      ttfb: [
        `the server took ${worstMs}ms to send the first byte of the HTML${pct(worstMs)} — nothing on the page could start before it`,
        "cache the document at the edge, or find what the request handler is waiting on",
      ],
      delay: [
        `the LCP image was not requested until ${worstMs}ms after the HTML arrived${pct(worstMs)} — the browser found it late`,
        "reference it in the initial HTML or preload it, instead of letting a script or a stylesheet discover it",
      ],
      download: [
        `the LCP image itself took ${worstMs}ms to download${pct(worstMs)}`,
        // Sizing first, format second, on purpose: the file may already be AVIF,
        // and "convert it to AVIF" about an .avif reads as advice from something
        // that did not look.
        "serve it smaller — sized for the viewport it appears in, and in AVIF or WebP if it is not already",
      ],
      render: [
        `${worstMs}ms passed after the content was ready before it painted${pct(worstMs)}`,
        "clear the main thread at that moment — defer scripts and cut render-blocking CSS",
      ],
    };
    out.push(`  cause: ${advice[worst][0]}.`);
    out.push(`  fix: ${advice[worst][1]}.`);
  }

  if (m.renderBlocking.length) {
    const total = m.renderBlocking.reduce((a, r) => a + r.ms, 0);
    // Two insights butted together read as one block with a stray middle.
    if (out.length) out.push("");
    out.push(
      `Render-blocking resources — ${m.renderBlocking.length} finished before first paint, ${total}ms of loading between them:`,
    );
    for (const r of m.renderBlocking) out.push(`  ${String(r.ms).padStart(6)}ms  ${r.url}`);
    out.push(
      "  cause: the browser cannot paint anything until each of these has downloaded and been parsed.",
    );
    out.push(
      "  fix: inline the CSS the first screen needs, defer or async the scripts it does not, and load the rest after paint.",
    );
  }

  // A gap is reported, never skipped — an insight that quietly vanishes reads
  // as a clean bill of health for a page that was simply not measured.
  if (m.insightGaps.length && out.length) out.push("");
  for (const g of m.insightGaps) out.push(g);
  return out;
}

/** One-line-per-metric rendering shared by `stop` and `analyze`. */
export function renderMetrics(m: TraceMetrics, navStartFound: boolean): string {
  const lines: string[] = [];
  const row = (label: string, value: number | undefined, unit: string, digits = 0) =>
    value === undefined
      ? undefined
      : `  ${label.padEnd(4)} ${value.toFixed(digits)}${unit} — ${rate(label, value)}`;

  for (const line of [
    row("LCP", m.lcpMs, "ms"),
    row("FCP", m.fcpMs, "ms"),
    row("INP", m.inpMs, "ms"),
    row("CLS", m.cls, "", 3),
  ]) {
    if (line) lines.push(line);
  }

  // A trace with no vitals is NOT a trace with nothing in it. Long tasks come
  // from a different category and are often the whole answer to "why is this
  // slow?" — discarding them here threw away 1 345 captured tasks on a real
  // trace (2026-08-27) and reported the recording as empty.
  const tasks = m.longTasks.length
    ? `Long tasks (≥50ms), worst first: ` +
      m.longTasks.map((t) => `${t.ms}ms${t.atMs !== undefined ? ` @${t.atMs}ms` : ""}`).join(", ")
    : "";

  if (lines.length === 0) {
    // Say the cause we can PROVE before the one we can only guess at. A trace with
    // no navigationStart recorded no page load at all, and these metrics only
    // exist for a load — leading with the window guess there sends someone to
    // un-minimise a window that was never the problem, which is exactly what it
    // did on 2026-08-30.
    //
    // When a navigation IS present the window is the leading suspect, verified on
    // a real browser 2026-08-27: Chrome does not paint a page in a minimised
    // window or a background tab and emits no paint metric for a paint that never
    // happened, leaving `NavStartToLargestContentfulPaint::Invalidate` behind.
    // That is the NORMAL state when an agent drives a browser.
    const why = navStartFound
      ? "Most likely: the BROWSER WINDOW WAS NOT VISIBLE. Chrome does not paint a minimised " +
        "window or a background tab, and emits no LCP/FCP/CLS for a paint that never happened — " +
        "un-minimise the window, browser_switch_tab to bring the tab to the front, and record " +
        "again. A trace recorded with custom `categories` also needs devtools.timeline, which is " +
        "where these events live."
      : "This trace contains NO PAGE LOAD (no navigationStart), and LCP/FCP/CLS only exist for " +
        "one — nothing here could have carried them. Record the load itself with " +
        "{action:'start', reload:true, autoStop:true}.";
    return (
      `No Core Web Vitals in this trace. ${why}` +
      (tasks
        ? `

${tasks}`
        : "")
    );
  }

  const head = navStartFound
    ? "Core Web Vitals (from navigation start):"
    : "Core Web Vitals (from the start of recording — no navigation in this trace, so these are NOT page-load numbers):";
  const out = [head, ...lines];

  if (m.lcpType) out.push(`  LCP element: ${m.lcpType}`);
  if (m.missing.length) out.push(`  not in this trace: ${m.missing.join(", ")}`);
  if (m.interactions.length > 1) {
    out.push(
      "  slowest interactions: " + m.interactions.map((i) => `${i.type} ${i.ms}ms`).join(", "),
    );
  }
  if (tasks) out.push(`  ${tasks[0].toLowerCase()}${tasks.slice(1)}`);

  const insights = renderInsights(m);
  if (insights.length) out.push("", ...insights);
  return out.join("\n");
}

/** Did the trace contain a real navigation? Decides which header `renderMetrics` prints. */
export function hasNavigationStart(events: unknown): boolean {
  return Array.isArray(events) && events.some((e) => (e as TraceEvent)?.name === "navigationStart");
}

// ── heap trend (D7) ───────────────────────────────────────────────────────────

/** What the extension's sampler hands back. Bytes, oldest first. */
export interface HeapTrend {
  supported: boolean;
  samples: number[];
  /**
   * The real wall-clock span the samples cover, measured in the page — NOT the
   * span that was asked for. Chrome throttles timers in a tab it is not drawing
   * to roughly once a second, so the cadence the sampler achieves is derived
   * from this rather than assumed.
   */
  elapsedMs: number;
  limit: number;
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);

/**
 * Least-squares slope through evenly spaced heap readings, in bytes per second.
 *
 * A regression rather than `(last - first) / window`, because Chrome's heap saws:
 * every garbage collection drops it a long way and the endpoints alone read
 * whatever the last GC happened to leave. Two runs of the same leaking page
 * disagreed by more than 3x on endpoints and agreed within 10% on the fit.
 *
 * Returns 0 for fewer than two samples — no trend exists, and 0 says "flat",
 * which is the honest answer when there is nothing to fit.
 */
export function heapSlopeBytesPerSec(samples: number[], intervalMs: number): number {
  const n = samples.length;
  if (n < 2 || intervalMs <= 0) return 0;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (samples[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  return den === 0 ? 0 : (num / den) * (1000 / intervalMs);
}

/**
 * Turn the readings into the paragraph an agent can act on.
 *
 * The last line is the point of the whole feature: a rising heap is NOT a leak.
 * Without that sentence the first agent to see "+2.1 MB/s" reports a memory leak
 * that is a garbage collection which has not run yet.
 */
export function renderHeapTrend(t: HeapTrend): string {
  const n = t.samples.length;
  if (!n) return "No heap readings came back.";
  // The achieved cadence, not the requested one. A throttled background tab
  // delivers half the samples, and dividing by the nominal 500ms there would
  // report a 12s watch as 6s and double every MB/s figure below.
  const intervalMs = n > 1 ? Math.round(t.elapsedMs / (n - 1)) : 0;
  const first = t.samples[0];
  const last = t.samples[n - 1];
  const slope = heapSlopeBytesPerSec(t.samples, intervalMs);
  const delta = last - first;
  const sign = (v: number) => (v >= 0 ? "+" : "-");
  return [
    `JS heap over ${(t.elapsedMs / 1000).toFixed(1)}s — ${n} samples, one every ~${intervalMs}ms`,
    `  start ${mb(first)} MB   end ${mb(last)} MB   change ${sign(delta)}${mb(Math.abs(delta))} MB`,
    `  trend ${sign(slope)}${mb(Math.abs(slope))} MB/s   (limit ${mb(t.limit)} MB)`,
    `  samples (MB): ${t.samples.map((s) => mb(s)).join(", ")}`,
    "",
    "A rising heap is not proof of a leak — a garbage collection may simply not have run in " +
      "this window. Re-run over a longer duration. To find WHAT grew, a person has to take two " +
      "snapshots in DevTools → Memory and compare them; no extension can capture one.",
  ].join("\n");
}
