/**
 * Navigation / timing handlers. The core is pure `chrome.tabs` (no CDP); two
 * OPT-IN extras require advanced mode because no debugger-free API can do them:
 *
 *   initScript          — `chrome.scripting.registerContentScripts` takes bundled
 *                         FILE PATHS, never code supplied at call time, so running
 *                         the agent's JS before any page script needs
 *                         `Page.addScriptToEvaluateOnNewDocument`.
 *   handleBeforeUnload  — a "Leave site?" prompt is native browser chrome. Page JS
 *                         cannot see or answer it; only `Page.handleJavaScriptDialog`
 *                         can. (The existing `__bmcpDialogPolicy` hook covers
 *                         alert/confirm/prompt only — a different mechanism.)
 *
 * Both refuse with a self-healing message when advanced mode is off, rather than
 * silently doing nothing or falling back to something that only usually works.
 */
import { cdpScreenshot } from "./advanced";
import * as cdp from "./cdp";
import { domQuietPage, parseRef } from "./driver";
import { inFlight, lastMainFrame } from "./network";
import { runFunc } from "./run-func";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type NavResult = {
  ok: true;
  navigated: boolean;
  urlBefore?: string;
  urlAfter?: string;
  settled: boolean;
  elapsedMs: number;
  /** Set when the load ended on Chrome's own error page (F1). */
  loadError?: string;
  failedUrl?: string;
};
type SettleOptions = {
  waitUntil?: "none" | "auto" | "load" | "networkidle";
  settleMs?: number;
};

async function currentUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

/** Whole-transition budgets, in ms. */
const NAV_TIMEOUT_MS = 15000;
const HISTORY_TIMEOUT_MS = 10000;

/**
 * How long a transition has to BEGIN before we stop believing one was requested.
 *
 * Not every issued navigation produces a document: a link that turns out to be a
 * download, a "Leave site?" prompt nobody answers, a forward entry that quietly
 * does nothing. Without this the call would block for its whole budget waiting
 * for a load that is never coming. Reaching it reports `settled: false` — never
 * `true` — so a genuinely slow start can only ever cost the accuracy of that
 * flag, never correctness.
 *
 * ponytail: one fixed grace. Make it adaptive only if a real page is measured
 * taking longer than this to report `loading` after the transition was issued.
 */
const NAV_START_GRACE_MS = 1000;

/**
 * Whether the tab is mid-transition, asked of the TAB rather than of the event
 * stream — the second witness the start grace was missing (B12).
 *
 * `onUpdated` is not the only place the truth lives, and it is not a reliable
 * one on its own: Chrome can have a navigation underway, with the tab itself
 * reporting `status: "loading"`, without this listener ever having received the
 * `loading` update that says so. Believing only the events then reports "nothing
 * began" about a navigation that is in flight, and the caller is told its page
 * did not load while the browser is still fetching it.
 *
 * Measured on a real Chrome (2026-09-13): a certificate interstitial, which
 * Chrome re-attempts after roughly 3 s once a host has failed before, was
 * `status: "loading"` at every expiry of the 1 s grace and then committed at
 * 3.08 s — comfortably inside the 15 s budget it had been denied. The same
 * `chrome.tabs.get` confirmation already guards the same-document branch below;
 * this is the branch that was trusting the events alone.
 *
 * A transition that genuinely never begins — a url that turns out to be a
 * download, an unanswered "Leave site?", a forward entry that was not there —
 * leaves the tab `complete`, so the grace still ends those in about a second.
 */
async function transitionUnderway(tabId: number): Promise<boolean> {
  try {
    return (await chrome.tabs.get(tabId)).status === "loading";
  } catch {
    return false;
  }
}

interface NavWatch {
  /** When the watch was armed — just before the transition was issued. */
  readonly armedAt: number;
  /**
   * Resolve once the armed transition concludes. `budgetMs` is measured from
   * when the watch was ARMED, not from this call, so asking twice (once for the
   * caller, once to time teardown) shares one budget instead of doubling it.
   */
  settled(budgetMs: number): Promise<boolean>;
  /** Drop every listener. Safe to call twice; always called. */
  dispose(): void;
}

