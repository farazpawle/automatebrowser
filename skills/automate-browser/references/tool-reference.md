# Every tool, and its gotcha

The tables below are **generated from the server's own schemas** by `npm run docs:generate`, so the
tool list here cannot drift from the code. Do not edit between the `AUTO-GENERATED` markers.

The **Gotchas** section after them is hand-written, and is where the value is: the table tells you a
tool exists, the gotcha tells you the thing that will cost you an hour.

## Contents

| Section | What it covers |
|---|---|
| [The tools](#the-tools) | All of them, generated, grouped |
| [Arguments and gotchas](#arguments-and-gotchas) | What to pass, and what bites |

---

## The tools

<!-- AUTO-GENERATED:tools START — do not edit by hand; run `npm run docs:generate` -->

### Navigation & history
| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL in YOUR OWN tab, opened in the background if you have none |
| `browser_go_back` | Go back to the previous page |
| `browser_go_forward` | Go forward to the next page |

### Snapshot & interaction
| Tool | Description |
|------|-------------|
| `browser_snapshot` | Capture accessibility snapshot of the current page |
| `browser_click` | Click an element by ref, or a viewport point by x/y |
| `browser_hover` | Hover over element on page |
| `browser_type` | Type text into editable element |
| `browser_select_option` | Select an option in a dropdown |
| `browser_drag` | Perform drag and drop between two elements |

### Input & timing
| Tool | Description |
|------|-------------|
| `browser_press_key` | Press a key or modifier combo (e.g. Enter, Tab, "Control+A", "Shift+Tab") on the focused element |
| `browser_wait` | Wait for a specified time in seconds |
| `browser_wait_for` | Wait for a page condition to become true (element appears/disappears, text appears, URL changes) |

### Reading content
| Tool | Description |
|------|-------------|
| `browser_read_page` | Read the page's main content as clean text or Markdown (strips nav/scripts/styles) |
| `browser_get_html` | Get the raw outerHTML of the page (or of a specific element by `ref`) |
| `browser_find` | Find elements by text, role, and/or CSS selector and return refs WITHOUT a full snapshot |

### Page-declared tools
Actions the PAGE publishes about itself, which an agent can call directly instead of finding and clicking controls for. Forward-looking: the standard is a draft and almost no live site declares anything yet, so `list` normally comes back empty with the reason.

| Tool | Description |
|------|-------------|
| `browser_page_tools` | List and call actions a page declares about itself (WebMCP) |

### Forms & scrolling
| Tool | Description |
|------|-------------|
| `browser_fill_form` | Fill multiple form fields (inputs, textareas, selects, checkboxes, radios, contenteditable) in ONE call |
| `browser_clear` | Clear the value of an input, textarea, or contenteditable element by `ref` |
| `browser_scroll` | Scroll the page or an element |

### State: cookies, storage, network, downloads, dialogs
| Tool | Description |
|------|-------------|
| `browser_get_cookies` | List cookies for the URL of the tab you are driving (optionally filter by `name`) |
| `browser_set_cookie` | Set (create/overwrite) a cookie on the URL of the tab you are driving |
| `browser_storage` | Read or write the page's localStorage/sessionStorage |
| `browser_network_requests` | List network requests the tab you are driving made on the CURRENT page (method, URL, status, type, timing) — pass includePreserved for the pages before it |
| `browser_handle_dialog` | Control JS dialogs (alert/confirm/prompt) |
| `browser_downloads` | Recent downloads: final path on disk, URL, mime, size, state |
| `browser_proxy` | Route the browser through a proxy |

### Performance
`browser_perf_trace` measures THIS machine on THIS run. Recording attaches the debugger itself (banner) and detaches it on stop unless advanced mode was already on; `action: "memory"` samples the JS heap with no debugger and no banner. `browser_perf_field_data` needs no browser at all - it reads Google's Chrome UX Report for what real visitors experienced, and sends the URL you ask about to that public API.

| Tool | Description |
|------|-------------|
| `browser_perf_field_data` | Real-user Core Web Vitals (p75 LCP/INP/CLS/FCP/TTFB) for a URL, from Google's Chrome UX Report |

### Capture & evaluation
| Tool | Description |
|------|-------------|
| `browser_screenshot` | Capture the visible viewport of the tab you are driving — including a background tab, which is rendered via the debugger (brief banner) rather than refused |
| `browser_get_console_logs` | Console logs, uncaught errors with stacks, and service-worker lifecycle (register/state/messages) |
| `browser_issues` | Problems the browser detected that produce NO console error: blocked content (CSP), deprecated API use, browser interventions, and failed or 4xx/5xx network requests |
| `browser_eval` | Evaluate JavaScript in the tab you are driving and return the result |

### Tabs
| Tool | Description |
|------|-------------|
| `browser_list_tabs` | List the connected browser's open tabs |
| `browser_new_tab` | Open a new tab IN THE BACKGROUND and drive it — no focus stealing |
| `browser_switch_tab` | STEALS THE USER'S FOCUS: brings a tab to the front and drives it, by `tabId` (preferred) or `index` |
| `browser_select_tab` | TAKE OVER a tab the user already has open, WITHOUT focusing it — the tool for "pick up the testing I started" |
| `browser_close_tab` | Close a tab by `tabId` or `index` |

### Multi-IDE / clients
| Tool | Description |
|------|-------------|
| `browser_list_clients` | List every browser connected to the shared AutomateBrowser relay (e.g. Chrome and Edge when both have the extension connected), across all IDEs |
| `browser_select_client` | Choose which connected browser your subsequent tools act on |
| `browser_force_claim` | Forcibly take over a browser that another agent is currently driving, and make it active for your tools |
| `browser_release_client` | Release your claim on the browser you are currently driving so another agent can take it |
| `browser_status` | Diagnostics for the AutomateBrowser relay |

### Advanced (opt-in CDP)
Attach the Chrome debugger only when you need full-fidelity input or network bodies. Enable with
`browser_advanced_mode` first (a perf trace attaches by itself); a debugging banner shows only
while it's attached.

| Tool | Description |
|------|-------------|
| `browser_advanced_mode` | Enable/disable opt-in debugger (CDP) mode for the tab you are driving |
| `browser_upload_file` | Set files on a file input (real upload) |
| `browser_get_network_request` | Get a network request's response BODY, status and headers by URL substring |
| `browser_perf_trace` | Record a performance trace (attaches the debugger while recording) |
| `browser_emulate` | Emulate location, headers, colour scheme, viewport, user agent, network or CPU |

<!-- AUTO-GENERATED:tools END -->

---

## Arguments and gotchas

`*` marks a required argument. Tools that navigate or act on an element also take `timeout` (ms); the
read-only ones — snapshot, read_page, get_html, find, screenshot, eval — do **not**, and reject it.

### Navigation & history

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_navigate` | `url`, `reload`, `ignoreCache`, `includeSnapshot`, `include`, `waitUntil`, `settleMs`, `initScript`, `handleBeforeUnload` | Runs in **your** tab, opening one in the background if you have none. `reload` re-requests the current page and takes no `url`; `ignoreCache` makes it a hard reload — the answer to "but I already fixed that". `initScript` and `handleBeforeUnload` need advanced mode, and `initScript` alone is refused with `EVAL_BLOCKED` where the operator has switched off agent-written JavaScript — drop it and the same call goes through. By default it also waits, after the load, for 0.3 s without a DOM change (cap 1.5 s) so a script-built page is drawn before the snapshot — `waitUntil: "load"` skips that. `settled` describes the navigation you asked for, never the page you were leaving; with `initScript` in play, `waitUntil: "none"` still waits for the new document, because a script torn down before then would never run. If the tab is not where you asked it to go, the reply opens with `Did NOT reach <url>` — including inside the snapshot reply, where the snapshot below it is then the OLD page and every ref in it belongs to that page. |
| `browser_go_back` | `waitUntil`, `settleMs` | History is per tab, so this is your tab's history, not the user's browsing. |
| `browser_go_forward` | `waitUntil`, `settleMs` | Silently does nothing if there is no forward entry — about a second of waiting, then an unsettled result and the same url. |

### Snapshot & interaction

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_snapshot` | `verbose`, `filePath` | The **most expensive call in the set**. Read it once to learn the page, then use `browser_find`. `filePath` keeps a big one out of your context. An `<iframe>` in the tree is only a marker — **every** frame's contents come below under their own `- frame <url>` heading with `fN:` refs, same-origin ones included, capped at 10 frames. A control with no text is named by its `title`, inner image `alt`, or `#id` — an id names the element, not its purpose. |
| `browser_click` | `element`, `ref`, `x`, `y`, `dblClick`, `include`, `includeSnapshot`, `waitUntil`, `settleMs` | Pass a ref **or** coordinates, never both — giving both is refused before it runs. The coordinate form reports what was actually under the point. A ref click the page showed no reaction to adds "No change seen on the page" — a note, not an error; some pages need a real click (advanced mode, tab visible). |
| `browser_hover` | `element*`, `ref*`, `includeSnapshot` | By default synthetic: page scripts see it (a JS hover menu opens), CSS `:hover` does NOT apply — the reply says so. For the CSS look, `browser_advanced_mode` with the tab visible: a real mouse move, refused on a hidden tab. Nothing "sticks" — the next action may move the pointer. |
| `browser_type` | `element*`, `ref*`, `text*`, `submit*`, `include`, `includeSnapshot`, `waitUntil`, `settleMs` | `submit` is **required**: decide explicitly whether Enter is pressed. Use `browser_clear` first rather than typing over existing content. |
| `browser_select_option` | `element*`, `ref*`, `values*`, `includeSnapshot` | `values` is an array even for a single option, and matches by visible label or value. |
| `browser_drag` | `startElement*`, `startRef*`, `endElement*`, `endRef*`, `includeSnapshot` | Both ends need a description as well as a ref. Both ends must also be in the **same frame** — a cross-frame drag is refused, not attempted. Some drag libraries need a real pointer sequence — if it does nothing, try advanced mode. |

### Input & timing

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_press_key` | `key*`, `waitUntil`, `settleMs` | Goes to the page, not to an element — focus something first. Combos are `"Control+A"`, `"Shift+Tab"`. |
| `browser_wait` | `time*` | A blind sleep, in **seconds**. Last resort: either too short and flaky or too long and slow. Prefer `browser_wait_for`. |
| `browser_wait_for` | `selector`, `text`, `urlPattern`, `state`, `timeoutMs` | The right tool when a site swaps content **without** navigating. Waits on a real condition instead of a guess. A plain `text` matches a placeholder that shares its start ("Result: n/a") at once — use `/Result: \d+/`. `state: "detached"` with `text` waits for it to go. |

### Reading content

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_read_page` | `format`, `maxLength` | The default answer to "what does this page say". `format: "markdown"` keeps headings and links; plain text is cheaper. |
| `browser_get_html` | `ref`, `maxLength` | **Always pass a `ref`.** Whole-page HTML is almost never what you want and is enormous. |
| `browser_find` | `text`, `role`, `selector`, `max` | Far cheaper than a snapshot and returns usable refs. Set `max` — an unbounded match on a big page is not the saving you wanted. A `text` match is the innermost element holding it, never `html`/`body`/wrappers. Only a `selector` reaches undrawn elements (`<head>`, hidden inputs), marked `(hidden)`. Matches print `id`/`href`/`title`/`datetime`/`content`. An icon-only control is named by its image's `alt`. |

### Page-declared tools

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_page_tools` | `action*`, `name`, `args` | **Expect an empty list.** Almost no live site declares tools yet, and an empty answer is a fact about the page, not a failure — do not retry it, and do not let it stop you clicking. `args` is a JSON object **string**, not an object. A result that will not encode as JSON comes back as a note instead; reach for `browser_eval` and `window.__dtmcp.executeTool` if you need the live value. |

### Forms & scrolling

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_fill_form` | `fields*` | Fill **every** field in one call. Field-by-field clicking and typing is slower and far more brittle. Submit separately. **May mix frames** — the only ref-taking tool that may — and fills in the order you pass, so a form spanning an embedded widget goes in one call. Nothing is written unless every ref parses; read `errors` for per-field results, which name the refs you passed. **Some-but-not-all is `outcome: "partial"`, not an error** — `isError` is set only when NOTHING landed, so read `Filled n/total` rather than the flag. Checkboxes and radios take **`"true"` / `"false"` only** — anything else is refused per field rather than guessed at; choose one option of a group by setting that option's own ref to `"true"`. |
| `browser_clear` | `ref*` | Empties an input properly. Typing over existing content is how you end up with `oldnew`. Follows the same frame rules as `browser_fill_form`, and reaches inside a shadow root. |
| `browser_scroll` | `ref`, `to`, `dx`, `dy` | On an infinite list, content below the fold may not be in the DOM at all — scroll, read, repeat. |

### State: cookies, storage, network, downloads, dialogs

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_get_cookies` | `name`, `revealValues` | Values are **redacted by default**. Scoped to your tab's URL, so navigate to the origin first. |
| `browser_set_cookie` | `name*`, `value*`, `path`, `secure`, `httpOnly`, `expirationDate`, `sameSite` | Only for a session you were explicitly given. Never harvest one. |
| `browser_storage` | `action*`, `area`, `key`, `value`, `revealValues` | `sessionStorage` is **not** shared with a new tab; `localStorage` is. That difference explains most "why am I logged out in the new tab". |
| `browser_network_requests` | `limit`, `page`, `resourceTypes`, `includePreserved` | The request **list**, not bodies. **Paged — 50 newest per call**, and `page: 2` is *older*, not newer. `includePreserved` reaches back through a redirect. |
| `browser_handle_dialog` | `action`, `promptText` | An unanswered dialog **freezes the page**, so your next call hangs to its full timeout. A hang is a dialog until proven otherwise. |
| `browser_downloads` | `limit`, `wait`, `timeout` | Returns the **path on disk**, so you can read the file. `wait: true` avoids reading a half-written one. |
| `browser_proxy` | `mode`, `server`, `pacUrl`, `bypass`, `clear` | **Affects the whole browser**, not your tab — it changes the browsing of the human sharing it. Clear it when done. |

### Performance

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_perf_field_data` | `url*`, `formFactor` | Needs no browser, but **sends the URL to a Google API** and needs `AUTOMATE_BROWSER_CRUX_KEY`. The only outbound call this server makes. |

### Capture & evaluation

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_screenshot` | `format`, `ref`, `filePath`, `quality`, `fullPage`, `keepEnabled`, `frames`, `intervalMs` | Use `filePath` unless you must see it — an inlined image is one of the costliest things in a reply. On a background tab it attaches the debugger briefly (banner), and **refuses rather than returning the wrong tab's pixels** if it cannot. `frames` writes a strip to disk (needs `filePath`) — but a background tab yields **one frame every ~4s**, so switch to it first if you need motion. An **inline** image is downscaled to fit 1536x4096 device px and says so — never read coordinates off one that was; a `filePath` capture never is. A `ref` from a **same-origin** frame crops fine at any depth; one from a **cross-origin** frame is refused, because the frame's position in the tab cannot be measured from outside it — capture the viewport instead. |
| `browser_get_console_logs` | `includePreserved`, `page` | **Paged — 50 newest entries per call**, and `page: 2` is *older*, not newer. `includePreserved` returns the previous pages' logs — the answer to "it errored then redirected". |
| `browser_issues` | `limit`, `audit`, `page` | The **only** tool that sees failures with no console error: CSP, dropped third-party cookies, mixed content, CORS. Reach for it on "works by hand, not here". `audit: "a11y"` switches it to an axe-core accessibility audit instead — snapshot FIRST so findings carry refs, page through with `page` (`limit` sets the page size), and never report "0 violations" as "accessible": automated rules catch about a third of real barriers. |
| `browser_eval` | `expression`, `function`, `args`, `filePath`, `dialogAction`, `timeout` | Default limit 8 s; pass `timeout` for slow page work — a timed-out script still runs on in the page. Use `function` + `args` of refs for anything structured. Return **JSON-serialisable** values — DOM nodes do not survive. Passing both forms, or `args` without `function`, is refused. An operator can switch this tool off entirely (`EVAL_BLOCKED`, even for a read) — if that happens, read with `browser_snapshot` or `browser_find` and stop looking for a way around it. |

### Tabs

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_list_tabs` | (none) | Pure discovery — claims nothing, so it never locks another agent out. |
| `browser_new_tab` | `url`, `active`, `incognito` | Opens in the **background** and is adopted automatically. `active: true` steals the user's focus — only on request. `incognito: true` gives a clean logged-out session, but needs a setting only a person can turn on; on `INCOGNITO_BLOCKED`, ask them rather than retrying. A `chrome://` / `edge://` `url` is refused (`RESTRICTED_PAGE`), as navigate refuses it. |
| `browser_switch_tab` | `tabId`, `index` | The **only** tool that takes the user's focus. For "show me", nothing else. Restores a minimised window; the reply's ending says whether the page is really visible — "still hidden" means it is not. |
| `browser_select_tab` | `tabId`, `index`, `url`, `title` | Adopt a tab **without** focusing it. Prefer `url`/`title` over `index`, which shifts as tabs open and close. |
| `browser_close_tab` | `tabId`, `index` | Do not close a tab you did not open. Release already closes yours. |

### Multi-IDE / clients

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_list_clients` | (none) | Shows every connected browser **and who is driving each tab**. |
| `browser_select_client` | `id`, `browser`, `label`, `force` | Per-agent and sticky; it does not change what other agents see. Selecting does **not** claim — acting does. |
| `browser_force_claim` | `id`, `browser`, `label`, `force` | Steals at **whole-browser** level and tells the other agent immediately, mid-task. Last resort. |
| `browser_release_client` | (none) | Frees the browser **and closes every tab you opened**. A tab you adopted from the user is left alone. Call it when genuinely done. |
| `browser_status` | (none) | The one call that explains everything else. Call it before guessing. Its `link:` line names the connection state in capitals — `CONNECTED`, `WAITING` (on the relay, no browser has joined), `RETRYING` (it recovers on its own, with the countdown), `CONNECTING`, `STOPPED` (nothing is being retried, so waiting is wrong). |

### Advanced (opt-in CDP)

| Tool | Arguments | Gotcha |
|---|---|---|
| `browser_advanced_mode` | `enable` | Attaches the debugger and shows a banner, and is the **only** thing that switches click, key and hover to real input. Turn it off when done. Omit `enable` to just ask whether it is on — a capture's leftover attach reads OFF, listed under attached tabs. **There is no `acceptInsecureCerts` any more** — it never worked (Chrome does not expose the domain it needed to extensions) and was deleted on 2026-09-16; passing it is refused by name. For a bad certificate, ask the user to click through the warning once by hand, or to start the browser with `--ignore-certificate-errors`. |
| `browser_upload_file` | `ref*`, `filePaths*`, `keepEnabled` | Needs advanced mode. The `ref` must be the file input itself, not a styled wrapper around it. A **cross-origin** frame's input is refused and says the frame is why — no fresh snapshot will help, because the debugger session does not reach into another origin. Same-origin frames (at any depth) and shadow roots work. |
| `browser_get_network_request` | `url`, `requestId`, `maxLength`, `keepEnabled`, `revealValues` | The response **body**, plus both header sets with credential values **redacted** — `revealValues` opts out. When a URL matches several, it returns the newest and lists the rest so you can pick by `requestId`. `keepEnabled` keeps the debugger for later reads only — your clicks stay on the default path. |
| `browser_perf_trace` | `action*`, `categories`, `filePath`, `reload`, `autoStop`, `durationMs` | `action: "analyze"` re-reads a saved trace with **no browser at all**, and `action: "memory"` samples the JS heap with **no advanced mode**. Recording attaches the debugger itself and detaches it on stop, unless advanced mode was already on. `reload`/`autoStop` on a hidden page is refused at once (`TAB_HIDDEN`): no LCP exists for a page loaded unseen. `durationMs` (memory) is 1000-30000 and is refused, not clamped, outside that. A rising heap is not a leak, and there is **no heap snapshot** — Chrome blocks the domain for extensions. |
| `browser_emulate` | `geolocation`, `headers`, `colorScheme`, `viewport`, `mobile`, `userAgent`, `network`, `cpuThrottling`, `clear` | Per tab, and gone with the tab. Some options need advanced mode and say so. `clear` takes them back off. |
