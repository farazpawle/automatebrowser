/**
 * ISOLATED-world bridge — the only reason it exists is that `content.ts` cannot
 * do this itself.
 *
 * `content.ts` runs in the page's MAIN world so it observes the page's REAL
 * console; that world has no `chrome.*` API, so when the document is about to be
 * destroyed someone else has to move the buffer out. This script is that
 * someone: it PULLS the buffer on `pagehide` and forwards it to the service
 * worker, which keeps the last few navigations so
 * `browser_get_console_logs { includePreserved: true }` can still show the page
 * an agent just got redirected away from.
 *
 * WHY IT PULLS RATHER THAN LISTENS (fixed 2026-08-27, found by a real-browser
 * check): the MAIN world used to `postMessage` its buffer on `pagehide` and this
 * script listened for it. That message never arrived — `postMessage` queues a
 * task, and the document is destroyed before the task can dispatch. The bug was
 * invisible in testing because the same post sent while the page was still alive
 * arrived perfectly.
 *
 * `dispatchEvent` on a shared DOM node is SYNCHRONOUS and runs listeners in both
 * worlds inline, so when the dispatch below returns, the attribute is already
 * populated. The DOM is shared between worlds even though the JS heaps are not,
 * which is what makes this work at all.
 *
 * Still best-effort by construction: a crashed renderer, a killed tab, or a
 * `chrome://` navigation never runs `pagehide`, so there is simply no handover.
 * The reader says "no preserved log" rather than pretending otherwise.
 */
const ATTR = "data-bmcp-handover";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "ISOLATED",
  main() {
    const handover = () => {
      let payload: { entries?: unknown[]; dropped?: number } | undefined;
      try {
        const root = document.documentElement;
        // Synchronous round trip: the MAIN-world listener fills the attribute
        // before this call returns.
        root.dispatchEvent(new CustomEvent("bmcp:collect"));
        const raw = root.getAttribute(ATTR);
        root.removeAttribute(ATTR);
        if (!raw) return;
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) return;
      try {
        void chrome.runtime.sendMessage({
          type: "bmcp:preserveLogs",
          // Read HERE, not from the page. This world shares the document, so the
          // honest value is one property away. A page can already write anything
          // to its own console; it must not be able to forge WHICH PAGE an agent
          // thinks that output came from.
          url: location.href,
          title: document.title,
          entries: payload.entries,
          dropped: Number(payload.dropped) || 0,
        });
      } catch {
        // The worker may be gone or the extension reloading. A lost handover
        // costs the previous page's log — never the page, and never the tab.
      }
    };

    // `pagehide` ONLY. `visibilitychange` looks like a useful safety net and is
    // not: it fires every time the user switches tab, so it would preserve the
    // CURRENT page over and over and push the genuinely previous pages out of the
    // three-deep per-tab history — losing exactly what this exists to keep.
    window.addEventListener("pagehide", handover);
  },
});
