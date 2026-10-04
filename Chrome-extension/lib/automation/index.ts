/**
 * Assembles the message-type → handler map the connection layer dispatches
 * against. Navigation, timing, tabs, eval and snapshot/interaction handlers are
 * all clean source; the in-page work goes through `chrome.scripting`
 * (no debugger attach — see driver.ts).
 *
 * Target tab, per call: the relay injects `__bmcpTabId` into the payload when a
 * controller drives a specific tab (so two IDEs can drive two tabs of one
 * browser at once). When absent, we fall back to the extension's own resolver
 * (explicit popup pin → active tab). Tab selection is therefore PER-CONTROLLER
 * state on the server, never a single shared global here — `browser_select_tab`
 * / `browser_switch_tab` / `browser_new_tab` no longer write `selectedTab`; they
 * just report the tab id and the controller remembers it.
 *
 * Every handler's payload is typed by `HandlerMap` from the generated contract —
 * none of them annotates `p` itself. That is deliberate: an annotation here is a
 * second declaration of the same shape, and a second declaration is free to
 * disagree with the server. Contextual typing means it cannot.
 */
import type { HandlerMap } from "../connection";
import type { RelayTabHint } from "../generated/browser-messages";
import * as a11y from "./a11y";
import * as advanced from "./advanced";
import * as cdp from "./cdp";
import * as content from "./content-ops";
import * as dialog from "./dialog";
import * as downloads from "./downloads";
import * as driver from "./driver";
import * as emulate from "./emulate";
import * as forms from "./forms";
import * as issues from "./issues";
import * as nav from "./navigation";
import * as netPolicy from "./net-policy";
import * as network from "./network";
import * as pageTools from "./page-tools";
import * as proxy from "./proxy";
import * as state from "./state";
import * as tabs from "./tabs";
import { waitForCondition } from "./wait-for";

export interface AutomationContext {
  /** Resolve the tab id to drive when the call names none (popup pin → active tab). */
  getTabId: () => Promise<number>;
}

