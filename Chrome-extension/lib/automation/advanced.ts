/**
 * Advanced (CDP-backed) operations — Milestone 3. Each requires advanced mode
 * (chrome.debugger attached to the tab via `browser_advanced_mode`). These do
 * what the debugger-free engine cannot: set file inputs, capture full-page
 * screenshots, read network response BODIES, record perf traces, and dispatch
 * REAL (trusted) keyboard/mouse input.
 */
import * as cdp from "./cdp";
// One-way: driver.ts imports nothing from here, so this cannot cycle. The
// trusted input path reuses the synthetic path's settle so the two cannot drift.
import * as driver from "./driver";
import { runFunc } from "./run-func";

// ── advanced mode toggle ──────────────────────────────────────────────────────

export async function setAdvancedMode(
  tabId: number,
  args: { enable?: boolean },
): Promise<{
  enabled: boolean;
  attachedTabs: number[];
  tabId: number;
}> {
  if (args.enable === false) {
    await cdp.detach(tabId);
  } else if (args.enable === true) {
    await cdp.attach(tabId);
  }
  // enable === undefined → status query (no change)

  // D21 (certificate bypass) was DELETED here on 2026-09-16 along with
  // `cdp.setIgnoreCertificateErrors`. It could only ever fail — `chrome.debugger`
  // hides the CDP `Security` domain from extensions on every build measured —
  // and the server now refuses the argument by name, pointing at the two routes
  // that do work: launch with --ignore-certificate-errors, or click through the
  // warning once.
  return {
    enabled: cdp.isAttached(tabId),
    attachedTabs: cdp.attachedTabs(),
    tabId,
  };
}

async function withAttached<T>(
  tabId: number,
  keepEnabled: boolean | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const wasAttached = cdp.isAttached(tabId);
  if (!wasAttached) await cdp.attach(tabId);
  try {
    return await fn();
  } finally {
    if (!wasAttached && !keepEnabled) await cdp.detach(tabId);
  }
}

// ── ref resolution across the CDP boundary (B08) ──────────────────────────────

/**
 * Why the two CDP tools below need their own resolver at all.
 *
 * Both used to build `document.querySelector('[data-bmcp-ref="…"]')` and evaluate
 * it in the TOP execution context. That misses an element inside a shadow root
 * and an element inside a same-origin iframe — both of which have perfectly good
 * BARE refs, because the snapshot's top walk reaches into them and lists them
 * inline. The failure was `not found — take a fresh browser_snapshot`, which sent
 * an agent back for exactly the ref it already had (B08).
 *
 * `FIND_EL` is the same walk `driver.ts` and `forms.ts` use, as a string because
 * this one crosses the CDP boundary rather than being injected. It cannot reach a
 * CROSS-origin frame, and nothing evaluated in one execution context can: those
 * refs carry an `fN:` prefix and are refused by `requireTopReachable` instead.
 */
const FIND_EL =
  "(ref) => { const A = 'data-bmcp-ref'; " +
  "const walk = (root) => { const d = root.querySelector('[' + A + '=\"' + ref + '\"]'); if (d) return d; " +
  "for (const n of Array.from(root.querySelectorAll('*'))) { " +
  "if (n.shadowRoot) { const f = walk(n.shadowRoot); if (f) return f; } " +
  "if (n.tagName === 'IFRAME') { try { const doc = n.contentDocument; if (doc) { const f = walk(doc); if (f) return f; } } catch (e) {} } } " +
  "return null; }; return walk(document); }";

/**
 * The centre of an element, in the TOP document's viewport coordinates.
 *
 * `getBoundingClientRect()` is relative to the element's OWN document, so a rect
 * read inside a same-origin iframe is offset by however far that iframe sits down
 * the page. Dispatching a trusted click at an unadjusted rect aims it at the top
 * document — a click that lands on whatever happens to be there, and reports
 * success. So each iframe's own position and border are accumulated on the way
 * back up, which is what makes the coordinate mean the same thing CDP means.
 */