/**
 * Watch a tab for the transition that is about to be issued (B09).
 *
 * What this replaces polled `tab.status === "complete"`. Straight after
 * `chrome.tabs.reload` the tab still reports the PREVIOUS document as complete,
 * so the poll matched on its very first tick: reload returned `settled: true` in
 * 0 ms, and the init script was torn down before the new document existed.
 *
 * A status on its own cannot say WHICH document it belongs to. A transition can:
 * `loading` and then `complete` is one navigation, and requiring the `loading`
 * first is the whole of what ties the answer to the navigation we asked for. So
 * the watch is armed BEFORE the transition is issued — arming afterwards is the
 * same mistake in a different place.
 *
 * `chrome.tabs`, not `chrome.webNavigation`: the extension already holds the
 * "tabs" permission, and webNavigation would add an install-time warning that
 * DISABLES the extension until the user re-approves it — for a signal that is
 * already free. `advanced.ts`'s `nextLoadComplete` arms the same event for trace
 * autostop; it deliberately takes any next `complete`, which is right there and
 * would be the B09 bug here.
 */
function watchNavigation(tabId: number): NavWatch {
  const armedAt = Date.now();
  let outcome: boolean | undefined;
  let settle!: (ok: boolean) => void;
  const concluded = new Promise<boolean>((resolve) => {
    settle = (ok) => {
      if (outcome !== undefined) return;
      outcome = ok;
      resolve(ok);
    };
  });

  let started = false;
  const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId) return;
    if (info.status === "loading") {
      started = true;
      return;
    }
    if (started) {
      if (info.status === "complete") settle(true);
      return;
    }
    // A same-document move — a hash, a `pushState`, a history step inside one
    // document — reports a new url and never loads at all, so waiting for a
    // `complete` that is not coming would hold the call for its whole budget.
    // Confirm against the tab before believing it: a cross-document navigation
    // whose url happens to arrive first is still `loading` here, and `started`
    // will be set a moment later either way.
    if (info.url) {
      void chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (!started && tab.status === "complete") settle(true);
        })
        .catch(() => settle(false));
    }
  };
  // A tab that is gone will never finish anything. Say so now rather than
  // holding the caller until the timeout.
  const onRemoved = (id: number) => {
    if (id === tabId) settle(false);
  };
  const onReplaced = (_added: number, removed: number) => {
    if (removed === tabId) settle(false);
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onReplaced.addListener(onReplaced);

  return {
    armedAt,
    async settled(budgetMs: number): Promise<boolean> {
      if (outcome !== undefined) return outcome;
      // The timer is cleared the moment the navigation concludes: a 15 s handle
      // left running after a fast load is exactly the kind of drip this file
      // must not add, one per navigation.
      const deadline = (span: number) =>
        new Promise<"expired">((resolve) => {
          const handle = setTimeout(
            () => resolve("expired"),
            Math.max(0, armedAt + span - Date.now()),
          );
          void concluded.then(() => clearTimeout(handle));
        });
      // Capped by the caller's budget, never added to it: a `settleMs: 400` call
      // asked to give up at 400 ms, and a grace that outran it would quietly turn
      // every short settle into a one-second one.
      const begun = await Promise.race([
        concluded,
        deadline(Math.min(NAV_START_GRACE_MS, budgetMs)),
      ]);
      if (begun !== "expired") return begun;
      if (!started && !(await transitionUnderway(tabId))) return false;
      // The tab said it is loading, so one IS underway even though no event
      // reached this listener. Treat it as begun, or the `complete` that ends it
      // would be read as a stray update about some other document and ignored.
      started = true;
      const finished = await Promise.race([concluded, deadline(budgetMs)]);
      return finished === "expired" ? false : finished;
    },
    dispose() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onReplaced.removeListener(onReplaced);
      // Release anything still awaiting `concluded`, so a disposed watch can
      // never keep a caller — or a timer — alive.
      settle(false);
    },
  };
}

/**
 * After the load (F14). The load event fires before a script-rendered page has
 * drawn anything, so the default snapshot read YouTube's empty shell (T35).
 * Both waits come out of the caller's settle budget, never on top of it.
 */
