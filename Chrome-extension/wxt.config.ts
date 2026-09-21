import { defineConfig } from "wxt";

/**
 * WXT build config. Keeps the permissions and entry points of the extension this
 * was forked from, and lets WXT generate the MV3 manifest from entrypoints/.
 *
 * THE `key` IS GONE (2026-09-21), and with it the pinned id
 * `bjfgambnhccakkhmkepdoekmckoijdlc`. Its comment said the pin kept "existing
 * installs / the AutomateBrowser connect page" working, which was true and beside
 * the point: that id is a LIVE Chrome Web Store listing — "Browser MCP" by
 * browsermcp.io, 100,000 users — and the key was its public key, inherited in the
 * fork. It could never have been published under, and declaring someone else's
 * identity is not something to carry into a store submission.
 *
 * The cost is real and was accepted: an unpacked load now gets a fresh, random id
 * per profile, so anyone who side-loaded an earlier build gets a SECOND card in
 * chrome://extensions rather than an update. Remove the old one.
 *
 * The store assigns the real id at first upload. Record it in the `extension`
 * skill when it exists; nothing in this repo should hard-code one again.
 */
export default defineConfig({
  manifest: {
    name: "AutomateBrowser",
    // Was "AutomateBrowser - Automate your browser using VS Code, Cursor, Claude,
    // and more" until 2026-09-21 — a tail identical to the listing this was forked
    // from, which both stores treat as a confusingly similar listing. The store
    // renders name and description as separate fields, so the pitch goes in the
    // description — which Chrome caps at **132 characters** and which both stores
    // use as the short description. The long version belongs in the dashboard's
    // own description field (Edge wants 250+ there), not here.
    description:
      "Let an AI agent drive your real, logged-in browser from your editor — your tabs, your sessions, nothing leaving your machine.",
    // No `default_locale`: the name/description are literal strings (no __MSG__
    // placeholders), so shipping a _locales/ folder isn't needed — and declaring
    // default_locale without one makes Chrome reject the unpacked load.
    action: {
      default_title: "AutomateBrowser",
      default_popup: "popup.html",
      default_icon: "/icon/48.png",
    },
    // The engine is debugger-free BY DEFAULT (chrome.scripting only → no banner).
    // "debugger" is declared so the agent can OPT IN to advanced mode
    // (browser_advanced_mode) without a user gesture; the "started debugging this
    // browser" banner appears only while a tab is actually attached. Declaring it
    // adds an install/update permission warning (Chrome re-prompts on update).
    // "alarms" keeps the MV3 service worker reconnecting after Chrome evicts it.
    // "cookies" backs browser_get_cookies/browser_set_cookie; "webRequest"
    // (observe-only) backs browser_network_requests (metadata, no bodies).
    // "downloads" backs browser_downloads — it is the only API that can report a
    // download's final path, and like "debugger" it makes Chrome DISABLE the
    // extension until the user re-approves it on update. Shipped in the same
    // release as "declarativeNetRequest" so that cost is paid once, not twice.
    // "declarativeNetRequest" backs B9's origin deny-list at the NETWORK layer:
    // tool-level gating alone leaves browser_eval free to fetch() a denied
    // origin from an allowed page. Same re-prompt cost, paid in the same update.
    // "proxy" backs browser_proxy (C12). It is PROFILE-WIDE — Chrome has no
    // per-tab proxy — so it mutates the browsing of the human sharing this
    // browser, which is why it is shipped with the warning carried in the tool
    // description and in every result. Like "debugger"/"downloads" it adds an
    // install/update permission warning, so Chrome DISABLES the extension until
    // the user re-approves it.
    permissions: [
      "scripting",
      "storage",
      "tabs",
      "alarms",
      "cookies",
      "webRequest",
      "debugger",
      "downloads",
      "declarativeNetRequest",
      "proxy",
    ],
    host_permissions: ["<all_urls>"],
    // No `externally_connectable`. It listed "https://*.automatebrowser.com/*"
    // until 2026-09-21 — a domain this project does not own — and NOTHING in the
    // extension ever listened: there is no `onMessageExternal` handler anywhere.
    // A declared capability with no code behind it, naming someone else's domain,
    // is a question at review with no good answer.
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+J" },
      },
    },
  },
});
