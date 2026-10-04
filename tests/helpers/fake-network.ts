/**
 * The real request log (`network.ts`), fed by a scripted `chrome.webRequest`.
 */
import { chromeMock, loadExtensionModule } from "./extension-harness";

type Listener = (d: Record<string, unknown>) => void;

export interface NetworkModule {
  installNetworkCapture(): void;
  lastMainFrame(
    tabId: number,
    sinceTs: number,
  ): Promise<{ url: string; error?: string; start: number } | undefined>;
  inFlight(tabId: number, sinceTs: number): Promise<number>;
}

/** The real request log, fed by a scripted `chrome.webRequest`. */
export function loadNetwork() {
  const base = chromeMock();
  const on = { before: [] as Listener[], completed: [] as Listener[], error: [] as Listener[] };
  const channel = (list: Listener[]) => ({ addListener: (fn: Listener) => list.push(fn) });
  const mod = loadExtensionModule<NetworkModule>("Chrome-extension/lib/automation/network.ts", {
    globals: {
      chrome: {
        ...base.chrome,
        webRequest: {
          onBeforeRequest: channel(on.before),
          onCompleted: channel(on.completed),
          onErrorOccurred: channel(on.error),
        },
      },
    },
  });
  mod.exports.installNetworkCapture();
  let n = 0;
  /** One request, start to finish, the way webRequest reports it. */
  const request = (
    tabId: number,
    type: string,
    url: string,
    start: number,
    end: { error?: string; status?: number },
  ) => {
    const requestId = String(++n);
    for (const fn of on.before)
      fn({ requestId, tabId, url, method: "GET", type, timeStamp: start });
    if (end.error) {
      for (const fn of on.error) fn({ requestId, error: end.error, timeStamp: start + 1 });
    } else {
      for (const fn of on.completed) {
        fn({ requestId, statusCode: end.status ?? 200, timeStamp: start + 1 });
      }
    }
  };
  return { net: mod.exports, request, on, dispose: mod.dispose };
}