const QUIET_MS = 300; // mutation-free window that counts as "the page has drawn"
const QUIET_CAP_MS = 1500;
const IDLE_MS = 500; // no request in flight for this long = "network idle"
// ponytail: fixed cap. A page holding a long-poll or a socket never goes idle,
// so "networkidle" there always costs the full cap; per-type filtering if that bites.
const IDLE_CAP_MS = 5000;

async function pageQuiet(tabId: number, budgetMs: number): Promise<void> {
  if (budgetMs <= 0) return;
  try {
    await runFunc(tabId, domQuietPage, [QUIET_MS, Math.min(QUIET_CAP_MS, budgetMs)]);
  } catch {
    /* a page that refuses injection (an error page) has nothing to wait for */
  }
}

async function networkIdle(tabId: number, sinceTs: number, budgetMs: number): Promise<void> {
  const end = Date.now() + Math.min(IDLE_CAP_MS, Math.max(budgetMs, 0));
  let idleSince = Date.now();
  while (Date.now() < end) {
    if ((await inFlight(tabId, sinceTs)) > 0) idleSince = Date.now();
    else if (Date.now() - idleSince >= IDLE_MS) return;
    await wait(100);
  }
}

async function finishNavigation(
  tabId: number,
  urlBefore: string | undefined,
  timeoutMs: number,
  watch: NavWatch,
  opts: SettleOptions = {},
): Promise<NavResult> {
  const startedAt = Date.now();
  const waitUntil = opts.waitUntil ?? "auto";
  const effectiveTimeout =
    waitUntil === "none"
      ? 0
      : Math.min(Math.max(opts.settleMs ?? timeoutMs, 0), timeoutMs);
  const settled = effectiveTimeout > 0 ? await watch.settled(effectiveTimeout) : false;
  const left = () => effectiveTimeout - (Date.now() - startedAt);
  if (settled && waitUntil === "auto") await pageQuiet(tabId, left());
  if (settled && waitUntil === "networkidle") await networkIdle(tabId, watch.armedAt, left());
  const urlAfter = await currentUrl(tabId);
  // F1: Chrome's error page loads like any page, so "settled" alone said ok about
  // a host that never answered. Asked only of a load that FINISHED: a download
  // also aborts its top-level request, but it never loads, so it is not a failure.
  const failed = settled ? await lastMainFrame(tabId, watch.armedAt) : undefined;
  return {
    ok: true,
    navigated: !!urlBefore && !!urlAfter && urlBefore !== urlAfter,
    urlBefore,
    urlAfter,
    settled,
    elapsedMs: Date.now() - startedAt,
    ...(failed?.error ? { loadError: failed.error, failedUrl: failed.url } : {}),
  };
}

/**
 * Navigate the tab and resolve once it finishes loading (or a short timeout).
 *
 * `reload` re-requests the CURRENT page instead of going somewhere new, and
 * `ignoreCache` makes that a hard reload — the answer to "but I already fixed
 * that", which a plain navigate to the same URL cannot give you because the
 * cached response is what it serves.
 */
