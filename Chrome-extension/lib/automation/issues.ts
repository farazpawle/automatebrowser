/**
 * Issues feed (C4) — DEBUGGER-FREE.
 *
 * A whole class of failure produces no console error at all: CSP violations,
 * deprecations, interventions, blocked or failed subresource requests. The agent
 * sees "the button did nothing" and has no path to "your CSP blocked the inline
 * handler". Chrome knows; until now nothing asked it.
 *
 * Two sources, merged into one time-ordered list:
 *   - PAGE   — `window.__bmcpIssues`, filled by the MAIN-world content script
 *              (ReportingObserver + securitypolicyviolation).
 *   - NETWORK — DERIVED from the request log `network.ts` already captures. No
 *              new listeners and no new buffer: `onErrorOccurred` already records
 *              `error`, and `onCompleted` already records `status`, so a failed or
 *              4xx/5xx request is a filter over data that is already there.
 *
 * "The current page" is bounded without any extra state either: the tab's most
 * recent `main_frame` request IS the navigation boundary, so anything logged
 * before it belongs to the previous page and is dropped.
 *
 * The fully-aggregated DevTools taxonomy needs `Audits.enable` over CDP — a
 * `browser_advanced_mode` enrichment later, not this.
 */
import { getNetworkRequests } from "./network";
import { runFunc } from "./run-func";

export interface Issue {
  source: "page" | "network";
  kind: string;
  ts: number;
  text: string;
  url?: string;
}

/** Read the MAIN-world issue buffer the content script fills. */
function pageIssuesFn(): { issues: Issue[]; dropped: number } {
  const w = window as any;
  return {
    issues: ((w.__bmcpIssues as Issue[]) || []).slice(),
    dropped: w.__bmcpIssuesMeta?.dropped ?? 0,
  };
}

export async function getIssues(
  tabId: number,
  args: { limit?: number } = {},
): Promise<{ issues: Issue[]; dropped: number; capturedNetwork: boolean }> {
  let page: { issues: Issue[]; dropped: number } = { issues: [], dropped: 0 };
  try {
    page = await runFunc(tabId, pageIssuesFn, [], "MAIN");
  } catch {
    // A tab with no content script (chrome:// page, freshly created, or one that
    // navigated mid-call) still has network issues worth reporting — report those
    // rather than failing the whole call.
  }

  // What this tab requested on the CURRENT document. `getNetworkRequests` now owns
  // the navigation-boundary derivation (B1c) and scopes to one generation by
  // default, so the copy of that logic that used to live here is gone — one
  // definition of "this page", not two that can drift apart.
  const { requests, captured } = await getNetworkRequests(tabId, { limit: 1000 });
  const network: Issue[] = requests
    .filter((r) => r.error || (r.status != null && r.status >= 400))
    .map((r) => ({
      source: "network" as const,
      kind: r.error ? "request-failed" : `http-${r.status}`,
      ts: Math.round(r.end ?? r.start),
      text: r.error
        ? `${r.method} ${r.url} failed: ${r.error}`
        : `${r.method} ${r.url} returned ${r.status}${r.statusLine ? ` (${r.statusLine})` : ""}`,
      url: r.url,
    }))
    // A page that requests the same broken asset in a loop would otherwise bury
    // every other issue; one entry per (kind, url) is enough to act on.
    .filter(
      (issue, i, all) =>
        all.findIndex((o) => o.kind === issue.kind && o.url === issue.url) === i,
    );

  const all = [...page.issues, ...network].sort((a, b) => a.ts - b.ts);
  const limit = args.limit && args.limit > 0 ? args.limit : 100;
  return {
    issues: all.slice(-limit),
    dropped: page.dropped,
    capturedNetwork: captured,
  };
}
