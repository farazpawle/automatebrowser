import { createHandlerMap } from "../lib/automation";
import * as cdp from "../lib/automation/cdp";
import { installNetworkCapture } from "../lib/automation/network";
import { startConnectionLoop } from "../lib/connection";
import { preserve } from "../lib/preserved-logs";
import type { AgentClaim, AgentPeer } from "../lib/protocol";
import { resolveTargetTabId } from "../lib/selected-tab";

/**
 * Background service worker. Owns the always-on WebSocket connection (fast port
 * discovery + hello validation + identify + reconnect) and routes server
 * requests to the automation handlers. The driven tab is resolved per-call
 * (explicit selection → active tab) — the connection itself no longer waits for
 * the user to pick a tab.
 *
 * MV3 reality: Chrome evicts an idle service worker after ~30s, which would kill
 * an in-worker reconnect timer and silently drop the connection (the classic
 * "I keep having to reconnect"). We counter that with:
 *   - while CONNECTED, the server's ~20s heartbeat ping keeps the worker alive;
 *   - a `chrome.alarms` tick (every 30s, the MV3 minimum) + startup/install
 *     events REVIVE the worker when it has been evicted while disconnected.
 *     Each revival re-runs this entry, which restarts the connection loop.
 * Opening the popup also wakes the worker (its status query), so connection
 * recovers immediately when the user looks.
 */

const KEEPALIVE_ALARM = "bmcp-keepalive";

let connected = false;
let port: number | null = null;
/** Agents currently driving THIS browser, as last pushed by the relay (`agents` frame). */
let agents: AgentClaim[] = [];
/** All agents CONNECTED to the relay (roster), pushed alongside `agents`. Listed
 * in the popup even when idle, so a connected agent never silently disappears. */
let roster: AgentPeer[] = [];

export default defineBackground(() => {
  const handlers = createHandlerMap({ getTabId: () => resolveTargetTabId() });

  // Start observing network traffic (webRequest) so browser_network_requests has
  // a buffer to read. Idempotent + a no-op if the permission isn't granted.
  installNetworkCapture();

  // Register debugger/CDP lifecycle listeners so advanced-mode sessions clean up
  // when a tab closes or DevTools detaches, and CDP Network/Tracing events buffer.
  cdp.installListeners();

  const connection = startConnectionLoop({
    handlers,
    onConnected: (p) => {
      connected = true;
      port = p;
    },
    onDisconnected: () => {
      connected = false;
      port = null;
      agents = []; // nobody is driving us once the socket is gone
      roster = []; // and we no longer know who is connected
    },
    onAgents: (claims, controllers) => {
      agents = claims;
      roster = controllers;
    },
  });

  // Ensure the keep-alive alarm exists (idempotent). 0.5 min is the MV3 minimum.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

  // Keep the relay roster's tab info LIVE: when the user switches tabs or the
  // active tab finishes navigating, re-send identify so browser_status /
  // browser_list_clients show the current URL (and an agent can tell it is on a
  // restricted page). Debounced so a burst of onUpdated events sends once.
  let identityTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshIdentitySoon = () => {
    if (identityTimer !== undefined) clearTimeout(identityTimer);
    identityTimer = setTimeout(() => connection.refreshIdentity(), 250);
  };
  chrome.tabs.onActivated.addListener(() => refreshIdentitySoon());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    // Only care about the active tab's URL/title settling.
    if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
      refreshIdentitySoon();
    }
  });
  chrome.windows?.onFocusChanged?.addListener(() => refreshIdentitySoon());

  // Popup → background messages. Status query responds synchronously; the
  // reconnect command lets the popup force a fresh connect (drop + re-race ports).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "bmcp:getStatus") {
      sendResponse({ connected, port, agents, roster });
      return false;
    }
    if (msg?.type === "bmcp:reconnect") {
      connection.reconnect();
      sendResponse({ ok: true });
      return false;
    }
    // A page handing over its console buffer on the way out (B1c). Sent by the
    // ISOLATED-world bridge script, so `_sender.tab` is the tab it belonged to —
    // never trust a tab id from the message body.
    if (msg?.type === "bmcp:preserveLogs") {
      const tabId = _sender.tab?.id;
      if (tabId != null) {
        void preserve(tabId, {
          url: String(msg.url ?? ""),
          title: String(msg.title ?? ""),
          ts: Date.now(),
          entries: Array.isArray(msg.entries) ? msg.entries : [],
          dropped: Number(msg.dropped) || 0,
        });
      }
      return false;
    }
    if (msg?.type === "bmcp:detachAll") {
      void cdp.detachAll();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
});

// These top-level listeners revive the worker when it was evicted. Their mere
// firing re-runs the background entry above (restarting the connection loop);
// the handlers themselves can be no-ops.
chrome.alarms.onAlarm.addListener(() => {
  /* waking the worker is the point */
});
chrome.runtime.onStartup.addListener(() => {
  /* connect on browser launch */
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
});