export function createHandlerMap(ctx: AutomationContext): HandlerMap {
  /** The tab this call targets: the relay-supplied `__bmcpTabId`, else the fallback. */
  const tab = (p: RelayTabHint): Promise<number> =>
    typeof p?.__bmcpTabId === "number"
      ? Promise.resolve(p.__bmcpTabId)
      : ctx.getTabId();
  return {
    // ── navigation / timing ─────────────────────────────────────────────────
    browser_navigate: async (p) => nav.navigate(await tab(p), p.url, p ?? {}),
    browser_go_back: async (p) => nav.goBack(await tab(p), p ?? {}),
    browser_go_forward: async (p) => nav.goForward(await tab(p), p ?? {}),
    browser_wait: (p) => nav.waitSeconds(p.time),
    browser_wait_for: async (p) => waitForCondition(await tab(p), p),
    // Full-page capture needs CDP (Page.captureScreenshot); viewport capture is
    // debugger-free (captureVisibleTab).
    browser_screenshot: async (p) => {
      const t = await tab(p);
      let shot = await (p?.fullPage
        ? advanced.fullPageScreenshot(t, p ?? {})
        : nav.screenshot(t, p ?? {}));
      // The viewport path re-encodes its own webp; CDP's full-page capture cannot
      // produce one, so it comes back as the PNG it asked for and converts here.
      if (p?.fullPage && p.format === "webp") shot = await nav.asWebp(shot, p.quality);
      // D17's size ceiling, in one place for every capture path — viewport, full
      // page and element crop alike. It is a no-op unless the server sent a
      // ceiling, which it does only for an image coming back inline.
      return nav.capToCeiling(shot, p ?? {});
    },

    // ── tab management ──────────────────────────────────────────────────────
    // These no longer write a shared "selected tab" global — the server tracks
    // the target per-controller and rides it back via __bmcpTabId on each drive.
    browser_list_tabs: () => tabs.listTabs(),
    browser_new_tab: async (p) => tabs.newTab(p),
    browser_switch_tab: async (p) => tabs.switchTab(p),
    browser_close_tab: (p) => tabs.closeTab(p),
    // Take over a tab WITHOUT focusing/stealing it (drive it in the background):
    // resolve + validate it and report its id/url/title; the controller adopts it.
    browser_select_tab: async (p) => {
      const tabId = await tabs.resolveTabRef(p);
      const t = await chrome.tabs.get(tabId);
      return { tabId, url: t.url ?? "", title: t.title ?? "" };
    },

    // ── url / title helpers (server's 3-message snapshot fallback) ───────────
    getUrl: async (p) => (await chrome.tabs.get(await tab(p))).url ?? "",
    getTitle: async (p) => (await chrome.tabs.get(await tab(p))).title ?? "",

    // ── in-page engine (chrome.scripting; no debugger) ──────────────────────
    browser_snapshot: async (p) => driver.snapshot(await tab(p), p?.verbose === true),
    browser_snapshot_full: async (p) =>
      driver.snapshotFull(await tab(p), p?.verbose === true),
    browser_eval: async (p) => driver.evaluate(await tab(p), p ?? {}),
    // When advanced mode is on for the tab, click/hover/press_key use REAL trusted
    // CDP input; otherwise they fall back to the debugger-free synthetic dispatch.
    // Keyed on the mode, never on an attached debugger: a capture that attached
    // for its own sake must not change how input is sent (plan 14, F7).
    browser_click: async (p) => {
      const t = await tab(p);
      return cdp.wantsTrustedInput(t) ? advanced.nativeClick(t, p) : driver.click(t, p);
    },
    browser_hover: async (p) => {
      const t = await tab(p);
      return cdp.wantsTrustedInput(t) ? advanced.nativeHover(t, p) : driver.hover(t, p);
    },
    browser_drag: async (p) => driver.drag(await tab(p), p),
    browser_type: async (p) => driver.type(await tab(p), p),
    browser_select_option: async (p) => driver.selectOption(await tab(p), p),
    browser_press_key: async (p) => {
      const t = await tab(p);
      // `p` carries waitUntil/settleMs — the trusted path settles with the same
      // options as the synthetic one, or advanced mode silently changes timing.
      return cdp.wantsTrustedInput(t) ? advanced.nativeKey(t, p.key, p) : driver.pressKey(t, p);
    },
    browser_get_console_logs: async (p) => driver.getConsoleLogs(await tab(p), p ?? {}),
    // One tool, two oracles: what Chrome reported about this page, or what an
    // audit finds when it walks the rendered tree. Never both — they answer
    // different questions and merging them would bury one under the other.
    browser_issues: async (p) =>
      p?.audit === "a11y"
        ? a11y.auditA11y(await tab(p))
        : issues.getIssues(await tab(p), p ?? {}),

    // ── advanced (opt-in CDP / chrome.debugger) ──────────────────────────────
    browser_advanced_mode: async (p) => advanced.setAdvancedMode(await tab(p), p ?? {}),
    browser_upload_file: async (p) => advanced.uploadFile(await tab(p), p ?? {}),
    browser_get_network_request: async (p) =>
      advanced.getNetworkRequestBody(await tab(p), p ?? {}),
    browser_perf_trace: async (p) => advanced.perfTrace(await tab(p), p ?? {}),
    // Emulation (A4 debugger-free + A5 CDP) is ONE handler: the CDP half refuses
    // with ADVANCED_MODE_REQUIRED, the rest works without the banner.
    browser_emulate: async (p) => emulate.emulate(await tab(p), p ?? {}),

    // ── content reading / query / scroll (chrome.scripting) ──────────────────
    browser_read_page: async (p) => content.readPage(await tab(p), p ?? {}),
    browser_get_html: async (p) => content.getHtml(await tab(p), p ?? {}),
    browser_find: async (p) => content.find(await tab(p), p ?? {}),
    browser_scroll: async (p) => content.scroll(await tab(p), p ?? {}),

    // ── forms ────────────────────────────────────────────────────────────────
    browser_fill_form: async (p) => forms.fillForm(await tab(p), p ?? {}),
    browser_clear: async (p) => forms.clear(await tab(p), p ?? {}),

    // ── browser state (cookies / web storage) ────────────────────────────────
    browser_get_cookies: async (p) => state.getCookies(await tab(p), p ?? {}),
    browser_set_cookie: async (p) => state.setCookie(await tab(p), p ?? {}),
    browser_storage: async (p) => state.storage(await tab(p), p ?? {}),

    // ── tools the PAGE declares (WebMCP + the discovery event) ──────────────
    browser_page_tools: async (p) =>
      p?.action === "call"
        ? pageTools.callPageTool(await tab(p), p ?? {})
        : pageTools.listPageTools(await tab(p)),

    // ── network log (webRequest; metadata only, no bodies) ───────────────────
    browser_network_requests: async (p) =>
      network.getNetworkRequests(await tab(p), p ?? {}),

    // ── downloads (chrome.downloads; paths only, never file contents) ───────
    browser_downloads: (p) => downloads.listDownloads(p ?? {}),

    // ── proxy (C12) — chrome.proxy, PROFILE-WIDE, not per tab ────────────────
    browser_proxy: (p) => proxy.setProxy(p ?? {}),

    // ── origin deny-list at the network layer (B9) ────────────────────
    browser_net_policy: (p) => netPolicy.setNetPolicy(p ?? {}),

    // ── JS dialogs (alert/confirm/prompt policy + log) ───────────────────────
    browser_handle_dialog: async (p) => dialog.handleDialog(await tab(p), p ?? {}),
  };
}