const REF_CENTRE =
  "(ref) => { const el = (" +
  FIND_EL +
  ")(ref); if (!el) return null; " +
  "el.scrollIntoView({block:'center',inline:'center'}); " +
  "let r = el.getBoundingClientRect(); let x = r.left + r.width/2, y = r.top + r.height/2; " +
  "let win = el.ownerDocument.defaultView; " +
  "while (win && win !== window.top && win.frameElement) { " +
  "const fr = win.frameElement.getBoundingClientRect(); " +
  "const st = win.parent.getComputedStyle(win.frameElement); " +
  "x += fr.left + parseFloat(st.borderLeftWidth || '0') + parseFloat(st.paddingLeft || '0'); " +
  "y += fr.top + parseFloat(st.borderTopWidth || '0') + parseFloat(st.paddingTop || '0'); " +
  "win = win.parent; } " +
  "return { x: Math.round(x), y: Math.round(y) }; }";

/**
 * The error for a ref these two tools genuinely cannot reach.
 *
 * Raised only AFTER the walking lookup has failed, never before it — a `fN:`
 * prefix does not by itself mean out of reach. A SAME-ORIGIN frame is prefixed
 * too since the B08 follow-up (every frame is now its own snapshot block), and
 * the top execution context can read straight into its `contentDocument`, so
 * those refs work. Refusing on the prefix alone would reject them.
 *
 * What genuinely cannot be reached is a CROSS-origin frame: a separate target
 * with its own execution context and, for `Input`, its own coordinate space.
 * Reaching it needs target auto-attach and session routing, which this extension
 * does not do. The refusal names the frame and points at the default tools, which
 * inject into it directly and do work — so there is a real next move, unlike the
 * old "not found, take a fresh snapshot" for a ref that was never wrong.
 */
function unreachableRef(ref: string, tool: string): Error {
  const framed = /^f(\d+):/.exec(ref);
  if (!framed) {
    return new Error(`Element ref "${ref}" not found — take a fresh browser_snapshot.`);
  }
  return new Error(
    `BAD_ARGS: ${tool} cannot reach "${ref}" — frame ${framed[1]} is cross-origin, and this ` +
      `tool drives the page through a single debugger session that does not extend into another ` +
      `origin's frame. Taking a fresh snapshot will not help. Use the default (non-advanced) ` +
      `tools for that frame, which inject into it directly.`,
  );
}

// ── upload_file (DOM.setFileInputFiles) ───────────────────────────────────────

export async function uploadFile(
  tabId: number,
  args: { ref: string; filePaths: string[]; keepEnabled?: boolean },
): Promise<{ ok: true; files: number }> {
  if (!args.ref) throw new Error("browser_upload_file requires a `ref` to the file input.");
  if (!Array.isArray(args.filePaths) || args.filePaths.length === 0) {
    throw new Error("browser_upload_file requires a non-empty `filePaths` array (absolute local paths).");
  }
  return withAttached(tabId, args.keepEnabled, async () => {
    // Resolve the element (by its snapshot ref) to a CDP objectId. The walk
    // reaches shadow roots and same-origin iframes — a plain top-level
    // `querySelector` missed a file input in either (B08). The frame prefix comes
    // off first, because the attribute inside the frame never carries it.
    const { bare } = driver.parseRef(args.ref);
    const evalRes = await cdp.sendCommand<any>(tabId, "Runtime.evaluate", {
      expression: `(${FIND_EL})(${JSON.stringify(bare)})`,
    });
    const objectId = evalRes?.result?.objectId;
    if (!objectId) {
      const e = unreachableRef(args.ref, "browser_upload_file");
      throw /^BAD_ARGS/.test(e.message)
        ? e
        : new Error(`${e.message} (It must be an <input type="file">.)`);
    }
    try {
      await cdp.sendCommand(tabId, "DOM.enable", {});
    } catch {
      /* ignore — setFileInputFiles works with objectId regardless */
    }
    await cdp.sendCommand(tabId, "DOM.setFileInputFiles", {
      files: args.filePaths,
      objectId,
    });
    return { ok: true, files: args.filePaths.length };
  });
}

// ── full-page screenshot (Page.captureScreenshot) ─────────────────────────────