export async function navigate(
  tabId: number,
  url: string | undefined,
  opts?: SettleOptions & {
    reload?: boolean;
    ignoreCache?: boolean;
    initScript?: string;
    handleBeforeUnload?: "accept" | "dismiss";
  },
): Promise<NavResult & { initScript?: "installed"; beforeUnload?: "accept" | "dismiss" }> {
  if (!opts?.reload && !url) throw new Error("navigate needs a url unless reload is set");
  const urlBefore = await currentUrl(tabId);

  // Arm all three BEFORE the navigation is issued. An init script registered
  // after the commit is already too late; a beforeunload prompt fires the
  // instant the navigation starts, so arming afterwards would be arming after
  // the hang; and a watch started afterwards sees the PREVIOUS document sitting
  // at `complete` and calls the new load finished before it began (B09).
  let initId: string | undefined;
  let prevPolicy: { action: "accept" | "dismiss"; promptText?: string } | null = null;
  let policyArmed = false;
  if (opts?.initScript) {
    cdp.requireAttached(tabId);
    initId = await cdp.addInitScript(tabId, opts.initScript);
  }
  if (opts?.handleBeforeUnload) {
    cdp.requireAttached(tabId);
    prevPolicy = cdp.setDialogPolicy(tabId, { action: opts.handleBeforeUnload });
    policyArmed = true;
  }
  const watch = watchNavigation(tabId);

  try {
    if (opts?.reload) {
      await chrome.tabs.reload(tabId, { bypassCache: opts.ignoreCache === true });
    } else {
      await chrome.tabs.update(tabId, { url });
    }
    const r = await finishNavigation(tabId, urlBefore, NAV_TIMEOUT_MS, watch, opts);
    return {
      ...r,
      ...(initId ? { initScript: "installed" as const } : {}),
      ...(opts?.handleBeforeUnload ? { beforeUnload: opts.handleBeforeUnload } : {}),
    };
  } finally {
    // `finally`, not the success path: a navigation that never commits must not
    // leave the agent's script running on every future page of this tab, nor
    // leave dialogs being answered by a policy nobody remembers arming.
    //
    // But teardown has to outlive the COMMIT, not the call. `waitUntil: "none"`
    // returns before the new document exists — removing the init script there
    // means it never runs, which is the half of B09 that made `initScript:
    // "installed"` a lie. So when either is armed, wait for the transition
    // first. Both waits share one budget measured from when the watch was armed,
    // so this cannot double a timeout, and the start grace caps a navigation
    // that never began at ~1 s rather than the full 15.
    if (initId || policyArmed) await watch.settled(NAV_TIMEOUT_MS);
    if (initId) await cdp.removeInitScript(tabId, initId);
    if (policyArmed) cdp.setDialogPolicy(tabId, prevPolicy);
    watch.dispose();
  }
}

export async function goBack(tabId: number, opts?: SettleOptions): Promise<NavResult> {
  const urlBefore = await currentUrl(tabId);
  // Armed before the step is taken, for the same reason as `navigate`: a history
  // move that restores a document from the back/forward cache finishes in
  // milliseconds, and a watch started afterwards would answer about the page we
  // just left. A step that stays inside one document never loads at all, and is
  // recognised instead by its url changing while the tab stays complete.
  const watch = watchNavigation(tabId);
  try {
    await chrome.tabs.goBack(tabId);
    return await finishNavigation(tabId, urlBefore, HISTORY_TIMEOUT_MS, watch, opts);
  } finally {
    watch.dispose();
  }
}

export async function goForward(tabId: number, opts?: SettleOptions): Promise<NavResult> {
  const urlBefore = await currentUrl(tabId);
  // Armed before the step is taken, for the same reason as `navigate`: a history
  // move that restores a document from the back/forward cache finishes in
  // milliseconds, and a watch started afterwards would answer about the page we
  // just left. A step that stays inside one document never loads at all, and is
  // recognised instead by its url changing while the tab stays complete.
  const watch = watchNavigation(tabId);
  try {
    await chrome.tabs.goForward(tabId);
    return await finishNavigation(tabId, urlBefore, HISTORY_TIMEOUT_MS, watch, opts);
  } finally {
    watch.dispose();
  }
}

export async function waitSeconds(time: number): Promise<{ ok: true }> {
  await wait(time * 1000);
  return { ok: true };
}

/**
 * Best-effort screenshot of the tab's visible viewport via captureVisibleTab.
 * Supports `png` (default) or `jpeg` (+ `quality`). Returns `{ data, mimeType }`;
 * the server tolerates the old plain-string form too. Full-page capture needs
 * CDP (Milestone 3's opt-in debugger mode) — captureVisibleTab is viewport-only.
 *
 * captureVisibleTab returns the FOREGROUND tab of a window, not an arbitrary tab.
 * When two IDEs drive two tabs of one browser, the target may be a background
 * tab — capturing then would silently return the wrong tab's pixels, so we
 * refuse with an actionable error instead (use fullPage / foreground the tab).
 */
