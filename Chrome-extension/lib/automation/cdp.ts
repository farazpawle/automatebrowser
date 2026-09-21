/**
 * Opt-in CDP layer (chrome.debugger) — Milestone 3.
 *
 * Default OFF: the engine is debugger-free until the agent calls
 * `browser_advanced_mode { enable:true }`, which attaches chrome.debugger to a
 * tab. The "started debugging this browser" banner shows ONLY while a tab is
 * attached, and only for that tab. `debugger` is a declared (required) manifest
 * permission, so attach needs no user gesture.
 *
 * This module owns: attach/detach + lifecycle cleanup, a thin `sendCommand`
 * wrapper, a CDP Network buffer (so `browser_get_network_request` can fetch
 * response BODIES), and a Tracing buffer (perf traces).
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs we currently hold a debugger session on. */
const attached = new Set<number>();

interface CdpNetEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  type?: string;
  ts: number;
  /**
   * Headers as CDP handed them over. There is no "fetch the headers for this
   * requestId later" command — `Network.getResponseBody` has no counterpart —
   * so they are kept at event time or not at all.
   *
   * ponytail: retains up to NET_MAX header maps per tab (~1 MB worst case on a
   * chatty SPA). Drop to response headers only if a worker ever runs short.
   */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}
const NET_MAX = 500;
const netByTab = new Map<number, CdpNetEntry[]>();

interface TraceState {
  events: unknown[];
  active: boolean;
  resolvers: Array<() => void>;
  /** For the double-start refusal, so it can say how long the running one has been going. */
  startedAt: number;
}
const traceByTab = new Map<number, TraceState>();

/**
 * A JS dialog currently blocking a tab's renderer, seen via
 * `Page.javascriptDialogOpening`. This is the ONLY way to know a modal is open:
 * while one is up the renderer is paused, so anything injected with
 * `chrome.scripting` — including the MAIN-world dialog log — hangs instead of
 * answering. The debugger session is out-of-process and keeps working, which is
 * why this is CDP-only and cannot be back-ported to the debugger-free path.
 */
interface OpenDialog {
  type: string;
  message: string;
  /** beforeunload dialogs report this; it decides whether `Page.handleJavaScriptDialog` needs text. */
  hasBrowserHandler?: boolean;
  ts: number;
}
const dialogByTab = new Map<number, OpenDialog>();
/** Per-tab auto-answer, armed around a navigation (`accept` proceeds, `dismiss` stays). */
const dialogPolicyByTab = new Map<number, { action: "accept" | "dismiss"; promptText?: string }>();

let listenersInstalled = false;

export async function hasDebuggerPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["debugger"] });
  } catch {
    // `debugger` is a required permission, so contains() should resolve true;
    // treat any failure as "present" rather than blocking attach.
    return true;
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export function attachedTabs(): number[] {
  return [...attached];
}

/** Register debugger/tab lifecycle + CDP event listeners exactly once. */
export function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  if (!chrome.debugger) return;

  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId != null) cleanupTab(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => cleanupTab(tabId));

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (tabId == null) return;
    if (method === "Network.requestWillBeSent") {
      const buf = netByTab.get(tabId) ?? [];
      netByTab.set(tabId, buf);
      buf.push({
        requestId: params.requestId,
        url: params.request?.url ?? "",
        method: params.request?.method ?? "",
        type: params.type,
        ts: params.timestamp ?? 0,
        requestHeaders: params.request?.headers,
      });
      if (buf.length > NET_MAX) buf.shift();
    } else if (method === "Network.responseReceived") {
      const e = netByTab.get(tabId)?.find((x) => x.requestId === params.requestId);
      if (e) {
        e.status = params.response?.status;
        e.mimeType = params.response?.mimeType;
        e.type = params.type ?? e.type;
        e.responseHeaders = params.response?.headers;
        // The final headers after redirects/auth, when CDP knows them.
        if (params.response?.requestHeaders) e.requestHeaders = params.response.requestHeaders;
      }
    } else if (method === "Page.javascriptDialogOpening") {
      dialogByTab.set(tabId, {
        type: params.type,
        message: params.message ?? "",
        hasBrowserHandler: params.hasBrowserHandler,
        ts: Date.now(),
      });
      const policy = dialogPolicyByTab.get(tabId);
      if (policy) {
        // Answer immediately. A beforeunload prompt is native browser chrome —
        // page JS cannot see it, let alone respond — so this is the only route.
        void sendCommand(tabId, "Page.handleJavaScriptDialog", {
          accept: policy.action === "accept",
          ...(policy.promptText != null ? { promptText: policy.promptText } : {}),
        }).catch(() => undefined);
      }
    } else if (method === "Page.javascriptDialogClosed") {
      dialogByTab.delete(tabId);
    } else if (method === "Tracing.dataCollected") {
      const st = traceByTab.get(tabId);
      if (st && Array.isArray(params.value)) st.events.push(...params.value);
    } else if (method === "Tracing.tracingComplete") {
      const st = traceByTab.get(tabId);
      if (st) {
        st.active = false;
        st.resolvers.splice(0).forEach((r) => r());
      }
    }
  });
}