export async function fullPageScreenshot(
  tabId: number,
  opts: { format?: "png" | "jpeg" | "webp"; quality?: number; keepEnabled?: boolean },
): Promise<{ data: string; mimeType: string }> {
  // `Page.captureScreenshot` has no webp, so a webp capture is a PNG capture the
  // caller re-encodes (`asWebp` in navigation.ts — it cannot be called from here
  // without an import cycle). Capturing lossless matters: asking CDP for jpeg
  // first would bake jpeg artefacts into the bytes the webp encoder then sees.
  //
  // Until 2026-09-14 this took `"png" | "jpeg"` while the server forwarded
  // `format` and `fullPage` together, so `{fullPage:true, format:"webp"}` was
  // silently answered with a PNG — the one capture where the saving is largest.
  const format = opts.format === "webp" ? "png" : opts.format;
  return cdpScreenshot(tabId, { ...opts, format, beyondViewport: true });
}

/**
 * `Page.captureScreenshot` against one exact tab, viewport or whole page.
 *
 * Why this exists separately from `captureVisibleTab`: the debugger-free capture
 * photographs the foreground tab OF A WINDOW, so it can neither address a
 * background tab nor produce trustworthy pixels for a window Chrome is not
 * drawing (measured: it returns a stale or blank frame with no error). CDP renders
 * the tab it is attached to, on demand, regardless of what is on screen — which is
 * the only way to photograph a background tab without stealing the user's focus.
 *
 * The cost is Chrome's "being debugged" banner for the duration. `withAttached`
 * detaches again afterwards unless `keepEnabled`, so the banner is transient.
 */
export async function cdpScreenshot(
  tabId: number,
  opts: {
    format?: "png" | "jpeg";
    quality?: number;
    keepEnabled?: boolean;
    beyondViewport?: boolean;
  },
): Promise<{ data: string; mimeType: string }> {
  const format = opts.format === "jpeg" ? "jpeg" : "png";
  const params: any = {
    format,
    captureBeyondViewport: opts.beyondViewport === true,
    fromSurface: true,
  };
  if (format === "jpeg" && typeof opts.quality === "number") {
    params.quality = Math.max(0, Math.min(100, Math.round(opts.quality)));
  }
  return withAttached(tabId, opts.keepEnabled, async () => {
    const res = await captureBounded(tabId, params);
    return { data: res.data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  });
}

/**
 * One capture attempt's ceiling.
 *
 * Sized against two opposing constraints rather than picked for feel.
 *
 * The ceiling from above: a screenshot's round-trip budget is **20s** plus 2s
 * slack (`src/vendor/config.ts` `timeouts.screenshot`, `src/relay-link.ts`).
 * Two attempts plus the nudge must finish inside that or the generic `Socket
 * message timeout` wins the race and the specific diagnosis is lost — which is
 * the entire point of this code.
 *
 * The floor from below: a full-page capture of a long document is *legitimately*
 * slow, and cutting a working capture short would manufacture the very stall
 * this is meant to detect.
 *
 * 8s clears any real capture measured here, and 8 + 8 + 1 = 17s still leaves 5s
 * of margin under the budget.
 */
const CAPTURE_TIMEOUT_MS = 8_000;

/** Did this rejection come from our own ceiling rather than from Chrome? */
function isStall(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes(cdp.CDP_NO_RESPONSE);
}

/**
 * `Page.captureScreenshot`, with the one failure that actually happens handled.
 *
 * Chrome backgrounds a hidden tab's renderer and stops producing compositor
 * frames, so a capture waits on a frame that never arrives. This is documented
 * Chrome behaviour, not a fault here — and **both fixes usually recommended for
 * it are closed to us**:
 *
 *  - activating the target first steals the user's focus, which is the one
 *    thing this tool will not trade for a picture; and
 *  - the `--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-
 *    windows` family are launch flags, and an extension cannot set them.
 *
 * `Page.setWebLifecycleState { active }` is the third door: it pulls the page
 * out of the backgrounded state from inside CDP, changing nothing the user can
 * see. It is best-effort — the method is marked experimental, so an older
 * Chrome may simply not have it — which is why the retry, not the nudge, is
 * what makes this reliable.
 *
 * **Retrying a capture is safe in a way retrying an action is not.** The
 * server's `TRANSIENT_FAILURES` deliberately excludes timeouts, because a click
 * that timed out may well have landed and re-issuing it would be a second
 * click. A screenshot has no side effect at all, so the same reasoning points
 * the other way here.
 */
async function captureBounded(
  tabId: number,
  params: Record<string, unknown>,
): Promise<{ data: string }> {
  const attempt = () =>
    cdp.sendCommand<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      params,
      CAPTURE_TIMEOUT_MS,
    );

  try {
    return await attempt();
  } catch (first) {
    if (!isStall(first)) throw first;
    try {
      await cdp.sendCommand(tabId, "Page.setWebLifecycleState", { state: "active" }, 1_000);
    } catch {
      /* experimental method, best-effort — the retry below is the real remedy */
    }
    try {
      return await attempt();
    } catch (second) {
      if (!isStall(second)) throw second;
      // Named, typed and marked retryable, so an agent knows this is a stall it
      // can come back from rather than a page it can never photograph.
      throw new Error(
        "CAPTURE_STALLED: Chrome has stopped drawing this tab — it backgrounds the " +
          "renderer of a tab nobody is looking at, and the screenshot waited for a frame " +
          "that never arrived. This usually clears on a retry. If it does not, " +
          "browser_switch_tab brings the tab to the front and always captures, at the " +
          "cost of taking the user's focus.",
      );
    }
  }
}

