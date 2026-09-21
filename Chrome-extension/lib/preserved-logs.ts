/**
 * Console logs of pages the tab has already navigated away from (B1c).
 *
 * The console buffer lives in the page, so a navigation destroys it — which is
 * exactly the navigation an agent debugging a login redirect needs the log from.
 * `content.ts` posts its buffer on `pagehide`, `bridge.ts` forwards it here, and
 * `browser_get_console_logs { includePreserved: true }` reads it back.
 *
 * Kept in `chrome.storage.session`, not in a worker-module Map, for the same
 * reason the network log is: an MV3 worker eviction would otherwise throw this
 * away too. Handovers happen once per navigation — not hundreds per second like
 * webRequest events — so each write is immediate and needs no throttle.
 */

const KEY = "bmcp:prelogs";
/** Documents kept per tab. The redirect chain an agent needs is 1-2 deep. */
const PER_TAB = 3;
/** Tabs kept at all, least-recently-written evicted first, so this cannot grow. */
const MAX_TABS = 10;

export interface PreservedPage {
  url: string;
  title: string;
  /** When the page was handed over (i.e. when it was navigated away from). */
  ts: number;
  entries: unknown[];
  dropped: number;
}

type Store = Record<string, PreservedPage[]>;

async function read(): Promise<Store> {
  try {
    const got = await chrome.storage.session.get(KEY);
    const s = got?.[KEY];
    return s && typeof s === "object" ? (s as Store) : {};
  } catch {
    return {};
  }
}

/** Record one page's console buffer against the tab it was showing in. */
export async function preserve(tabId: number, page: PreservedPage): Promise<void> {
  try {
    const store = await read();
    const key = String(tabId);
    store[key] = [...(store[key] ?? []), page].slice(-PER_TAB);

    // Evict whole tabs by how recently they were written, so a long session with
    // many closed tabs cannot grow this without bound. (chrome.tabs.onRemoved
    // would be exact, but it does not fire for a tab closed while the worker was
    // evicted — which is precisely when this store matters.)
    const keys = Object.keys(store);
    if (keys.length > MAX_TABS) {
      const newestTs = (k: string) => store[k]?.[store[k]!.length - 1]?.ts ?? 0;
      for (const k of keys.sort((a, b) => newestTs(b) - newestTs(a)).slice(MAX_TABS)) {
        delete store[k];
      }
    }
    await chrome.storage.session.set({ [KEY]: store });
  } catch {
    // Losing a handover costs the previous page's log. It must never cost the
    // navigation, the page, or the tool call that triggered it.
  }
}

/** Pages this tab navigated away from, oldest first. Empty when none were kept. */
export async function getPreserved(tabId: number): Promise<PreservedPage[]> {
  const store = await read();
  return store[String(tabId)] ?? [];
}
