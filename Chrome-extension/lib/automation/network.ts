/**
 * Network request LOG — DEBUGGER-FREE via `chrome.webRequest` (observe-only).
 *
 * Captures request metadata (method, url, type, status, timing) into a ring
 * buffer. Listeners are registered once at service-worker startup
 * (`installNetworkCapture`, called from background.ts) so they catch traffic.
 *
 * DURABILITY (B1): the buffer is mirrored into `chrome.storage.session` and
 * rehydrated when the worker starts, so an MV3 eviction no longer silently
 * empties the log. Before this, a tool call after ~30s of idle returned
 * "(no requests captured…)" and `browser_issues` — which is DERIVED from this
 * buffer — reported nothing wrong, which an agent reads as "the page is fine".
 *
 * LIMITS (inherent to debugger-free): NO request/response BODIES (that needs CDP
 * — the opt-in `browser_advanced_mode`). `chrome.storage.session` is cleared when
 * the BROWSER restarts, so the log spans worker evictions, not browser restarts.
 */

export interface NetEntry {
  id: string;
  tabId: number;
  url: string;
  method: string;
  type: string;
  status?: number;
  statusLine?: string;
  fromCache?: boolean;
  error?: string;
  start: number;
  end?: number;
}

const MAX = 1000;
const SESSION_KEY = "bmcp:netlog";
/**
 * Trailing-edge throttle for the mirror write. A page load fires hundreds of
 * webRequest events; a write per event would be the slowest thing in the worker.
 * The window is safe against the very eviction this guards: Chrome only evicts an
 * IDLE worker, and a worker with requests in flight is not idle — so the trailing
 * write always lands before the idle timer that kills it can start.
 */
const PERSIST_MS = 500;
/**
 * Byte ceiling for the mirror. One `data:` URL can be megabytes on its own, so a
 * cap by entry count alone would not bound this. Oldest entries are dropped until
 * it fits, which matches what the in-memory ring buffer does anyway.
 */
const MAX_PERSIST_CHARS = 2_000_000;

const buf: NetEntry[] = [];
const byId = new Map<string, NetEntry>();
let installed = false;
/** Resolves once the mirror has been read back; reads await it (see `ready`). */
let hydration: Promise<void> | undefined;

function push(e: NetEntry): void {
  buf.push(e);
  byId.set(e.id, e);
  if (buf.length > MAX) {
    const old = buf.shift();
    if (old) byId.delete(old.id);
  }
}

/** Newest-first slice of the buffer that fits the byte ceiling. */
function persistable(): NetEntry[] {
  let slice = buf;
  while (slice.length > 1 && JSON.stringify(slice).length > MAX_PERSIST_CHARS) {
    slice = slice.slice(Math.ceil(slice.length / 2)); // drop the older half
  }
  return slice;
}

async function persistNow(): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: persistable() });
  } catch {
    // Quota, a missing `storage` permission, or a worker torn down mid-write.
    // Degrade to in-memory-only — the behaviour before this existed — never break
    // capture over a mirror that is a nice-to-have.
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon(): void {
  if (persistTimer !== undefined) return; // a trailing write is already scheduled
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistNow();
  }, PERSIST_MS);
}

/** Read the mirror back into the ring buffer. Runs once, at worker start. */
async function rehydrate(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(SESSION_KEY);
    const saved = got?.[SESSION_KEY] as NetEntry[] | undefined;
    if (!Array.isArray(saved) || saved.length === 0) return;
    // Saved entries are older than anything captured since this worker woke, so
    // they go first. Keyed by id so a live entry (which may have been UPDATED by
    // onCompleted) always wins over its stale saved copy. No `await` between the
    // merge and the rebuild, so a listener cannot interleave and lose a push.
    const merged = new Map<string, NetEntry>();
    for (const e of saved) if (e?.id) merged.set(e.id, e);
    for (const e of buf) merged.set(e.id, e);
    const all = [...merged.values()].sort((a, b) => a.start - b.start).slice(-MAX);
    buf.length = 0;
    byId.clear();
    for (const e of all) {
      buf.push(e);
      byId.set(e.id, e);
    }
  } catch {
    /* storage unavailable → in-memory only */
  }
}