// ── network response body (Network.getResponseBody) ──────────────────────────

/** One candidate when a URL substring matched more than one captured request. */
export interface RequestMatch {
  requestId: string;
  method: string;
  status?: number;
  url: string;
}

export async function getNetworkRequestBody(
  tabId: number,
  args: { url?: string; requestId?: string; maxLength?: number; keepEnabled?: boolean },
): Promise<{
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  base64Encoded: boolean;
  body: string;
  truncated: boolean;
  requestId: string;
  /** Present only when `url` matched several: the others, so the agent can pick. */
  matches?: RequestMatch[];
  /** Raw. The SERVER redacts credential-bearing names before anything reaches a model. */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}> {
  return withAttached(tabId, args.keepEnabled, async () => {
    const buf = cdp.getCdpNetwork(tabId);
    if (buf.length === 0) {
      throw new Error(
        "No CDP-captured requests yet. Call browser_get_network_request with keepEnabled:true or browser_advanced_mode { enable:true }, then reload/navigate so Network events are recorded.",
      );
    }
    const brief = (e: (typeof buf)[number]): RequestMatch => ({
      requestId: e.requestId,
      method: e.method,
      status: e.status,
      url: e.url,
    });

    // Addressing by id is exact; a URL substring is not — the same URL requested
    // twice used to silently return whichever was newest, with nothing to say a
    // second one existed. Multiple matches still return the newest (so no working
    // call changes behaviour) but now carry the others' ids so the agent can ask
    // for a specific one instead of guessing.
    let entry;
    let matches: RequestMatch[] | undefined;
    if (args.requestId) {
      entry = buf.find((e) => e.requestId === args.requestId);
      if (!entry) {
        const known = buf.slice(-10).reverse().map((e) => `${e.requestId} ${e.method} ${e.status ?? "—"} ${e.url}`);
        throw new Error(
          `No captured request with requestId "${args.requestId}". ` +
            `Recently captured (newest first):\n${known.join("\n")}`,
        );
      }
    } else if (args.url) {
      const hits = buf.filter((e) => e.url.includes(args.url as string));
      entry = hits[hits.length - 1];
      if (hits.length > 1) matches = hits.map(brief);
    } else {
      entry = buf[buf.length - 1];
    }
    if (!entry) throw new Error(`No captured request matching "${args.url}".`);

    const res = await cdp.sendCommand<{ body: string; base64Encoded: boolean }>(
      tabId,
      "Network.getResponseBody",
      { requestId: entry.requestId },
    );
    let body = res.body;
    if (res.base64Encoded) {
      try {
        body = atob(res.body);
      } catch {
        /* keep base64 if decode fails (binary) */
      }
    }
    const max = args.maxLength && args.maxLength > 0 ? args.maxLength : 50000;
    let truncated = false;
    if (body.length > max) {
      body = body.slice(0, max);
      truncated = true;
    }
    return {
      url: entry.url,
      method: entry.method,
      status: entry.status,
      mimeType: entry.mimeType,
      base64Encoded: res.base64Encoded,
      body,
      truncated,
      requestId: entry.requestId,
      matches,
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders,
    };
  });
}