/**
 * A3: crop a viewport capture to one element, and/or re-encode it.
 *
 * `captureVisibleTab` can only return PNG or JPEG of the WHOLE visible viewport,
 * so both halves of A3 go through the same place: decode the capture, take the
 * region we want, re-encode. webp is therefore a re-encode, not a capture
 * format — Chrome's capture API has no webp.
 *
 * The scale factor is the part that is easy to get silently wrong:
 * `getBoundingClientRect` is in CSS pixels and the capture is in DEVICE pixels,
 * so on any HiDPI screen a raw crop would cut the wrong region. Deriving it from
 * the bitmap's own width beats reading devicePixelRatio, because it is measured
 * against the very image being cropped.
 */

/** Element rect in CSS pixels, plus the viewport it was measured against. */
function elementRectPage(ref: string): {
  ok: boolean;
  error?: string;
  code?: string;
  rect?: { x: number; y: number; w: number; h: number };
  viewportWidth?: number;
} {
  const REF_ATTR = "data-bmcp-ref";
  const find = (root: Document | ShadowRoot): HTMLElement | null => {
    const direct = root.querySelector(`[${REF_ATTR}="${ref}"]`) as HTMLElement | null;
    if (direct) return direct;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) {
        const found = find(shadow);
        if (found) return found;
      }
    }
    return null;
  };
  const el = find(document);
  if (!el) {
    return { ok: false, code: "REF_NOT_FOUND", error: `Element ref "${ref}" not found.` };
  }
  // captureVisibleTab can only ever return what is on screen, so an element
  // below the fold has to be brought into it first.
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    return {
      ok: false,
      code: "NOT_ACTIONABLE",
      error: `Element ref "${ref}" has no visible area (${r.width}x${r.height}) — nothing to capture.`,
    };
  }

  // This may be running INSIDE a frame, and the capture is of the whole tab — so
  // a rect measured here is offset by however far this frame sits down the page.
  // Walk up through each `frameElement`, adding its position and its border and
  // padding, until the top window is reached. That, and only that, turns a
  // frame-relative rect into one that means the same thing as the picture.
  //
  // `frameElement` is null across an ORIGIN boundary, so the chain simply cannot
  // be completed for a cross-origin frame. Saying so is the honest answer;
  // cropping with the unadjusted rect would return a confidently wrong region of
  // the page, which is the failure this exists to prevent.
  let offsetX = 0;
  let offsetY = 0;
  let win: Window = window;
  while (win !== window.top) {
    let owner: Element | null = null;
    try {
      owner = win.frameElement;
    } catch {
      owner = null;
    }
    if (!owner) {
      return {
        ok: false,
        code: "CROSS_ORIGIN_FRAME",
        error:
          `Element ref "${ref}" is inside a cross-origin frame, and its position in the page ` +
          `cannot be measured from outside that frame. A screenshot covers the whole tab, so ` +
          `there is no correct region to crop. Capture without \`ref\` and read the frame's ` +
          `area from the full picture instead.`,
      };
    }
    const parent = win.parent;
    const fr = owner.getBoundingClientRect();
    const st = parent.getComputedStyle(owner);
    offsetX += fr.left + parseFloat(st.borderLeftWidth || "0") + parseFloat(st.paddingLeft || "0");
    offsetY += fr.top + parseFloat(st.borderTopWidth || "0") + parseFloat(st.paddingTop || "0");
    win = parent;
  }

  const top = window.top!;
  const left = r.left + offsetX;
  const topY = r.top + offsetY;
  // Clamp to the TOP viewport: only the on-screen part of it exists in the
  // capture, and "on screen" is the tab's viewport, never the frame's.
  const x = Math.max(left, 0);
  const y = Math.max(topY, 0);
  const w = Math.min(left + r.width, top.innerWidth) - x;
  const h = Math.min(topY + r.height, top.innerHeight) - y;
  if (w <= 0 || h <= 0) {
    return {
      ok: false,
      code: "NOT_ACTIONABLE",
      error: `Element ref "${ref}" is off screen even after scrolling to it — nothing to capture.`,
    };
  }
  return { ok: true, rect: { x, y, w, h }, viewportWidth: top.innerWidth };
}

