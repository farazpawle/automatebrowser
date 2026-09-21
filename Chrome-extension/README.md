# AutomateBrowser extension — `Chrome-extension/` (WXT source)

WXT **source project** for the AutomateBrowser browser extension (Chrome/Edge). This
is the single source of truth (~40 KB built, replacing the old ~2.2 MB minified
bundle). **Load the build output `Chrome-extension/.output/chrome-mv3/`** as an
unpacked extension.

## Why this exists

The shipped extension only existed as a minified bundle. This rebuild reimplements
it from scratch with three goals: an **always-on connection** (no manual per-tab
Connect), **agent-driven tab takeover**, and a **debugger-free automation engine**
(so there is no "started debugging this browser" banner, no CDP attach latency, and
no CDP-into-contenteditable hang).

## How it works now

- **Connection is always on.** `lib/connection.ts` opens the socket on service-worker
  startup and keeps it alive — it does NOT wait for a tab to be selected. It tries the
  last-good port first (`lib/last-port.ts`), otherwise races all of 9009-9013 at once and
  keeps whichever returns a valid `hello`. First connect ≈ one round-trip; reconnects are
  effectively instant.
- **Targeting is per-call.** `lib/selected-tab.ts#resolveTargetTabId` drives the explicit
  pinned tab if set, else the active tab. The agent pins a (possibly background) tab with
  `browser_select_tab`; `browser_switch_tab`/`browser_new_tab` also set the target.
- **Engine is debugger-free.** `lib/automation/driver.ts` runs everything through
  `chrome.scripting.executeScript` (ISOLATED world for snapshot/interactions — shares the
  page DOM; MAIN world for `eval` and console capture). Snapshot tags interactive elements
  with `data-bmcp-ref="eN"`, so a later click/type resolves the ref via `querySelector` —
  the DOM is the ref registry (no cross-call global state). The manifest drops the
  `debugger` permission entirely.
- **Console capture** is a MAIN-world `document_start` content script (`entrypoints/content.ts`)
  that buffers console + errors on `window.__bmcpLogs`; `browser_get_console_logs` reads it back.

## Architecture

```
entrypoints/
  background.ts        service worker: runs the connection loop + routes requests
  content.ts           content script entry (automation engine PORT PENDING)
  popup/               Connect / Disconnect + the browser Label field
lib/
  protocol.ts          wire contract (hello / identify / messageResponse)
  connection.ts        ★ port scan 9009-9013 + hello validation + identify + dispatch
  identity.ts          browser detection (chrome/edge/brave) + label + instanceId
  selected-tab.ts      the tab the user chose to drive (chrome.storage.local)
  automation/
    index.ts           message-type -> handler map
    navigation.ts      navigate / back / forward / wait / screenshot   (clean source)
    tabs.ts            list / new / switch / close tabs                 (clean source)
    wait-for.ts        browser_wait_for via injected poller             (clean source)
    driver.ts          click / type / snapshot / console logs           (PORT PENDING)
```

★ `lib/connection.ts` is the heart of the connection fix and mirrors the
server contract in `../src/vendor/types/messages-ws.ts`.

## Conversion status

| Area | State |
|------|-------|
| WS connection (last-port + concurrent race + hello + identify + always-on reconnect) | ✅ clean source |
| Targeting (active-tab fallback + `browser_select_tab`) | ✅ clean source |
| Popup (Pin tab / Follow active tab + Label) | ✅ clean source |
| Manifest (key, permissions **minus debugger**, externally_connectable, Alt+J) | ✅ via `wxt.config.ts` |
| Navigation / timing / screenshot / tabs / wait_for | ✅ clean source |
| Snapshot, click/hover/drag/type/select, press_key, eval | ✅ clean source — **debugger-free** (`chrome.scripting`) |
| Console logs | ✅ MAIN-world content-script ring buffer |

The rewrite is feature-complete and replaces the shipped bundle. It typechecks
(`npm run compile`) and builds (`npm run build`) green. **Live behaviour must be
verified in a real Chrome/Edge** (snapshot fidelity, click/type on real pages,
the ChatGPT contenteditable case) — see the repo plan's verification section.

Known trade-offs vs the old CDP engine:
- `browser_eval` runs in MAIN world and can be blocked by a page's strict CSP
  (no `unsafe-eval`); it returns a clear error and the agent falls back to
  `browser_snapshot`.
- The snapshot is a pragmatic home-grown a11y walk (flat `role "name" [ref=eN]`
  list), not Playwright's tree — good for agent targeting; iterate as needed.
- Synthetic events (`el.click()`, native value setter + `input`, `execCommand`)
  are not `isTrusted`; a few sites that gate on trusted events may need tuning.

## Build & install

```bash
cd Chrome-extension
npm install
npm run compile      # tsc type-check
npm run build        # outputs .output/chrome-mv3/
```

Then **Load unpacked `Chrome-extension/.output/chrome-mv3/`** (Chrome 137+ blocks
CLI `--load-extension`); click **reload ↻** after each rebuild. The manifest carries **no `key`**,
so an unpacked load gets a random id per profile — read it off the card in `chrome://extensions`.
Icons live in `public/icon/`.