// ── perf trace (Tracing) ──────────────────────────────────────────────────────

/** How long autoStop waits for a load to finish before stopping the trace anyway. */
const AUTOSTOP_WAIT_MS = 30_000;

/**
 * How long autoStop keeps recording AFTER load-complete.
 *
 * Chrome emits the paint-timing events — `firstContentfulPaint`,
 * `largestContentfulPaint::Candidate`, `firstPaint` — from the compositor's
 * presentation callback, which lands AFTER `loadEventEnd`. Stopping the moment
 * loading finished cut the recording before any of them existed: the trace was
 * complete and correct in every other respect and carried NOT ONE vital, so the
 * one-call page-load profile — the documented way to use this tool — could never
 * answer the question it exists for, and the empty result blamed the window for
 * not being visible. Measured on a real Chrome 2026-08-30: the events land a few
 * tens of ms after load, so this is generous rather than tight.
 */
const AUTOSTOP_PAINT_GRACE_MS = 600;

type TraceResult = { events: unknown[]; durationMs: number; eventCount: number };

/**
 * Resolve on the NEXT load-complete for this tab, or false on timeout.
 *
 * Event-based rather than polling `tab.status`, because a poll started right
 * after `reload()` can still observe "complete" left over from the load that
 * already finished. The listener is armed BEFORE the reload is issued, so the
 * first completion it sees belongs to the new load.
 */
function nextLoadComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(v);
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function stopTrace(tabId: number): Promise<TraceResult> {
  const events = await cdp.traceStop(tabId);
  // Compute a coarse duration from event timestamps (microseconds → ms).
  let min = Infinity;
  let max = -Infinity;
  for (const ev of events as Array<{ ts?: number }>) {
    // `ts > 0` matters: a couple of dozen events in every real trace carry ts 0
    // (metadata, and events stamped before the clock is established). Including
    // them made a 7-second recording report itself as ~370 245 143 ms — four
    // days — which is what a real trace produced on 2026-08-27.
    if (typeof ev.ts === "number" && ev.ts > 0) {
      if (ev.ts < min) min = ev.ts;
      if (ev.ts > max) max = ev.ts;
    }
  }
  const durationMs = isFinite(min) && isFinite(max) ? Math.round((max - min) / 1000) : 0;
  return { events, durationMs, eventCount: events.length };
}

// ── heap size sampling (D7) ───────────────────────────────────────────────────

/**
 * Fixed sampling cadence. Deliberately NOT an argument: Chrome quantises
 * `usedJSHeapSize` into coarse buckets, so a faster cadence buys more points off
 * the same staircase, not more resolution — and every extra tool argument is paid
 * for on every request by every agent. The caller chooses the WINDOW, which is
 * the thing that actually decides whether a slow leak shows up.
 */
const MEMORY_INTERVAL_MS = 500;

export interface MemoryTrend {
  /** false on a browser without `performance.memory` — everything outside Chromium. */
  supported: boolean;
  /** `usedJSHeapSize` in bytes, oldest first. */
  samples: number[];
  /**
   * The REAL wall-clock span the samples cover, measured in the page.
   *
   * Not `count × MEMORY_INTERVAL_MS`, which is what this returned first. Chrome
   * throttles `setInterval` in a tab it is not drawing to roughly once a second,
   * and a background tab is exactly where the agent works — so a tick count would
   * have reported a 12-second watch as a 6-second one and doubled every slope in
   * MB/s. The caller derives the effective interval from this.
   */
  elapsedMs: number;
  /** `jsHeapSizeLimit` — how much headroom this tab has before it is killed. */
  limit: number;
}