/** Decode, optionally crop, re-encode. Returns base64 (no data: prefix). */
async function reencode(
  dataUrl: string,
  mimeType: string,
  quality: number | undefined,
  crop: { x: number; y: number; w: number; h: number } | undefined,
  cssViewportWidth: number | undefined,
): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  // CSS px -> device px, measured against this very image.
  const scale = cssViewportWidth ? bitmap.width / cssViewportWidth : 1;
  const sx = crop ? Math.round(crop.x * scale) : 0;
  const sy = crop ? Math.round(crop.y * scale) : 0;
  const sw = crop ? Math.max(1, Math.round(crop.w * scale)) : bitmap.width;
  const sh = crop ? Math.max(1, Math.round(crop.h * scale)) : bitmap.height;
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable in this browser.");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return encode(canvas, mimeType, quality);
}

/** Canvas -> base64 (no `data:` prefix), honouring `quality` for lossy formats. */
async function encode(
  canvas: OffscreenCanvas,
  mimeType: string,
  quality: number | undefined,
): Promise<string> {
  const blob = await canvas.convertToBlob({
    type: mimeType,
    ...(typeof quality === "number" ? { quality: Math.max(0, Math.min(100, quality)) / 100 } : {}),
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
  return btoa(binary);
}

/**
 * Re-encode a capture as webp.
 *
 * Chrome's capture APIs produce png/jpeg only, so webp is never a capture format
 * — always a re-encode (see `screenshot`, which does its own inline). The
 * FULL-PAGE path renders through CDP in `advanced.ts`, and that module cannot
 * import this one back without a cycle, so its conversion happens at the shared
 * call site in `automation/index.ts`.
 */
export async function asWebp<T extends { data: string; mimeType: string }>(
  shot: T,
  quality: number | undefined,
): Promise<T> {
  if (shot.mimeType === "image/webp") return shot;
  return {
    ...shot,
    mimeType: "image/webp",
    data: await reencode(
      `data:${shot.mimeType};base64,${shot.data}`,
      "image/webp",
      quality,
      undefined,
      undefined,
    ),
  };
}

/** What a capture came back as, and what it was before a ceiling shrank it. */
export interface CaptureSize {
  width?: number;
  height?: number;
  scaledFrom?: { width: number; height: number };
}

/**
 * D17: hold a capture under the server's width/height ceiling, aspect preserved.
 *
 * It runs HERE, in the extension, rather than on the server for one reason: the
 * oversized bytes then never cross the WebSocket at all. Downscaling after the
 * relay has already carried a 1.2 MB full-page PNG would save the context window
 * and nothing else — and Node has no image decoder, so the server would need a
 * dependency to do what `OffscreenCanvas` does here for free.
 *
 * Three deliberate choices:
 *
 * 1. **No ceiling means not even a decode.** The server sends one only for an
 *    image coming back inline, so a `filePath` capture and every frame of a
 *    strip pass through here byte-identical, at zero added cost. Setting both
 *    env vars to 0 does the same for everything.
 * 2. **An image already under the ceiling is returned untouched**, not
 *    re-encoded. A PNG round-tripped through a canvas for no reason would change
 *    its bytes and buy nothing — and would make them BIGGER: re-encoding a
 *    downscaled screenshot as PNG measured 60-91% larger than Chrome's own
 *    capture, which is why the server keeps this off the file path entirely.
 * 3. **`scaledFrom` is reported, always.** An agent measuring pixels against a
 *    silently shrunk screenshot measures the wrong page; the server turns this
 *    into a line in the reply.
 *
 * The single call site is the `browser_screenshot` handler, so every path —
 * viewport, full page and element crop — is covered by one place rather than
 * three that can drift apart.
 */
export async function capToCeiling<T extends { data: string; mimeType: string }>(
  shot: T,
  opts: { maxWidth?: number; maxHeight?: number; quality?: number },
): Promise<T & CaptureSize> {
  // 0 (or absent, or nonsense) means "this dimension is not capped".
  const mw = Number(opts.maxWidth) > 0 ? Number(opts.maxWidth) : 0;
  const mh = Number(opts.maxHeight) > 0 ? Number(opts.maxHeight) : 0;
  if (!mw && !mh) return shot;

  const bitmap = await createImageBitmap(
    await (await fetch(`data:${shot.mimeType};base64,${shot.data}`)).blob(),
  );
  const from = { width: bitmap.width, height: bitmap.height };
  const scale = Math.min(1, mw ? mw / from.width : 1, mh ? mh / from.height : 1);
  if (scale >= 1) {
    bitmap.close();
    return { ...shot, ...from };
  }

  const width = Math.max(1, Math.round(from.width * scale));
  const height = Math.max(1, Math.round(from.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable in this browser.");
  // A 0.24x downscale through the default filter aliases text into mush, which
  // is the one thing a screenshot ceiling must not do.
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { ...shot, data: await encode(canvas, shot.mimeType, opts.quality), width, height, scaledFrom: from };
}

export async function screenshot(
  tabId: number,
  opts?: {
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    ref?: string;
    keepEnabled?: boolean;
    /**
     * Skip the cheap capture even when it would be safe, and render through the
     * debugger instead. Exists for one measured reason: `captureVisibleTab` is
     * quota'd by Chrome at **2 calls per second** and rejects the third with
     * "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota"
     * (hit on 2026-09-05 taking a 4-frame strip at 150ms). `Page.captureScreenshot`
     * has no such quota, so a frame strip uses it — the same path a background tab
     * already uses, not a new one.
     */
    forceCdp?: boolean;
  },
): Promise<{
  data: string;
  mimeType: string;
  cropped?: boolean;
  /** True when the exact-tab (debugger) path was used because the cheap one could not be trusted. */
  viaDebugger?: boolean;
  /** Why the cheap path was skipped, so the agent can tell the user. */
  reason?: string;
}> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId == null) throw new Error("Tab has no window");
  // Neither capture path can photograph a browser settings page, and the
  // debugger's "Cannot access a chrome:// URL" used to read as a closed tab
  // (plan 14, F3). Decided on the URL, never on the error text. Same list as
  // the server's `assertSafeUrl` — the two bundles share no code.
  if (/^(chrome|edge|brave|opera|vivaldi|chrome-extension|chrome-untrusted|devtools):/.test(tab.url ?? "")) {
    throw new Error(
      `RESTRICTED_PAGE: ${tab.url}: a browser settings page cannot be read by the agent; a person must look at it.`,
    );
  }

  // Can `captureVisibleTab` be trusted for THIS tab right now?
  //
  // Two ways it silently lies, both measured rather than assumed:
  //  1. It photographs the foreground tab OF A WINDOW. On a background tab it
  //     returns the focused tab's pixels — the wrong page, and a privacy leak.
  //  2. On a window the OS is not drawing (behind another app, or minimised) it
  //     either fails with a bare "image readback failed" or — far worse — hands
  //     back a STALE frame with no error at all. A real-browser check on
  //     2026-08-27 hit the silent-stale case and returned a crop of the wrong part
  //     of the page, which reads as a cropping bug and is not one.
  //
  // Neither is recoverable by trying harder, so we do not use this path at all in
  // those cases: we render the exact tab through CDP instead (below). Wrong pixels
  // with no warning is the one outcome a screenshot tool must never produce.
  const win = await chrome.windows.get(tab.windowId);
  const unsafe = opts?.forceCdp
    ? "a frame strip captures faster than the cheap path's 2-per-second quota allows"
    : tab.active === false
      ? "it is not the foreground tab of its window"
      : win.state === "minimized"
        ? "its window is minimised"
        : win.focused === false
          ? "its window is not focused"
          : undefined;

  const want = opts?.format === "jpeg" ? "jpeg" : opts?.format === "webp" ? "webp" : "png";
  // Chrome can CAPTURE only png/jpeg. webp is a re-encode of a png capture, so
  // ask for lossless bytes when we are going to re-encode anyway.
  const capture = want === "webp" ? "png" : want;
  const captureOpts: chrome.extensionTypes.ImageDetails = { format: capture };
  if (capture === "jpeg" && typeof opts?.quality === "number") {
    captureOpts.quality = Math.max(0, Math.min(100, Math.round(opts.quality)));
  }
  const mimeType =
    want === "jpeg" ? "image/jpeg" : want === "webp" ? "image/webp" : "image/png";

  // Measure BEFORE capturing: the rect call is also what scrolls the element
  // into view, and a capture taken first would be of the page as it was.
  let crop: { x: number; y: number; w: number; h: number } | undefined;
  let cssViewportWidth: number | undefined;
  if (opts?.ref) {
    // A `fN:` ref is MEASURED INSIDE ITS FRAME (B08). Before this the prefixed ref
    // was searched for as a literal attribute in the top document and came back
    // `REF_NOT_FOUND`, sending the agent for a fresh snapshot that would hand back
    // the very same ref.
    //
    // The rect comes back already translated into the tab's viewport, because the
    // injected measurement walks up its `frameElement` chain. That chain breaks at
    // a cross-origin boundary and nothing can mend it from here, so the frame
    // itself reports `CROSS_ORIGIN_FRAME` and this refuses with that reason —
    // cropping an unadjusted rect would hand back a confidently wrong region.
    const { frameId, bare } = parseRef(opts.ref);
    const r = await runFunc(tabId, elementRectPage, [bare], "ISOLATED", frameId);
    if (!r.ok) {
      const message = (r.error ?? "").replaceAll(bare, opts.ref);
      throw new Error(
        r.code === "CROSS_ORIGIN_FRAME" ? `BAD_ARGS: ${message}` : r.code ? `${r.code}: ${message}` : message,
      );
    }
    crop = r.rect;
    cssViewportWidth = r.viewportWidth;
    // One frame for the scroll to land before the pixels are read.
    await wait(120);
  }

  // The exact-tab path: render this tab through the debugger rather than
  // photographing whatever is on screen. Costs Chrome's "being debugged" banner
  // for the duration (detached again straight after), and buys a correct picture
  // of a background tab without touching the user's focus.
  let dataUrl: string;
  let viaCdp = false;
  if (unsafe) {
    let shot;
    try {
      shot = await cdpScreenshot(tabId, {
        format: capture,
        quality: opts?.quality,
        keepEnabled: opts?.keepEnabled,
      });
    } catch (e) {
      // Attach can genuinely fail — a restricted page (chrome://, edge://, the
      // store, the PDF viewer) or a policy that forbids the debugger. Say which
      // door is shut and which one is still open, rather than surfacing a raw
      // CDP error. Falling back to captureVisibleTab here is NOT an option: that
      // is the path that returns the wrong tab's pixels, which is what `unsafe`
      // means.
      //
      // "DevTools already open on this tab" was listed here as a cause, and
      // "Close DevTools on that tab" led the remedies, until 2026-09-02. Both
      // were removed after measuring the opposite in Edge 152: a screenshot of a
      // background tab with the DevTools panel OPEN attached and captured
      // correctly. Chromium allows several CDP clients per target. Leading with
      // a remedy that cannot help pushed the real cause into parentheses.
      throw new Error(
        `Cannot screenshot tab ${tabId}: ${unsafe}, so the picture has to be rendered ` +
          `through the debugger — and attaching failed (${e instanceof Error ? e.message : String(e)}). ` +
          `Bring the tab to the front with browser_switch_tab and try again.`,
      );
    }
    dataUrl = `data:${shot.mimeType};base64,${shot.data}`;
    viaCdp = true;
  } else {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOpts);
  }

  if (!crop && want !== "webp") {
    return {
      data: dataUrl.replace(/^data:[^;]+;base64,/, ""),
      mimeType,
      ...(viaCdp ? { viaDebugger: true, reason: unsafe } : {}),
    };
  }
  return {
    data: await reencode(dataUrl, mimeType, opts?.quality, crop, cssViewportWidth),
    mimeType,
    ...(crop ? { cropped: true } : {}),
    ...(viaCdp ? { viaDebugger: true, reason: unsafe } : {}),
  };
}