/** Register the webRequest listeners exactly once. Safe to call repeatedly. */
export function installNetworkCapture(): void {
  if (installed) return;
  installed = true;
  if (!chrome.webRequest) return; // permission not granted → no-op
  hydration = rehydrate();
  const filter: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

  chrome.webRequest.onBeforeRequest.addListener((d) => {
    push({
      id: d.requestId,
      tabId: d.tabId,
      url: d.url,
      method: d.method,
      type: d.type,
      start: d.timeStamp,
    });
    persistSoon();
    return undefined;
  }, filter);

  chrome.webRequest.onCompleted.addListener((d) => {
    const e = byId.get(d.requestId);
    if (e) {
      e.status = d.statusCode;
      e.statusLine = d.statusLine;
      e.fromCache = d.fromCache;
      e.end = d.timeStamp;
      persistSoon();
    }
  }, filter);

  chrome.webRequest.onErrorOccurred.addListener((d) => {
    const e = byId.get(d.requestId);
    if (e) {
      e.error = d.error;
      e.end = d.timeStamp;
      persistSoon();
    }
  }, filter);
}

/**
 * Block until the mirror has been read back. A read that lands before rehydration
 * would otherwise return an empty log and then silently "heal" on the next call —
 * the agent would have already acted on the empty one.
 */
async function ready(): Promise<void> {
  if (hydration) await hydration;
}

/** How many past documents `includePreserved` reaches back over. */
const PRESERVED_GENERATIONS = 3;

/**
 * Narrow a tab's requests to its last `generations` documents.
 *
 * A "generation" needs no counter and no new listener: a tab's `main_frame`
 * request IS its navigation boundary, and those are already in this buffer. This
 * is the same derivation `issues.ts` uses to decide what belongs to the current
 * page — one definition of "this page", not two that can disagree.
 *
 * Requests are stamped in arrival order, so a boundary is a `start` timestamp and
 * everything at or after it belongs to that generation or a later one.
 */
function lastGenerations(entries: NetEntry[], generations: number): NetEntry[] {
  const boundaries = entries.filter((e) => e.type === "main_frame");
  if (boundaries.length <= generations) return entries; // whole log is inside the window
  const from = boundaries[boundaries.length - generations]!.start;
  return entries.filter((e) => e.start >= from);
}

/**
 * The newest top-level (`main_frame`) request a tab made at or after `sinceTs`.
 *
 * F1: Chrome's error page commits like any other document, so the tab events
 * alone cannot tell "loaded" from "failed to load". The top-level request can —
 * its `error` is set by `onErrorOccurred` and nothing else. The error's TEXT is
 * passed through for the reader and never inspected: Chrome documents it as
 * unstable across releases.
 */
export async function lastMainFrame(tabId: number, sinceTs: number): Promise<NetEntry | undefined> {
  if (!chrome.webRequest) return undefined;
  await ready();
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i]!;
    if (e.tabId === tabId && e.type === "main_frame" && e.start >= sinceTs) return e;
  }
  return undefined;
}

/**
 * Whether the tab sent any request at or after `sinceTs`, or any tab began a
 * top-level load (a link that opened a new tab).
 *
 * F5: a click that only sends a request, or opens a tab, changes nothing in its
 * own page and still worked — it must not be reported as ignored.
 */
export async function requestSince(tabId: number, sinceTs: number): Promise<boolean> {
  if (!chrome.webRequest) return false;
  await ready();
  return buf.some((e) => e.start >= sinceTs && (e.tabId === tabId || e.type === "main_frame"));
}

/**
 * How many requests the tab started at or after `sinceTs` are still open (F14,
 * `waitUntil: "networkidle"`). A redirect re-announces its request id, leaving
 * the first entry without an end forever, so only the entry `byId` points at
 * counts.
 */
export async function inFlight(tabId: number, sinceTs: number): Promise<number> {
  if (!chrome.webRequest) return 0;
  await ready();
  return buf.filter(
    (e) => e.tabId === tabId && e.start >= sinceTs && e.end === undefined && byId.get(e.id) === e,
  ).length;
}

export async function getNetworkRequests(
  tabId: number,
  args: { limit?: number; resourceTypes?: string[]; includePreserved?: boolean },
): Promise<{ requests: NetEntry[]; captured: boolean; generations: number }> {
  if (!chrome.webRequest) return { requests: [], captured: false, generations: 0 };
  await ready();
  const generations = args.includePreserved ? PRESERVED_GENERATIONS : 1;
  // Scope BEFORE filtering by type: `resourceTypes: ["fetch"]` would otherwise
  // strip out the very `main_frame` rows the boundaries are derived from, and the
  // window would silently widen to the whole log.
  const scoped = lastGenerations(buf.filter((e) => e.tabId === tabId), generations);
  const types = args.resourceTypes && args.resourceTypes.length ? new Set(args.resourceTypes) : null;
  const filtered = types ? scoped.filter((e) => types.has(e.type)) : scoped;
  const limit = args.limit && args.limit > 0 ? args.limit : 100;
  return { requests: filtered.slice(-limit), captured: true, generations };
}