/**
 * Sample the page's JS heap over a window and hand back the raw readings.
 *
 * MAIN world, not ISOLATED: `performance.memory` is what the PAGE sees, and the
 * isolated world's own `performance` is not guaranteed to expose it at all.
 *
 * Debugger-free on purpose — no banner, nothing to attach — which is what makes
 * it usable on a page the user is actually looking at. The slope is computed on
 * the server; this end stays a sampler and nothing more.
 */
export async function memoryTrend(tabId: number, durationMs: number): Promise<MemoryTrend> {
  const injected = await runFunc(
    tabId,
    (windowMs: number, intervalMs: number) =>
      new Promise((resolve) => {
        type Mem = { usedJSHeapSize: number; jsHeapSizeLimit: number };
        const mem = () => (performance as unknown as { memory?: Mem }).memory;
        const first = mem();
        if (!first) {
          resolve({ supported: false, samples: [], elapsedMs: 0, limit: 0 });
          return;
        }
        const t0 = performance.now();
        const samples: number[] = [first.usedJSHeapSize];
        const id = setInterval(() => {
          const m = mem()!;
          samples.push(m.usedJSHeapSize);
          // Stop on ELAPSED time, not on a tick count, and report the elapsed
          // time we actually got. Under background throttling these differ by 2x
          // or more, and the difference is the slope.
          const elapsedMs = Math.round(performance.now() - t0);
          if (elapsedMs >= windowMs) {
            clearInterval(id);
            resolve({ supported: true, samples, elapsedMs, limit: m.jsHeapSizeLimit });
          }
        }, intervalMs);
      }),
    [durationMs, MEMORY_INTERVAL_MS],
    "MAIN",
  );
  // chrome.scripting awaits a returned promise and hands back the RESOLVED value;
  // the type parameter cannot express that, so the unwrap is asserted here once.
  return injected as unknown as MemoryTrend;
}

export async function perfTrace(
  tabId: number,
  args: {
    action: "start" | "stop" | "memory";
    categories?: string[];
    reload?: boolean;
    autoStop?: boolean;
    durationMs?: number;
  },
): Promise<
  | { started: true; reloaded?: boolean }
  | (TraceResult & { autoStopped?: true; loadComplete?: boolean })
  | MemoryTrend
> {
  if (args.action === "memory") return memoryTrend(tabId, args.durationMs ?? 5_000);
  if (args.action !== "start") return stopTrace(tabId);

  if (!cdp.isAttached(tabId)) await cdp.attach(tabId);
  await cdp.traceStart(tabId, args.categories);
  if (!args.reload && !args.autoStop) return { started: true };

  // Arm first, reload second — see nextLoadComplete.
  const loaded = args.autoStop ? nextLoadComplete(tabId, AUTOSTOP_WAIT_MS) : undefined;
  if (args.reload) await chrome.tabs.reload(tabId);
  if (!loaded) return { started: true, reloaded: true };

  // autoStop without reload waits for whatever load is in flight; if the page is
  // already settled nothing ever fires, so the timeout stops the trace anyway and
  // says so rather than hanging.
  const loadComplete = await loaded;
  // Only worth waiting when the load actually finished — after a timeout there is
  // no paint still to come, and the caller is already waiting on a stuck page.
  if (loadComplete) await new Promise((r) => setTimeout(r, AUTOSTOP_PAINT_GRACE_MS));
  return { ...(await stopTrace(tabId)), autoStopped: true, loadComplete };
}

// ── native (trusted) input via CDP Input domain ───────────────────────────────

const CDP_MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/**
 * `text` is not cosmetic: it is what makes the renderer synthesise the `keypress`
 * and run the key's DEFAULT ACTION. A bare `rawKeyDown` fires `keydown` listeners
 * and nothing else — so trusted Enter moved focus, reported success, and did not
 * submit the form. That is the identical silent no-op the mouse path hit before
 * `buttons` was added below; found by the integration suite on 2026-09-01.
 *
 * Only the keys whose default action needs a character carry it. Tab, Escape and
 * the arrows act on `rawKeyDown` alone and must NOT gain a text payload, or they
 * would additionally type a character into the focused field.
 */
const NAMED_KEY: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
};