function cleanupTab(tabId: number): void {
  attached.delete(tabId);
  netByTab.delete(tabId);
  dialogByTab.delete(tabId);
  dialogPolicyByTab.delete(tabId);
  const st = traceByTab.get(tabId);
  if (st) st.resolvers.splice(0).forEach((r) => r());
  traceByTab.delete(tabId);
}

/** Prefix of the rejection a `timeoutMs` produces, so callers can recognise it. */
export const CDP_NO_RESPONSE = "did not respond within";

/**
 * Send one CDP command, optionally under a ceiling.
 *
 * **`chrome.debugger.sendCommand`'s callback is not guaranteed to fire**, and
 * without `timeoutMs` this promise then never settles. That is not theoretical:
 * Chrome backgrounds a hidden tab's renderer and stops producing compositor
 * frames, so `Page.captureScreenshot` (which defaults to `fromSurface: true`)
 * waits for a frame that never arrives. Measured on 2026-09-01: **3 stalls in 8
 * captures** of a background tab.
 *
 * What the caller saw was worse than the stall itself. With nothing settling
 * here, the extension just held the request open until the CONTROLLER's socket
 * budget expired (`relay-link.ts`: the tool's own timeout plus 2s slack), and
 * the agent got a bare `Socket message timeout` — a message that names nothing,
 * points nowhere, and has now hidden four different root causes in this
 * codebase's history.
 *
 * **Opt-in, not a default.** Fifteen call sites reach this function, and some
 * are legitimately slower than any ceiling worth setting — stopping a perf
 * trace collects a whole Chrome trace. Passing a ceiling is the caller's
 * decision because only the caller knows its own budget.
 */