/**
 * Trusted input is DISCARDED for a tab Chrome is not drawing — a minimised window,
 * or a background tab. `Input.dispatchMouseEvent` still reports success, so the
 * agent is told the click landed and the page never moved. A silent no-op is the
 * worst outcome available: an error makes an agent look, a false success makes it
 * build on something that did not happen.
 *
 * A minimised window is the NORMAL state for an agent-driven browser, so this
 * refusal fires often and has to name both ways out — restoring the window, and
 * the synthetic path, which works fine in a hidden tab because it never leaves
 * the renderer.
 */
async function requireComposited(tabId: number, what: string): Promise<void> {
  const r = await cdp.sendCommand<any>(tabId, "Runtime.evaluate", {
    expression: "document.visibilityState",
    returnByValue: true,
  });
  if (r?.result?.value === "visible") return;
  throw new Error(
    `Cannot send trusted ${what}: Chrome is not drawing this tab (the window is minimised, ` +
      `or this is a background tab) and DISCARDS real input aimed at it — the call would ` +
      `report success and do nothing. Restore the browser window (or browser_switch_tab to ` +
      `this tab), or turn browser_advanced_mode off to use the synthetic ${what}, which ` +
      `works in a hidden tab.`,
  );
}

/**
 * Same contract as `nativeClick`, and same reason: `driver.pressKey` settles and
 * reports `navigated`, so the trusted twin must too. This is the more damaging
 * half of the two — pressing Enter is how a form gets submitted, so returning
 * before the navigation settles hands the next call a page that is still moving.
 */
export async function nativeKey(
  tabId: number,
  combo: string,
  opts: driver.SettleOptions = {},
): Promise<driver.ActionResult> {
  cdp.requireAttached(tabId);
  await requireComposited(tabId, "key press");
  const urlBefore = await driver.currentUrl(tabId);
  // Parse modifier combos ("Control+A"); trailing "++" = literal "+".
  let key = combo;
  const parts: string[] = [];
  if (combo.length > 1 && combo.includes("+")) {
    if (combo.endsWith("++")) {
      key = "+";
      combo.slice(0, -2).split("+").forEach((m) => m && parts.push(m));
    } else {
      const split = combo.split("+").map((s) => s.trim()).filter(Boolean);
      key = split.pop() ?? combo;
      parts.push(...split);
    }
  }
  const low = parts.map((m) => m.toLowerCase());
  let modifiers = 0;
  if (low.includes("control") || low.includes("ctrl")) modifiers |= CDP_MOD.ctrl;
  if (low.includes("shift")) modifiers |= CDP_MOD.shift;
  if (low.includes("alt") || low.includes("option")) modifiers |= CDP_MOD.alt;
  if (low.includes("meta") || low.includes("cmd") || low.includes("command")) modifiers |= CDP_MOD.meta;

  const named = NAMED_KEY[key];
  const isChar = !named && key.length === 1;
  // A Ctrl/Meta combo is a SHORTCUT, never a character: "Control+A" selects all,
  // it does not type an "a". So the text payload is suppressed for both the named
  // keys and the plain characters when either of those modifiers is held.
  const shortcut = !!(modifiers & CDP_MOD.ctrl) || !!(modifiers & CDP_MOD.meta);
  const text = shortcut ? undefined : (named?.text ?? (isChar ? key : undefined));
  const base: any = {
    modifiers,
    key: named ? named.key : key,
    code: named ? named.code : isChar ? `Key${key.toUpperCase()}` : key,
    windowsVirtualKeyCode: named ? named.vk : isChar ? key.toUpperCase().charCodeAt(0) : 0,
  };
  await cdp.sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    ...base,
    text,
  });
  await cdp.sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return driver.settleAfterAction(tabId, urlBefore, opts);
}

/**
 * `<tag#id> "label"` — the description the synthetic path returns as `hit`.
 *
 * Inlined as source rather than shared with `driver.ts`, because that one runs
 * inside an injected function and this one has to cross the CDP boundary as a
 * string. Kept character-for-character equivalent on purpose: two paths that
 * describe the same element differently are a worse bug than either alone.
 */
const DESCRIBE_EL =
  "(el) => { if (!el) return null; " +
  "const name = (el.getAttribute('aria-label') || el.getAttribute('alt') || el.innerText || el.textContent || '')" +
  ".replace(/\\s+/g, ' ').trim().slice(0, 60); " +
  "return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>' + (name ? ' \"' + name + '\"' : ''); }";

/**
 * A trusted click, returning **the same shape as the synthetic one**.
 *
 * It used to return a bare `{ok:true}`, so turning `browser_advanced_mode` on —
 * for an unrelated reason, like reading a response body — silently changed both
 * what a click reported and how long it took: no `hit` naming what was under the
 * point, and no post-action settle, so the next call could race a navigation the
 * default path would have waited out. An agent cannot reasonably be expected to
 * know that one mode reshapes another tool's reply.
 *
 * Matched to `driver.click` deliberately, including where it stops: the
 * coordinate form carries `hit`, the ref form does not, and neither carries
 * `recovered`/`domSettled` here because those describe the injected op's
 * ref-recovery, which the trusted path genuinely does not do. Reporting them
 * would be inventing a result rather than reporting one.
 */
export async function nativeClick(
  tabId: number,
  args: { ref?: string; x?: number; y?: number; dblClick?: boolean } & driver.SettleOptions,
): Promise<driver.ActionResult & { hit?: string }> {
  cdp.requireAttached(tabId);
  await requireComposited(tabId, "click");
  const urlBefore = await driver.currentUrl(tabId);
  // A2 on the trusted path: a coordinate needs no element lookup at all - it is
  // already what Input.dispatchMouseEvent wants. It still needs the hit-report,
  // because a coordinate click that lands on the wrong thing is otherwise silent.
  if (typeof args.x === "number" && typeof args.y === "number") {
    const at = await cdp.sendCommand<any>(tabId, "Runtime.evaluate", {
      expression: `(${DESCRIBE_EL})(document.elementFromPoint(${args.x}, ${args.y}))`,
      returnByValue: true,
    });
    await dispatchClick(tabId, args.x, args.y, args.dblClick === true);
    return {
      ...(await driver.settleAfterAction(tabId, urlBefore, args)),
      hit: at?.result?.value ?? undefined,
    };
  }
  // Same two corrections as the upload path (B08): a same-origin or shadow-DOM
  // element is found by the walking resolver and its centre translated into the
  // TOP viewport's coordinates — `Input.dispatchMouseEvent` speaks only that
  // space, and a frame-relative point would click whatever sat there in the top
  // document and report success. A cross-origin one cannot be found from here at
  // all, and is refused with the frame as the reason.
  const { bare } = driver.parseRef(args.ref!);
  const rect = await cdp.sendCommand<any>(tabId, "Runtime.evaluate", {
    expression: `(${REF_CENTRE})(${JSON.stringify(bare)})`,
    returnByValue: true,
  });
  const pt = rect?.result?.value;
  if (!pt) throw unreachableRef(args.ref!, "a trusted browser_click");
  await dispatchClick(tabId, pt.x, pt.y, args.dblClick === true);
  return driver.settleAfterAction(tabId, urlBefore, args);
}

/**
 * One trusted click (or two, for a double) at a viewport point.
 *
 * `buttons` is NOT optional in practice. It is the bitmask of buttons held DURING
 * the event (1 = left), and it is separate from `button`, which names the button
 * that changed. Omitting it sends a press that claims no button is down, and the
 * renderer then never synthesises the `click` — the command SUCCEEDS and the page
 * does nothing, which is worse than an error because the agent is told it worked.
 * Every trusted click was a silent no-op until this was added.
 *
 * The leading `mouseMoved` is what real input does: it sets the hover state first,
 * so a control that only becomes clickable on hover is actually reachable.
 */
async function dispatchClick(
  tabId: number,
  x: number,
  y: number,
  dbl: boolean,
): Promise<void> {
  await cdp.sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  for (let i = 1; i <= (dbl ? 2 : 1); i++) {
    const common = { x, y, button: "left", clickCount: i };
    await cdp.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...common,
      buttons: 1,
    });
    await cdp.sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...common,
      buttons: 0,
    });
  }
}