export function sendCommand<T = any>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer =
      timeoutMs == null
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${method} ${CDP_NO_RESPONSE} ${timeoutMs}ms.`));
          }, timeoutMs);
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
      // A late callback after the ceiling fired is expected, not an error: the
      // command may still complete long after we stopped waiting for it.
      if (settled) {
        void chrome.runtime.lastError;
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(`${method} failed: ${err.message}`));
      resolve(res as T);
    });
  });
}

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  installListeners();
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Chrome's own message names the real cause every time we have been able
        // to provoke one ("Cannot access chrome:// and edge:// URLs", policy,
        // tab gone). It used to be followed by "Close DevTools on this tab if it
        // is open." — DELETED 2026-09-02, because it is no longer true and it
        // actively misleads: on Chromium 152 a tab with DevTools OPEN attaches
        // fine (measured in Edge 152 — the user confirmed the panel was open
        // while `chrome.debugger.attach` succeeded twice and the screenshot came
        // back correct). Chromium supports several CDP clients per target now.
        // The cost of guessing was real: on a restricted page the FIRST remedy
        // offered was one that cannot help, with the true cause in parentheses.
        return reject(new Error(`Could not attach debugger: ${err.message}`));
      }
      resolve();
    });
  });
  attached.add(tabId);
  // Enable Network so response bodies are retrievable later, and Page so dialog
  // and init-script commands work. Both best-effort: a domain that fails to
  // enable must not fail the attach the agent actually asked for.
  try {
    await sendCommand(tabId, "Network.enable", {});
  } catch {
    /* ignore */
  }
  try {
    await sendCommand(tabId, "Page.enable", {});
  } catch {
    /* ignore */
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  cleanupTab(tabId);
}

export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((id) => detach(id)));
}

/** Throw a self-healing error if advanced mode isn't on for this tab. */
export function requireAttached(tabId: number): void {
  if (!attached.has(tabId)) {
    throw new Error(
      "ADVANCED_MODE_REQUIRED: Advanced (debugger) mode is not enabled for this tab. Call browser_advanced_mode { enable: true } first.",
    );
  }
}

export function getCdpNetwork(tabId: number): CdpNetEntry[] {
  return netByTab.get(tabId) ?? [];
}

// Invalid certificates (D21) lived here and were DELETED on 2026-09-16.
// `Security.setIgnoreCertificateErrors` answers -32601 'wasn't found' to an
// extension on every build measured (headless Chrome, headed Chrome, Edge):
// `chrome.debugger` exposes a FIXED allow-list of CDP domains and `Security`
// is not on it, the same allow-list that killed D7's heap snapshot. There is
// no route around it from here — only --ignore-certificate-errors at launch,
// or clicking through the warning once. Nothing now probes this, so if a
// future Chrome adds `Security` to the allow-list, no check will announce it.

// ── init scripts (C9) ──────────────────────────────────────────────────────

/**
 * Run `source` before ANY page script on the tab's next document.
 *
 * There is no debugger-free equivalent: `chrome.scripting.registerContentScripts`
 * takes bundled FILE PATHS, never code supplied at call time, and a
 * `document_start` content script is itself a build-time file with no way to be
 * handed the agent's source before it runs. `Page.addScriptToEvaluateOnNewDocument`
 * is the API this feature is made of, so it is opt-in behind advanced mode.
 */
export async function addInitScript(tabId: number, source: string): Promise<string> {
  requireAttached(tabId);
  const r = await sendCommand<{ identifier: string }>(
    tabId,
    "Page.addScriptToEvaluateOnNewDocument",
    { source },
  );
  return r.identifier;
}

/** Best-effort removal — a torn-down tab has nothing left to remove. */
export async function removeInitScript(tabId: number, identifier: string): Promise<void> {
  try {
    await sendCommand(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier });
  } catch {
    /* tab or session already gone */
  }
}

// ── dialogs (C11) ──────────────────────────────────────────────────────────

/** The modal currently blocking this tab's renderer, if the debugger can see one. */
export function openDialog(tabId: number): OpenDialog | undefined {
  return dialogByTab.get(tabId);
}

/** Arm/disarm the auto-answer. Returns the previous policy so a caller can restore it. */
export function setDialogPolicy(
  tabId: number,
  policy: { action: "accept" | "dismiss"; promptText?: string } | null,
): { action: "accept" | "dismiss"; promptText?: string } | null {
  const prev = dialogPolicyByTab.get(tabId) ?? null;
  if (policy) dialogPolicyByTab.set(tabId, policy);
  else dialogPolicyByTab.delete(tabId);
  return prev;
}

// ── tracing ────────────────────────────────────────────────────────────────

export async function traceStart(tabId: number, categories?: string[]): Promise<void> {
  requireAttached(tabId);
  // Refuse rather than silently replace: the old start would drop a running
  // trace's events on the floor, and the agent that started it would never learn
  // why its stop returned nothing. Guarded here because this is the only place
  // the state is set, so every caller — including a second agent on this tab —
  // hits it. One tab has exactly one CDP tracing session.
  const running = traceByTab.get(tabId);
  if (running?.active) {
    const secs = Math.round((Date.now() - running.startedAt) / 1000);
    throw new Error(
      `A performance trace is already running on this tab (started ${secs}s ago, ` +
        `${running.events.length} events so far). Call browser_perf_trace { action: "stop" } ` +
        `to finish it before starting another.`,
    );
  }
  traceByTab.set(tabId, { events: [], active: true, resolvers: [], startedAt: Date.now() });
  // Chrome's DEFAULT category set does NOT include `devtools.timeline`, which is
  // where every Core Web Vitals event lives. A real page-load recording on
  // 2026-08-27 came back with 15 661 events and ZERO of
  // largestContentfulPaint::Candidate / firstContentfulPaint / LayoutShift /
  // EventTiming — so the trace was a full, valid, useless recording and the
  // analyzer correctly reported "no vitals in this trace".
  //
  // `loading` and `blink.user_timing` carry navigationStart and the paint
  // timings; `toplevel` carries ThreadControllerImpl::RunTask, which is how long
  // tasks are found. An explicit `categories` argument still wins.
  const DEFAULT_CATEGORIES = [
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "blink.user_timing",
    "loading",
    "latencyInfo",
    "toplevel",
  ];
  const traceConfig: any = {
    includedCategories: categories?.length ? categories : DEFAULT_CATEGORIES,
  };
  await sendCommand(tabId, "Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig,
  });
}

export async function traceStop(tabId: number): Promise<unknown[]> {
  const st = traceByTab.get(tabId);
  if (!st || !st.active) {
    throw new Error("No active trace. Call browser_perf_trace { action: 'start' } first.");
  }
  const complete = new Promise<void>((resolve) => st.resolvers.push(resolve));
  await sendCommand(tabId, "Tracing.end");
  await complete;
  const events = st.events;
  traceByTab.delete(tabId);
  return events;
}

// ── heap snapshots are NOT possible here (D7, 2026-09-05) ──────────────────
//
// `HeapProfiler.takeHeapSnapshot` was built, and Chrome answered
// `{"code":-32601,"message":"'HeapProfiler.enable' wasn't found"}`. It is not a
// bug in the call: `chrome.debugger` exposes a FIXED allow-list of CDP domains,
// and HeapProfiler is not on it. `Profiler` (CPU) is; the heap one is not.
// There is no route around it — `Target.attachToTarget` inherits the same
// filter, and no chrome.* API dumps a heap.
//
// So the tool offers `action: "memory"` (the debugger-free trend) and nothing
// else. A heap snapshot has to be taken from DevTools → Memory by a person.
