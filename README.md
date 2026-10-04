<h3 align="center">AutomateBrowser</h3>

<p align="center">
  Automate your <strong>real</strong> browser with AI — debugger-free, logged-in, and shareable across IDEs.
  <br />
  <a href="https://farazpawle.github.io/automatebrowser/"><strong>Website</strong></a>
</p>

---

## About

**AutomateBrowser** is an [MCP](https://modelcontextprotocol.io) server paired with a Chrome/Edge
browser extension. Instead of launching a fresh, sterile browser instance like most automation
tools, it drives **your actual browser tab** — with your logins, cookies, sessions, and fingerprint
intact — from AI clients such as Claude Code, Claude Desktop, Cursor, VS Code, and Windsurf.

- **MCP server** (`@automatebrowser/mcp`) — a stdio server that exposes 46 browser tools to your AI client.
- **Browser extension** (`Chrome-extension/`, v1.0.0) — a Manifest V3 extension that connects to the
  server over a local WebSocket and runs the automation inside your tab.
- **Terminal CLI** (`automate-browser`) — the same tools from a shell, sharing the browser with
  whatever IDEs are connected. See [Terminal CLI](#terminal-cli).

The two halves talk over a loopback WebSocket on `127.0.0.1:9009`. Nothing about your browsing
leaves your machine. The server makes exactly two outbound calls, both optional: a once-a-day
check for a newer release, which sends nothing about you and can be switched off
(→ [here](#finding-out-your-copy-is-out-of-date)), and the field-data tool, which is inert
unless you supply an API key.

## Why AutomateBrowser

- ⚡ **Fast** — automation runs locally; no remote round-trips.
- 🔒 **Private** — your browsing stays on your device.
- 👤 **Logged in** — uses your real profile, so you stay signed into every service.
- 🥷 **Stealthy** — your genuine browser fingerprint sidesteps most bot-detection and CAPTCHAs.
- 🧩 **Debugger-free by default** — interactions go through `chrome.scripting`, so there is **no
  "started debugging this browser" banner**. CDP is per-tab and used only where nothing else can do
  the job: when you ask for it, for a full-page screenshot, and for a screenshot of a background tab,
  where it is the only way to get the right pixels without stealing your focus. It detaches again
  straight after. → [What can take your focus](#what-can-take-your-focus)
- 🪶 **Token-efficient** — interactions return short confirmations; full accessibility snapshots are
  fetched only when an agent asks for fresh element refs.
- 🤝 **Multi-IDE sharing & per-tab control** — a single shared relay lets every IDE see and drive the
  same browsers. Ownership is **per tab**, so two agents (e.g. two IDEs) can drive two *different* tabs
  of the same browser at the same time; only same-tab access is serialized, via a soft-claim with a
  named handoff.

## What it can do

A tour of the whole surface. Each line links to the detail further down; the full per-tool tables are
under [Tools](#tools).

**Drive the page**
- Navigate, reload (including a **hard reload that bypasses the cache**), back, forward, and wait for
  a load or for a condition to become true. A navigation reports itself finished only when **the
  navigation you asked for** finished — never because the page you were leaving had already loaded.
  → [What `settled` means on a navigation](#what-settled-means-on-a-navigation)
- A navigation that **did not happen says so**, in the snapshot reply too, instead of handing you the
  previous page under a success message.
  → [A navigation that did not happen says so](#a-navigation-that-did-not-happen-says-so)
- A page that **failed to load** fails the call with Chrome's own error, instead of an "ok" on Chrome's
  error page. → [A page that failed to load says so](#a-page-that-failed-to-load-says-so)
- Click, type, hover, drag, press keys, select options, scroll, and **fill a whole form in one call**.
  Checkboxes and radios take a **boolean and nothing else** — a value that is neither is refused rather
  than guessed at. → [Checkboxes and radios take a boolean](#checkboxes-and-radios-take-a-boolean-and-nothing-else)
- A form that **spans an embedded widget and the page around it** fills in one call, in the order you
  wrote it. → [Filling a form that spans frames](#filling-a-form-that-spans-frames)
- Click by **element** or by **coordinate**, for canvases, maps and PDF viewers that a snapshot cannot
  name. → [Clicking something a snapshot cannot name](#clicking-something-a-snapshot-cannot-name)
- A click **the page ignored says so** — "Clicked" alone used to be all you got from a page that acts
  only on a real click. → [A click the page ignored is reported](#a-click-the-page-ignored-is-reported)
- A hover **says what it did**: by default page scripts see the mouse but CSS `:hover` styles do not
  apply; with advanced mode on it is a real mouse move and they do.
  → [Hover: what the page sees, and what CSS sees](#hover-what-the-page-sees-and-what-css-sees)
- Interactions report the same result **whether or not the debugger is attached** — same fields, same
  waiting — and only advanced mode itself makes them real input; reading a response body does not.
  → [Advanced mode does not change what interactions return](#advanced-mode-does-not-change-what-interactions-return)
- Upload files, and answer `alert`/`confirm`/`prompt` dialogs — including the native "Leave site?"
  prompt that page JavaScript cannot even see.
- Every interaction **waits for the element to be genuinely ready** — visible, enabled, still, and not
  covered by an overlay — then waits for the page to settle before returning.
  → [Actionability](#actionability-interactions-wait-for-the-element-to-be-ready)
- Choose per call what **"finished" means** — return at once, wait for load, or wait for the network
  to go quiet — and cap how long that wait may take. By default a navigation also waits for the page
  to **finish drawing**, so a script-built page like YouTube is not read as an empty shell.
  → [Deciding when an action is finished](#deciding-when-an-action-is-finished)
- **Wait for a condition, not a duration** — an element, the URL, or text, where text can be a
  pattern (`/Result: \d+/` skips the "Result: n/a" placeholder) or something to wait to **disappear**.
  → [Waiting for a condition, not a duration](#waiting-for-a-condition-not-a-duration)
- Run your own JavaScript against elements you already found, with a **time limit you choose** for
  slow page work. → [Running your own JavaScript](#running-your-own-javascript-against-elements-you-already-found)

**Read the page**
- Accessibility snapshots that stay **lean by default**, with a full mode and a write-to-file mode for
  pages that would otherwise fill the context window. An icon-only button still gets a name — its
  tooltip, its image's alt text or its `#id` — so two of them can be told apart.
  → [Snapshots](#snapshots-lean-full-or-to-a-file)
- Clean text or Markdown extraction, raw HTML, and a `find` that returns just the elements you asked
  for instead of a whole tree — the link that says "Sign in", not the page wrapped around it, with
  the link's address, a date's `datetime` or a `<meta>` tag's value on the same line.
  → [Reading a page without a snapshot](#reading-a-page-without-a-snapshot)
- **Element refs survive a re-render**, and recover themselves once if the page swapped the element
  out underneath you. → [Element refs survive a re-render](#element-refs-survive-a-re-render)
- Reads reach **inside iframes, including cross-origin ones**, with empty frames dropped and a cap so
  an ad-heavy page stays readable. → [Frames](#frames-including-cross-origin-ones)
- Ask a page for the **actions it declares about itself**, and call one directly instead of hunting
  for the controls. Almost no site declares any yet, so the honest answer is usually "none".
  → [Tools the page declares about itself](#tools-the-page-declares-about-itself)

**See what went wrong**
- Console logs, **uncaught errors with their stacks**, and service-worker lifecycle in one place.
- A **browser issues feed** for the problems that produce no console error at all: content blocked by
  a security policy, deprecated APIs, browser interventions, and failed or 4xx/5xx requests. This is
  usually the answer when something silently did nothing.
- Network request list, and the **response body** for any single request, addressable when the same
  URL was fetched more than once.
- Both logs **survive the browser shutting the extension down** to save memory, and carry over the
  previous pages so a redirect can still be debugged. → [Log durability](#log-durability)
- Both lists are **paged, newest first**, so a chatty page cannot spend your whole context in one
  call, and a footer names the exact call for the page before it.
  → [Paged logs](#the-console-and-network-lists-are-paged-newest-first)
- A short **footer** on each action telling you how many new console errors and browser issues that
  action caused. → [Console-error and issue footers](#console-error-and-issue-footers)
- An **accessibility audit** of the page you are on, grouped worst-first and mapped back to the refs
  you can act on. It catches about a third of real barriers, and says so every time.
  → [Accessibility: a floor, not a pass](#accessibility-a-floor-not-a-pass)
- Failures carry a **typed code and the tool that fixes them**.
  → [Errors name the next step](#errors-name-the-next-step-not-just-the-problem)
- A result says **which of five things happened** — refused, done, partly done, failed, or *nobody
  knows* — instead of one yes/no flag covering all of them. A form that filled two of three fields
  says so, and an action whose reply was lost says it **may already have happened** rather than
  inviting you to do it twice.
  → [Five outcomes, not two](#five-outcomes-not-two)
- When the connection is down, `browser_status` says **whether it is coming back** — retrying, waiting
  for a browser, or stopped for good — instead of one line covering all three.
  → [`browser_status` says whether it is coming back](#browser_status-says-whether-it-is-coming-back)

**Measure speed**
- Record a performance trace and get **Core Web Vitals** — LCP, FCP, CLS, INP — rated against Google's
  thresholds, plus the long tasks that blocked the main thread. One call profiles a whole page load.
  A page Chrome is not drawing is refused at once rather than recorded for nothing.
  → [A hidden page is refused, not measured](#a-hidden-page-is-refused-not-measured)
- **Find out where the LCP time went**, not just how long it was: the server, discovering the image,
  downloading it, or painting it — with the cause and the fix named in a line each, and the
  render-blocking resources listed. → [Where the LCP time actually went](#where-the-lcp-time-actually-went)
- Re-analyse a saved trace later without recording again.
- **Watch the JS heap** over a window and get the trend, with no debugger and no banner.
  → [Memory: is the page leaking?](#memory-is-the-page-leaking)
- Ask what **real visitors** experience, from Google's public field data, rather than just this
  machine. → [Performance](#performance-this-machine-and-what-real-visitors-get)

**Capture**
- Screenshots of the viewport, the **full scrollable page**, or **one element**, as PNG/JPEG/WebP, and
  straight to a file so the image never costs you a context window.
  → [Screenshots](#screenshots-that-dont-cost-a-context-window)
- A **strip of stills** on a timer, to show a person what happened instead of describing it. Stills,
  not video. → [A strip of stills](#a-strip-of-stills-for-showing-a-person-what-happened)
- An inline screenshot is **held under 1536 px wide**, so a 2K or 4K display does not quietly cost
  three times the context for the same picture. → [The size ceiling](#the-size-ceiling-on-inline-screenshots)

**Pretend to be somewhere or something else**
- Fake a **location**, a user agent, extra headers, or a colour scheme.
- Emulate a **phone viewport with touch**, a throttled network, or a slow CPU.
  → [Emulation](#emulation-location-headers-and-the-responsive-testing-set)
- Run your own script **before the page's own code**, to stub a clock or mock a fetch.
  → [Reload, and the two options that need the debugger](#reload-and-the-two-options-that-need-the-debugger)

**Manage state**
- Cookies, localStorage and sessionStorage, downloads (with their **path on disk**, and an option to
  wait for a transfer to finish), and tabs.
- **Stored values come back hidden by default** — an agent reading cookies, storage or a captured
  request's headers gets the names, not your session tokens, until it explicitly asks for them.
  → [Cookie, storage and header values are hidden by default](#cookie-storage-and-header-values-are-hidden-by-default)

**Work alongside you, and alongside other agents**
- **The agent works in its own tab, never yours.** It opens one in the background on first use and
  leaves the tab you are reading completely alone. → [The agent's own tab](#the-agents-own-tab)
- **That holds through a disconnect too.** If the browser drops mid-action, the automatic retry goes
  back to the same browser and the same tab, or refuses — it never falls through to the tab you are
  looking at. → [A retry never changes browser or tab](#a-retry-never-changes-browser-or-tab)
- **The connection repairs itself.** Lose the relay, or start up before it is ready, and the server
  keeps dialling back with a growing delay instead of sitting disconnected until you act.
  → [The link to the relay repairs itself](#the-link-to-the-relay-repairs-itself)
- **Nothing steals your focus** except the one tool whose job is to show you something.
  → [What can take your focus](#what-can-take-your-focus)
- **"Show me" works on a minimised browser.** Switching to a tab brings the window back and says
  whether the page is really on screen. → [Switching restores a minimised window](#switching-restores-a-minimised-window)
- **A clean, logged-out session on demand**, in a private window, for checking what a first-time
  visitor sees without logging out of anything.
  → [A clean, logged-out session on demand](#a-clean-logged-out-session-on-demand)
- **Per-tab ownership**, so two editors can drive two tabs of the same browser at once, with a named
  handoff when they want the same one.
  → [Sharing a browser with another agent](#sharing-a-browser-with-another-agent)
- One shared relay across every IDE, and a **terminal CLI** with `--json` for scripting.
  → [Terminal CLI](#terminal-cli)
- **Tells you when your copy is out of date** — one line on startup, at most one registry
  lookup a day, and an env var that stops it entirely.
  → [Finding out your copy is out of date](#finding-out-your-copy-is-out-of-date)

**Keep it safe**
- A **file-path sandbox** on every write, and a way to name your own folders when your editor does
  not. → [File-path sandbox](#file-path-sandbox)
- **Certificate checking is never switched off.** The one switch that claimed to do it never worked
  on any build and was removed; the section names the two routes that do.
  → [Loading a site with a bad certificate](#loading-a-site-with-a-bad-certificate)
- Only **http(s) pages** can be navigated to or opened in a new tab — a `javascript:`, `file:` or
  `chrome://` URL is refused by name. → [Where a navigation may go](#where-a-navigation-may-go)
- The local socket **only accepts the extension**, and hangs up on a peer that floods it or sends
  nonsense. → [What can reach the local socket](#what-can-reach-the-local-socket)
- The optional shared secret is **never sent over the socket**; both ends sign a challenge with it
  instead. → [Driving a browser on another machine](#driving-a-browser-on-another-machine)
- **The server leaves when your editor does**, so a closed window never strands a phantom agent in
  the roster. → [The server leaves when your editor does](#the-server-leaves-when-your-editor-does)
- **Allow / deny lists of sites** the agent may touch, enforced at the network layer as well as the
  tool layer, plus a global read-only mode.
  → [Which sites the agent may touch](#which-sites-the-agent-may-touch)
- A switch that lets the agent **click and read a logged-in session but never run code you did not
  write**. → [Forbidding JavaScript the agent wrote](#forbidding-javascript-the-agent-wrote)
- An **audit log** of every call with its target, with secrets recorded as a length and never a value.
  → [What the agent did](#what-the-agent-did-the-action-audit-log)
- **Fewer tools on demand** — serve a `core` or `slim` profile so the schemas cost less of every
  request. → [Configuration](#configuration)

**Reach further**
- Drive a browser **on another machine**, with a mandatory token off loopback.
  → [Driving a browser on another machine](#driving-a-browser-on-another-machine)
- Set a **proxy** for the whole browser. → [Proxy control](#proxy-control-whole-browser)

## Architecture

AutomateBrowser uses a **singleton relay** model. One lightweight relay process owns the WebSocket
port; each IDE's MCP server connects to it as a *controller*, and each browser extension connects as
a *browser*. The relay routes tool calls between them and enforces one-driver-**per-tab** leases — so two agents can
drive two different tabs of one browser at once.

```
   IDE 1 (Claude Code)          IDE 2 (Cursor)            IDE 3 (VS Code)
   node dist/index.js           node dist/index.js        node dist/index.js
      (controller)                 (controller)              (controller)
          \                            |                          /
           \                           |                         /
            +-----------------> 127.0.0.1:9009 <----------------+
                            Relay  (dist/relay.js)
                                       |
                +----------------------+----------------------+
                |                      |                      |
            Chrome ext             Edge ext              Brave ext
           (your tab)             (your tab)            (your tab)
```

- **Relay** (`dist/relay.js`) — a single long-lived WebSocket host bound to the lowest free port in
  `9009–9013`. Spawned on demand, idle-exits ~5 min after the last peer leaves. It speaks the browser
  wire protocol byte-for-byte (the extension can't tell it apart from a direct host) and holds the
  live browser registry.
- **Controller** (`dist/index.js`) — the MCP server an IDE runs. It does **not** bind a port; it dials
  the relay, registers with a human name, and forwards resolved tool calls. Any number of controllers
  can run at once and share the same browsers.
- **Browser** (the extension) — connects on startup (no "Connect" button), races ports `9009–9013`,
  caches the last-good port, and executes commands in your tab.

> **Soft claims (per tab):** the first action on a tab auto-claims *that tab* for 60 s (renewed on every
> action), so two agents can drive two different tabs of one browser concurrently. With no explicit
> `browser_select_tab`, a drive defaults to the browser's **focused tab** (not the whole browser), so two
> agents working on two different tabs coexist automatically; an agent keeps its own tab instead of
> following your focus onto a tab another agent drives. (A whole-browser lease is taken only as a last
> resort when no tab id is known, e.g. a `chrome://` active tab.) An agent targeting a tab (or browser)
> another agent holds is politely refused **by name** and can take over with `browser_force_claim`. Claims
> free on idle, on `browser_release_client`, or on disconnect.

## Repository layout

```
AutomateBrowser/
├── src/                          # MCP server — source of truth
│   ├── index.ts                  # stdio MCP entry; composes the 46 tools
│   ├── cli.ts                    # `automate-browser` terminal entry (same tools, one shot)
│   ├── server.ts                 # MCP Server + ListTools/CallTool handlers
│   ├── context.ts                # Relay-backed facade tools call into
│   ├── relay-link.ts             # Controller <-> relay socket
│   ├── relay-ensure.ts           # Discover/spawn the relay
│   ├── relay/                    # The relay host (index, relay, control, browsers, ...)
│   ├── tools/                    # The 46 MCP tools (snapshot, content, forms, tabs, ...)
│   └── vendor/                   # Vendored former-monorepo deps (config, messaging, types)
├── Chrome-extension/             # MV3 browser extension (WXT) — source of truth
│   ├── wxt.config.ts             # Manifest config + permissions
│   ├── entrypoints/              # background service worker, content script, popup
│   ├── lib/                      # connection, tab targeting, identity, automation engine
│   └── .output/chrome-mv3/       # BUILD OUTPUT — load THIS folder unpacked
├── dist/                         # Built bundle (index.js + relay.js + cli.js)
├── scripts/connection-smoke.cjs  # Connection smoke test
├── server.json                   # Distribution manifests — MCP registry,
├── gemini-extension.json         #   Gemini CLI, and the Agent Plugins pair.
├── plugin.json                   #   All version-gated against package.json
├── mcp.json                      #   by verify:release and by npm test
└── skills/automate-browser/     # The agent skill shipped with the package
```

## Quick start

**Two halves, and only one of them is a one-liner.** The *server* installs from npm. The
*extension* still has to be built and side-loaded, because it is not on the Chrome or Edge stores
yet — that is the honest state of it, not a step you can skip.

### 1. Install the server

**Claude Code** — one install, and it brings the `automate-browser` skill with it:

```bash
/plugin marketplace add farazpawle/automatebrowser
/plugin install automate-browser@automatebrowser
```

> Already have a hand-written `automatebrowser` entry? **Remove it first** — the plugin registers
> the server itself, and two entries in one client means two controllers and duplicate tools.

**Claude Desktop** — download
[`automatebrowser.mcpb`](https://github.com/farazpawle/automatebrowser/releases/latest/download/automatebrowser.mcpb)
(always the latest release; also on the [website](https://farazpawle.github.io/automatebrowser/#download))
and open it, or drag it onto **Settings → Extensions**. The bundle carries its own dependencies, so
nothing else installs first. It is the server only: the skill is the separate
`automate-browser-skill.zip` on the same release (see [Skills that ship with it](#skills-that-ship-with-it)).

**Any other editor** — register the published package as a stdio server. The command it runs is:

```bash
npx -y --package @automatebrowser/mcp mcp-server-automatebrowser
```

`--package` is not optional: the package ships **two** bins and neither is named `mcp`, so a bare
`npx @automatebrowser/mcp` cannot choose one and fails in a non-TTY MCP client. Claude Code will
write the entry for you — `claude mcp add automatebrowser -- npx -y --package @automatebrowser/mcp
mcp-server-automatebrowser` — while other clients want it as JSON: step 3 has the shape.

Neither route gives you a browser yet. That is step 2.

### 2. Build and load the browser extension

```bash
cd Chrome-extension
npm install
npm run build        # WXT build -> Chrome-extension/.output/chrome-mv3/
```

Then in Chrome or Edge (v137+):

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the build output folder:
   `Chrome-extension/.output/chrome-mv3/`

A card titled **"AutomateBrowser"** appears and connects automatically — no button to press. Chrome
gives an unpacked extension a **random id per profile**, so yours will not match anyone else's and
will change if you remove and re-add it; read it off the card when you need it. Click the
toolbar icon (or **Alt+J**) to open the popup, where you can pin a specific tab, set an optional
label, see the live connection status, and see **every agent connected to the server** — each listed
by name and tagged with the tab it's driving (or *idle* when it holds no active tab). The list is the
full roster, so a connected agent stays visible even between actions (it doesn't vanish when its lease
lapses), and you can tell at a glance that Claude Code, Codex, and Copilot are all connected — and who
is working in which tab.

> Point **Load unpacked** at `.output/chrome-mv3/` — **not** at the `Chrome-extension/` source root.
> Chrome can only load the compiled output.

> **Updating from an earlier build re-prompts you.** This release adds two permissions —
> `downloads` (so `browser_downloads` can report a file's final path) and `declarativeNetRequest`
> (so a denied origin is blocked at the network layer, not only at the tool). Chrome disables an
> extension until new permissions are approved, so re-enable it once after updating. Both ship
> together on purpose: one re-approval, not two.

### 3. Build from source — only if you are changing the server

Step 1 already gave you a working server. This is the path for developing against your own
checkout, and for running several editors off one build rather than off the registry.

```bash
# from the repo root
npm install
npm run build        # tsup -> dist/index.js (server) + dist/relay.js (relay) + dist/cli.js (terminal client)
```

The server vendors its former monorepo dependencies under [src/vendor/](src/vendor/), so it builds
standalone — no external workspace required.

**Then point your client at that build** (`node dist/index.js`, absolute path) instead of at npx. If
several editors drive one browser they must all launch the *same* build: a published npx entry in one
editor and a local build in another puts two different builds on one relay. Example (Claude Code / Claude
Desktop / Cursor `mcpServers`, VS Code uses `servers`); on Windows, escape the backslashes:

```json
{
  "mcpServers": {
    "automatebrowser": {
      "command": "node",
      "args": ["C:\\path\\to\\AutomateBrowser\\dist\\index.js"],
      "type": "stdio",
      "env": {
        "AUTOMATE_BROWSER_CLIENT_NAME": "Claude"
      }
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add automatebrowser -- node "/absolute/path/to/AutomateBrowser/dist/index.js"
```

Restart / reconnect the client after editing config. You don't configure a port — controllers
auto-discover the relay.

#### Installing it from a manifest instead

Five manifests in this repository describe the same server to five listing formats, so a client that
speaks one of them can install it without you writing any JSON:

| Manifest | Platform | How it is installed |
|---|---|---|
| `server.json` | The MCP registry | Published with the package; clients that browse the registry find it there |
| `gemini-extension.json` | Gemini CLI | `gemini extensions install https://github.com/farazpawle/automatebrowser` |
| `plugin.json` + `mcp.json` | Any client implementing [Agent Plugins 1.0.0](https://agent-plugins.org/) | Point the client at this repository; it reads both files plus `skills/` from the root |
| `.claude-plugin/plugin.json` + `marketplace.json` | Claude Code | `/plugin marketplace add` — see [Skills that ship with it](#skills-that-ship-with-it) |
| `mcpb/manifest.json` | Claude Desktop | Not installed from the repository: it is packed with `dist/` and production `node_modules` into the `.mcpb` attached to each [release](https://github.com/farazpawle/automatebrowser/releases) |

**The first four work as of `1.0.0`** (published 2026-09-19). Three of them launch
`npx @automatebrowser/mcp@<version>`, which resolved to nothing until that day and now resolves to this
build — a **controller** that joins the relay exactly like a local `node dist/index.js` entry. The old
warning that npx would partition the relay described a self-hosting build that this package has never
served, and it is gone.

**Only one route gives an agent both halves.** The MCP registry entry and a hand-written config
install the *tools* only — `skills/` is inside the published package, but an MCP client does not read
skills out of a dependency; only an installed **plugin** is searched. The Claude plugin pair and any
Agent Plugins 1.0.0 client are the exception: each registers the server *and* carries the skill, so one
install is the whole thing. See [Skills that ship with it](#skills-that-ship-with-it).

All six version claims across those files are gated: `npm run verify:release` and `npm test` both fail
if any one of them disagrees with `package.json`, so a listing cannot quietly advertise a version that
was never released.

## Tools

All 46 tools are prefixed `browser_`. Interactions are **lean by default** — they return a short
confirmation, not a snapshot. Call `browser_snapshot` to get element `ref`s, then pass `{ element, ref }`
to the interaction tools (a raw CSS selector is not accepted).

The navigating and interacting tools also take an optional **`timeout`** (milliseconds) so an agent can
give up early instead of waiting out the server default; `0` or omitting it uses the default. Calls from
one client run **one at a time, in the order they were issued**, so a click can never overtake the
navigation that was meant to precede it. Different clients are not serialized against each other — that
is what the per-tab claim is for.

<!-- AUTO-GENERATED:tools START — do not edit by hand; run `npm run docs:generate` -->

**Tool profiles** — `full` (46) · `core` (19) · `slim` (7). Set `AUTOMATE_BROWSER_TOOLS` to a profile name or a comma-separated category list to serve fewer schemas; `browser_status`, `browser_list_clients` and `browser_select_client` are always served.

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

## Terminal CLI

`automate-browser` runs any one of the tools above from a shell. It joins the relay exactly like an
IDE does, so it drives the **same** browser your editors are driving and appears in their
`browser_status` peer list as `cli`.

```bash
npx -p @automatebrowser/mcp automate-browser      # or `npm link`, from a checkout
                                                  # (-p is required: the package ships two bins, so a
                                                  #  bare `npx @automatebrowser/mcp` cannot pick one)

automate-browser status                           # who is connected, which relay, which browsers
automate-browser navigate https://example.com
automate-browser read-page --args '{"format":"markdown"}'
automate-browser eval 'document.title'
automate-browser screenshot                       # writes a PNG to the temp dir and prints the path
automate-browser tabs --json                      # machine-readable, for scripting
```

Aliases cover the common cases (`navigate`, `read-page`, `snapshot`, `screenshot`, `status`, `eval`,
`tabs`); anything else is called by tool name, with arguments as JSON:

```bash
automate-browser browser_click --args '{"element":"Sign in button","ref":"e7k2f"}'
```

The tool name may be given with or without the `browser_` prefix. `--json` prints the whole result
(including `structuredContent`) instead of the human-readable text. Exit status is `0` on success and
`1` on any failure, so it composes in scripts. A failure prints the **same text an agent gets** — the
`CODE: message` line and the `Recover: call <tool>` line — on stderr; it used to print the bare
sentence, so the terminal was the one caller that never saw the code. Unlike the MCP server the CLI always offers every tool,
regardless of `AUTOMATE_BROWSER_TOOLS` — profiles exist to save an agent's tokens, and a terminal
pays none.

## Configuration

All settings are environment variables on the **server** side (set them in the MCP client's `env`):

<!-- AUTO-GENERATED:config START — do not edit by hand; run `npm run docs:generate` -->

| Variable | Purpose | Default |
|----------|---------|---------|
| `AUTOMATE_BROWSER_CLIENT_NAME` | Human name for this IDE in the relay roster | `mcp-<pid>` (CLI: `cli`) |
| `AUTOMATE_BROWSER_TOKEN` | Optional auth token (set the same value in the extension popup) | unset |
| `AUTOMATE_BROWSER_TOOLS` | Tool profile (`full`, `core`, `slim`) or a comma-separated category list | `full` |
| `AUTOMATE_BROWSER_CONNECT_WAIT_MS` | How long a tool waits for a browser to appear | `30000` |
| `AUTOMATE_BROWSER_LEASE_TTL_MS` | Soft-claim lease duration | `60000` |
| `AUTOMATE_BROWSER_INSTANCE_ID` | Identity used to replace this agent's own previous roster entry when it restarts | derived from parent process + folder |
| `AUTOMATE_BROWSER_CONTROLLER_STALE_MS` | Drop an agent that has sent nothing for this long | `45000` |
| `AUTOMATE_BROWSER_WS_PORT_RANGE` | Port scan range (e.g. `9109-9116` to isolate) | `9009-9013` |
| `AUTOMATE_BROWSER_RELAY_IDLE_MS` | Idle time before the relay exits | `300000` |
| `AUTOMATE_BROWSER_RELAY_HOST` | Bind the relay past loopback so a browser on **another machine** can connect. Refuses to start without `AUTOMATE_BROWSER_TOKEN` | `127.0.0.1` |
| `AUTOMATE_BROWSER_RELAY_FOREGROUND` | `1` also tees the relay's log to stderr instead of the file only | unset |
| `AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION` | Bundle a snapshot after every interaction | unset |
| `AUTOMATE_BROWSER_STRUCTURED` | `1` also sends each result's `structuredContent` and lists output schemas, for scripts. Leave off for agents: Claude Code then shows only that data and hides the written reply | unset (written reply only) |
| `AUTOMATE_BROWSER_DELTA_FOOTER` | `off` disables the console-error footer below | on |
| `AUTOMATE_BROWSER_DELTA_FOOTER_MS` | Hard ceiling on the footer's console probe | `2000` |
| `AUTOMATE_BROWSER_NAV_CONFIRM_MS` | How long a navigation that reported no movement is re-checked before it is called a failure | `2000` |
| `AUTOMATE_BROWSER_SCREENSHOT_MAX_WIDTH` | Widest an **inline** screenshot may come back. A `filePath` capture is never downscaled; `0` = off | `1536` |
| `AUTOMATE_BROWSER_SCREENSHOT_MAX_HEIGHT` | Tallest an **inline** screenshot may come back, aspect ratio preserved; `0` = off | `4096` |
| `AUTOMATE_BROWSER_ACTIONABILITY` | `off` disables the pre-action checks and post-action settle below | on |
| `AUTOMATE_BROWSER_WS_MAX_PAYLOAD_BYTES` | Max WebSocket frame size. A whole Chrome trace is never under 1 MiB, and an oversized frame closes the socket rather than truncating | `67108864` (64 MiB) |
| `AUTOMATE_BROWSER_WS_RATE_MAX` | Frames one socket may send per window before it is closed | `120` |
| `AUTOMATE_BROWSER_WS_RATE_WINDOW_MS` | The window that ceiling is counted over | `1000` |
| `AUTOMATE_BROWSER_EXTENSION_ORIGINS` | Comma-separated browser-extension origins allowed to open a socket | any `chrome-extension://` origin |
| `AUTOMATE_BROWSER_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. Diagnostics go to stderr, never stdout | `info` |
| `AUTOMATE_BROWSER_WORKSPACE` | Extra folders the file-path sandbox accepts, `;`-separated on Windows and `:`-separated elsewhere. Adds to the roots your client sends; never replaces them | unset (client roots, or the working directory when it sends none) |
| `AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS` | `1` disables the file-path sandbox below | unset |
| `AUTOMATE_BROWSER_ALLOW_ORIGINS` | Comma-separated origin patterns; when set, **only** these may be driven | unset (unrestricted) |
| `AUTOMATE_BROWSER_DENY_ORIGINS` | Origins that may never be driven, also blocked at the network layer | unset |
| `AUTOMATE_BROWSER_SENSITIVE_ORIGINS` | Origins that stay readable but can never be acted on | unset |
| `AUTOMATE_BROWSER_READ_ONLY` | `1` refuses every page-changing tool, everywhere | unset |
| `AUTOMATE_BROWSER_NO_EVAL` | `1` refuses every tool that runs JavaScript you wrote — `browser_eval` and `browser_navigate`'s `initScript` | unset |
| `AUTOMATE_BROWSER_AUDIT` | `off` stops the action audit log below | on |
| `AUTOMATE_BROWSER_AUDIT_FILE` | Where the audit trail is written | `~/.automate-browser/automate-browser-audit.log` |
| `AUTOMATE_BROWSER_NO_UPDATE_CHECK` | Any value stops the daily check for a newer release below | unset (check runs) |
| `AUTOMATE_BROWSER_CRUX_KEY` | Google Chrome UX Report API key; `browser_perf_field_data` is inert without it | unset |

<!-- AUTO-GENERATED:config END -->

### Console-error and issue footers

After a page-changing tool (click, type, navigate, …) the server counts what went wrong since the
last check and, when there is anything, appends a line for each kind:

```
⚠ 2 new console errors since this action — call browser_get_console_logs for details.
⚠ 1 new browser issue since this action (blocked content or failed requests) — call browser_issues for details.
```

The two are deliberately **separate lines**: a blocked script or a failed request produces no console
error at all, so counting them as one would point you at the tool that cannot show them.

Read-only tools never get it, and the count starts from the moment the server launched, so errors
the page logged before the session are not blamed on the first action. The probe costs one extra
round trip (measured at ~2 ms against a real browser) and is capped by
`AUTOMATE_BROWSER_DELTA_FOOTER_MS`; if it fails for any reason it is silently dropped rather than
failing the action. A navigation replaces the page's log buffer, so errors from the previous document
are not counted late — read them with `browser_get_console_logs { includePreserved: true }` (see **Log
durability** below). The issue count covers the current page only.

### Asking for the fresh state in the same reply

The footer above says *that* something broke. `include` is the half that shows *what*: pass
`include: "snapshot"`, `"console"`, `"network"` (or several, comma-separated) to `browser_click`,
`browser_type` or `browser_navigate` and each arrives as its own labelled block in the same reply —
no second and third round-trip that an agent usually doesn't make. A section that fails to load is a
footnote, never a failure of the click that worked — each one is fetched and labelled independently,
so a console read that times out does not cancel the network block beside it. Omit it and nothing
changes.

**A section name it does not recognise is refused before the action runs.** `include: "consoel"`
returns an error and the click never happens, so retrying the corrected call clicks once, not twice.
That ordering is the whole point: an option that only shapes the reply is checked while checking it
is still free.

It is on those three tools only. On hover, drag, scroll or a key press the answer is almost always
"nothing worth a payload", and the param would be paid for on every request forever.

**`includeSnapshot` is the older, blunter version of the same idea, and its default is not the same
everywhere.** A navigation returns a **full snapshot by default**, because arriving on a new page
invalidates every element reference you were holding. Clicks, typing, hovers, drags and option
selects return a **one-line confirmation** instead. Pass `includeSnapshot: true` to add one to an
interaction, or `includeSnapshot: false` to strip it from a navigation you only wanted to perform —
that is the single cheapest saving available on a page-heavy task. Setting
`AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION` turns it on everywhere at once, which is the pre-lean
behaviour and costs accordingly.

### Uncaught errors keep their stacks

An error the page throws is reported with the trail back to the throw site, in its own section below
the ordinary console lines, rather than as a bare "something went wrong" string. The plain log stays
chronological and unchanged; the stacks are kept out of it so it stays readable.

### Service workers show up in the console

A page's service worker is invisible in ordinary logs, so a broken one looks like the site simply not
working. `browser_get_console_logs` folds worker **lifecycle** into the same log, tagged `[sw]`: the
registration attempt and whether it succeeded, state changes (`installing` → `activated` →
`redundant`), `controllerchange`, and messages the worker posts to the page. A FAILED registration is
reported as an error; a routine update is not, so a healthy worker never triggers the console-error
footer below.

It attaches to a worker that was **already registered before the page loaded**, which is the common
case — otherwise every second visit would look worker-free.

**The honest limit:** a `console.log` written *inside* the worker is not included. No debugger-free
API exposes it, and the tool's own description says so rather than letting you assume otherwise.

### The console and network lists are paged, newest first

A busy single-page app produces hundreds of console lines and hundreds of requests, and both lists
used to arrive whole. `browser_get_console_logs` and `browser_network_requests` now return **50
entries per call**. On `browser_network_requests`, `limit` sets that page size; on
`browser_get_console_logs` it is fixed.

**Page 1 is the newest, and `page: 2` goes further back in time**, not forward. That direction is
deliberate: both tools already returned "the most recent N", so a call that does not mention `page`
returns what it always returned.

When more remains, a footer says which page you are on, how many entries exist in total, and the
exact next call:

```
— page 1/4 of 173 requests, newest page first. Older: browser_network_requests {"page":2}
```

Ask for a page past the end and you get **page 1 with a line saying the page you asked for does not
exist** — never an error, and never an empty result you have to interpret.

**The honest limits.** Everything that fits on one page prints no footer at all, so a quiet page looks
exactly as it did before. Thrown-error stacks are printed for **the page you asked for**, so an error
further back needs its page fetched. And the network log is the extension's ring buffer of the **1000
most recent** requests for the tab; paging cannot reach past what the browser still holds.

The default network page was **100** before this change and is now **50**.

### Snapshots: lean, full, or to a file

`browser_snapshot` returns the lean tree by default. Pass `verbose: true` for the full tree — all text
and structure, not just interactive elements — or `filePath` to write it out and get a summary back,
for pages whose snapshot would otherwise fill the context window. **Element refs are identical in
both modes**, so you can switch mid-task and keep using refs you already hold. `filePath` goes through
the same sandbox as every other write path.

**A control with no text still gets a name.** `<button id="buttonGenerate"><i class="fa fa-cog"></i>
</button>` used to print as a bare `- button [ref=…]`, indistinguishable from the icon button beside
it. A control with no name of its own now falls back to its `title`, then the `alt` of an image inside
it, then its `#id`: `- button "#buttonGenerate" [ref=…]`. Refs do not change — they never read the
name. `browser_find` names such a control from its image's `alt` too, so `{ text: "Settings" }`
reaches a cog button whose image says "Settings"; its `id` and `title` already print as attributes.
The limits: an `#id` names the element, not what it does — `#btn-3` tells you nothing, so look before
you click; a control with no title, image alt or id still prints unnamed; and an icon drawn by CSS
alone (a font glyph or background image) carries no text anywhere to borrow.

### Frames, including cross-origin ones

Ad slots, embedded checkouts and payment fields usually live in an `<iframe>` from another origin, and
page JavaScript cannot reach across that boundary. Snapshots do: a cross-origin frame comes back as
its own `- frame <url>` block with working refs, and those refs can be handed straight back to
`browser_click` or `browser_type` — frame identity is resolved inside the extension, so an agent never
has to think about it.

**Every frame is its own block, same-origin ones included.** In the page tree an `<iframe>` appears as
a bare `- iframe` marker and the snapshot does not descend into it; its contents come back below,
under their own `- frame <url>` heading with `fN:` refs. A `srcdoc` frame, which has no url of its
own, is reached the same way.

Same-origin frames used to be printed inline instead, with unprefixed refs. That read more naturally
and was quietly wrong: such a frame was walked **twice** — once by its parent and once as itself —
and the two passes tag the same element with two different refs, so the one printed could be the one
the page no longer carried. It showed up plainly on a frame nested inside a cross-origin frame, whose
fields were listed twice under two spellings, only one of which resolved. Walking each document
exactly once removes the whole class.

Two rules keep a frame-heavy page readable, since a real ad page can carry dozens:

- **Frames with nothing interactive in them are dropped**, so empty slots never reach the agent.
- **At most 10 frames** are included, and when the cap bites the snapshot says so rather than
  silently truncating. Same-origin frames now count toward that ten, where before they were inline
  and free — the deliberate cost of the change above.

Refs are namespaced per frame, so two frames can never mint the same one.

**One call acts inside one frame.** Every ref in a single `browser_click`, `browser_hover`,
`browser_type`, `browser_select_option`, `browser_drag` or `browser_eval` has to come from the same
frame, and a ref with **no prefix means the top page** — never "whichever frame the other ref named".
A mixed pair is refused with `BAD_ARGS` *before* anything is injected, so nothing is clicked, typed,
dragged or re-tagged on the way to finding out. Dragging from one frame into another is not
supported, and the same check refuses it rather than performing half of it.

A prefix that does not parse — `f3:` with nothing after it, `fx:e1a2`, `frame3:e1a2` — is refused the
same way. It used to be looked up as a literal ref in the top page, which meant a mistyped frame
number quietly aimed the call at a different document and reported success.

### Filling a form that spans frames

`browser_fill_form` is the deliberate exception to the rule above: one call **may** mix frames, because
a real checkout puts the card number in an embedded widget and the delivery address in the page around
it, and making an agent split that into three calls would defeat the tool.

**Order is preserved exactly as you wrote it.** The batch is split into consecutive runs of one frame,
not gathered per frame — so `[top, widget, top]` is filled in that order, three injections deep. This
matters when fields depend on each other: a country select that reveals a state select that feeds a
postcode back in the top page is filled in the order a person would.

**Every address is checked before the first field is written.** A malformed prefix anywhere in the
batch refuses the whole call with nothing written, rather than being discovered on field nine with
eight already set and no way to tell how far it got.

**Results name the ref you passed.** A per-field failure reports the prefixed ref, and a frame that
cannot be reached at all fails only *its* fields — the rest of the batch still reports its own result.
`browser_clear` follows the same reference rules.

Both tools also reach a field inside a **shadow root** now, which a plain top-level lookup missed even
with a perfectly good ref.

### Checkboxes and radios take a boolean, and nothing else

A checkbox or radio field takes `"true"` or `"false"` — plus the obvious synonyms `1`/`0`, `on`/`off`,
`yes`/`no`, `checked`/`unchecked`. **Any other value is refused for those two**, as a per-field error
that names the convention, while the rest of the batch fills normally.

That refusal exists because of what the alternative did. A radio ignored the value entirely and was
always selected, so `{ value: "false" }` chose the option it had been told to leave alone, displaced
whatever the group had selected, and reported full success. Simply honouring the boolean would fix that
and open a quieter hole in its place: `{ value: "Express" }` is how a `<select>` is filled by the same
tool, and it would now silently do nothing at all. So a value that is neither true nor false is treated
as the mistake it is.

**To choose one option of a group, set that option's own ref to `"true"`** — the browser unselects its
siblings, as it does for a person. Setting a radio to `"false"` clears it and leaves the group with
nothing selected; it never promotes another option. Events follow the change: `input` and `change` fire
when the state actually changed, and not when it did not, because a radio's `onChange` handler
commonly re-selects `event.target.value` and firing it on a no-op would undo the clear you just asked
for.

### Frame limits worth knowing

Three tools cannot follow a ref into a **cross-origin** frame. Each now says the frame is the reason,
instead of reporting the ref missing — which used to send an agent back for a fresh snapshot that
handed it the very same ref. A **same-origin** frame works in all three, at any depth.

| Tool | Cross-origin frame | Same-origin frame |
|---|---|---|
| `browser_screenshot { ref }` | Refused. The capture covers the whole tab, and the frame's position in it cannot be measured from outside — cropping anyway would return a confidently wrong region. Capture the viewport instead. | Works. The rect is measured inside the frame and translated up through each parent, so the crop lands on the element |
| `browser_upload_file` | Refused. It drives one debugger session, which does not extend into another origin's frame. Use the default tools for that frame. | Works, including inside a shadow root |
| `browser_click` in advanced (debugger) mode | Refused, for the same reason. The default click path injects into the frame directly and does reach it. | Works, with the frame's offset applied so the click lands on the element rather than on whatever sits at that point in the top page |

The dividing line in every row is the same one: a same-origin frame can be measured and read from its
parent, and a cross-origin frame cannot be — by design, not by omission.

### Element refs survive a re-render

A ref is derived from the element's own identity — its tag, id, name, type, role, label and text —
not from its position in the page walk. Two consequences worth relying on:

- **The same element keeps the same ref** across snapshots of a page that has merely re-rendered, and
  adding an element no longer renumbers every ref after it.
- **`browser_find` no longer invalidates your snapshot refs.** It used to clear and renumber every
  ref on the page, so a read-only query threw away your whole map of it.

If a ref does go stale — the node was replaced, not just re-rendered — the server re-tags the page
and retries the action **once**, and says so in the result:

```
Clicked "Sign in" — note: that ref had gone stale, so the page was re-tagged and the ref
re-resolved. Take a fresh browser_snapshot before relying on other refs.
```

If it still cannot be found you get `STALE_REF` naming `browser_snapshot` as the fix, rather than a
click that lands somewhere unintended.

### Clicking something a snapshot cannot name

A canvas, a map widget, a PDF viewer and an image map have no element a snapshot can hand you a
reference to. `browser_click` therefore takes a **point** as an alternative address — `{x, y}` in
viewport coordinates instead of a reference — and reports what was actually under it, since a
coordinate click that lands on the wrong thing is otherwise silent. Give one address or the other,
never both. `dblClick` works with either.

### Running your own JavaScript, against elements you already found

`browser_eval` takes either an `expression` for a quick page-state check (`document.title`, a count, a
computed style) or a **`function` plus `args` of element refs** — so you can write
`(el) => el.getBoundingClientRect()` and pass a ref from a snapshot, instead of re-finding the element
with a selector that may not match what the snapshot saw. A `filePath` writes a large result out
rather than inlining it, and `dialogAction` answers a dialog the code itself raises instead of hanging
on it.

An `await`ed result is resolved before it is returned — a promise used to come back as an empty
object, which looked like a successful call that produced nothing.

It gives up after **8 seconds** by default. Pass `timeout` (in milliseconds, up to 120000) for slower
work: a page computation that takes 9 seconds fails without it and returns with `timeout: 15000`. The
limit: when the time runs out the reply stops waiting, but the code keeps running in the page — there
is no way to cancel a script already started there.

### What this server costs your context, measured

Two numbers, both taken on 2026-09-18 across **348 real Claude Code sessions, 89,258 model turns and
3,811 browser calls** — not estimated.

**The tool list: 9,435 tokens, on every single request.** Every MCP client re-sends every tool's name,
description and schema with every message, used or not. Multiplied out across those sessions that came
to **934 million tokens — 80% of everything this server has ever cost**, and 92 million of it was paid
by 36 sessions that never called a browser tool at all. `npm run tokens` gates the per-request number
and CI fails when it creeps.

It used to be 10,469. Two things went, neither of them a capability: the `$schema` dialect key that
`zod-to-json-schema` stamps on all 46 input and 9 output schemas and the protocol never reads (770
tokens), and three parameter descriptions that were being restated six times over — `includeSnapshot`
alone cost 29 tokens on each of six tools. Those explanations now live in the shipped skill, which an
agent reads once per **task** instead of once per **turn**.

**A screenshot: about 1,531 tokens, and it never leaves.** That was the average inline capture across
249 real ones, and an MCP result is re-read on every later turn until the session ends or is compacted
— so on a heavy browser day screenshots were **half** of this server's entire footprint. Of 445
captures, only 20 scoped themselves to one element with `ref`. If you are checking one button, pass
its `ref`; if you are checking a value, `browser_eval` or `browser_find` answer without a picture at
all.

**If your client has no tool search, use `AUTOMATE_BROWSER_TOOLS`.** Claude Code defers MCP tool
definitions until they are needed (`ENABLE_TOOL_SEARCH`, on by default), so the 9,435 is mostly not
charged there. Cursor, VS Code and Claude Desktop have no equivalent and pay it on every message —
set the variable to `core` (4,145) or a category list and pay only for what you drive. Note that
`browser_eval`, the tab tools and `browser_emulate` are **outside** `core`; a category list such as
`navigation,snapshot,content,capture,tabs` is usually the better fit for real work.

### Screenshots that don't cost a context window

A full-viewport PNG inlined into the reply is the most expensive thing this server can do to a
context window, and usually you wanted one button. `browser_screenshot` therefore takes a `ref` to
capture **just that element** (it is scrolled into view first, and cropped from the real capture at
the right device-pixel scale), `webp` alongside `png`/`jpeg`, and a `filePath` — which writes the
image and returns **the path instead of the bytes**, through the same sandbox as every other write.

Element cropping was verified on a **1.5x** display on 2026-09-02, not only at 1x: a 300x150 element
comes back **450x225**, and the crop lands on the right region as well as the right size — the scale
is derived from the capture itself (`bitmap.width / viewportWidth`) rather than read from
`devicePixelRatio`. **The one honest limit:** an element whose device size lands on a half pixel
rounds **outward** (451.5 becomes 452), so at most one pixel of surrounding page can appear at the
right and bottom edges. Rounding inward would shave the element instead, which is the worse trade for
a picture of it.

### The size ceiling on inline screenshots

A screenshot that comes back **inline** is downscaled to fit inside **1536 x 4096** device pixels,
aspect ratio preserved, before it leaves the browser. `AUTOMATE_BROWSER_SCREENSHOT_MAX_WIDTH` and
`AUTOMATE_BROWSER_SCREENSHOT_MAX_HEIGHT` change it; either set to `0` switches that half off. When it
bites, the reply says so — the size before and after — because an agent measuring coordinates off a
silently shrunk picture measures the wrong page.

Why a picture is worth less than it costs above that size: a 2K viewport capture is 2560x1440, and a
model's vision pipeline resizes it to roughly 1568 px on the long edge anyway. You pay for the pixels
and then they are thrown away. Held at 1536 wide the same capture is about **1 770 image tokens
instead of 4 900** — the same picture, 2.8x cheaper, on every single capture.

**Two ceilings rather than one, because a full page is not a viewport.** The box is applied with the
aspect ratio kept, so a matching 1536 height would take a 2545x6362 full-page capture down to **613 px
wide** — legibility traded away for nothing. At 4096 the width binds first for any page shorter than
about 6 800 device pixels, and a page taller than that is an overview whatever you do.

**The honest limit, and it is the interesting one.** This does **not** apply to a capture written to
`filePath`, which includes every frame of a strip. Measured on Edge 152, 2026-09-09, one Wikipedia
article:

| Capture | Chrome's PNG | Downscaled to 1536 wide |
|---|---|---|
| Viewport, 1080p — 1912x914 | 241 KB | png **446 KB** · jpeg60 103 KB · webp60 75 KB |
| Viewport, 2K — 2560x1440 | 332 KB | png **529 KB** · jpeg60 100 KB · webp60 74 KB |
| Full page, 2K — 2545x6362 | 1 198 KB | png **2 287 KB** |

Downscaling a screenshot and re-encoding it as PNG makes the **file bigger** — 60% bigger for a
viewport, 91% for a full page. Chrome's capture is flat colour and sharp edges, which PNG compresses
extremely well; resampling turns every edge into a gradient of unique pixels a lossless codec then has
to store in full. Only the lossy formats shrink, and they shrink hard (332 KB → 74 KB as webp). So a
capture headed for disk is left at full size: there the cost genuinely is the bytes, the ceiling would
add to them, and the detail it spends is not recoverable. If you want a small **file**, ask for
`format: "webp"` with a `quality`, which is the thing that actually works.

**`format: "webp"` works on a full page too, and until 2026-09-14 it did not.** Chrome's capture APIs
produce PNG and JPEG only, so webp is always a re-encode of a capture — the viewport path did that
re-encode, and the full-page path, which renders through the debugger, silently ignored the format and
handed back a PNG labelled `image/png`. That is why the full-page row above lists no webp figure: it
was measured while the option did nothing. Measured after the fix on a small local page, full page,
quality 60: **18 917 bytes as png against 12 380 as webp**, and the reply now says `image/webp`.

### A strip of stills, for showing a person what happened

`browser_screenshot { frames: 10, intervalMs: 150, filePath: "out/strip.png" }` captures ten stills in
a row and writes them as `strip-01.png` … `strip-10.png`, numbered so they sort in capture order. The
reply is the paths and one summary line — **never the images**, because ten pictures inline is the
most expensive thing this server could put in a reply. A strip with no `filePath` is refused for
exactly that reason. Each generated name goes through the path sandbox in its own right, not just the
one you passed.

The audience for this is the human, not the agent: hand someone a sequence of the bug instead of
describing it, or review a flow that scrolled past.

**Say the limit out loud: this is a strip of stills. No audio, no video file, no encoding.** Real video
would need `chrome.tabCapture`, which demands a user gesture on every single capture — the agent would
have to ask you to click the extension icon each time, which is not automation. That is why this is
deliberately the simple version rather than a feature waiting to be finished.

Two measured facts decide whether a strip is worth taking (Chrome 152, 2026-09-05, 10 frames at 100ms,
jpeg q60):

| The tab is | Achieved | Useful for |
|---|---|---|
| In the foreground | **~110 ms per frame**, about 9 per second | A transition, a fade, a flicker |
| In the background | **~3 900 ms per frame** | Slow changes only — a spinner that never stops, a progress bar |

The gap is not ours to close. **Chrome does not draw a tab nobody is looking at**, so every frame waits
for one to be rendered — and since the agent works in a background tab by default, that is the case you
will hit first. The reply says so when it happens, quoting both the interval you asked for and the one
it got, and names `browser_switch_tab` as the way to change it. Un-freezing the tab through the
debugger was tried and made no difference: 3.76 s versus 3.89 s, which is noise.

Every frame is rendered through the debugger, foreground or not, so Chrome shows its "being debugged"
banner for the length of the strip. That is deliberate: the cheap capture path Chrome offers extensions
is **rate-limited to 2 calls per second** and rejects the third outright, so a strip taken that way
would fail on frame three. The debugger attaches once and detaches at the end, not per frame.

### Capturing a tab Chrome has stopped drawing

Screenshotting a background tab is a headline feature here — it is how an agent checks its work
without taking your screen. The honest limit is that Chrome **backgrounds the renderer of a tab
nobody is looking at and stops producing frames**, so the capture can wait on a frame that never
arrives. Measured on 2026-09-01, before this was handled: **3 stalls in 8 captures**, each of which
succeeded when simply asked again. Re-measured on 2026-09-02 with the handling in place: **0 stalls
in 11 captures** — eight back-to-back, then two more after 75-second idle spells, because
back-to-back captures keep the renderer warm and never exercise the throttled case. That proves no
stall reached the caller, which is the promise; a stall absorbed by the internal retry is invisible
from outside by design.

Neither remedy usually recommended for this is open to us — bringing the tab to the front steals
your focus, and the `--disable-renderer-backgrounding` family are Chrome launch flags an extension
cannot set. So each capture is now bounded at **8 seconds**; on a stall the page is nudged out of
its backgrounded state and the capture is tried once more. If both attempts stall you get
`CAPTURE_STALLED`, **flagged retryable** — a screenshot has no side effect, so re-issuing it is a
genuine retry rather than a repeated action, which is why it is the one timeout here treated that
way. `browser_switch_tab` always captures, at the cost of your focus.

Before this, a stall settled nothing for up to 22 seconds and then surfaced as a bare "Socket message
timeout" that named no cause — the extension had no ceiling of its own, so the failure was always
reported by whichever caller gave up first.

### Emulation: location, headers, and the responsive-testing set

`browser_emulate` fakes a **location** and adds **extra request headers** with no debugger involved.
The rest — **dark mode**, a **device viewport** (this is where responsive testing lives), a faithful
**user agent**, and **network / CPU throttling** — needs `browser_advanced_mode`, because no
debugger-free API can do them: a JS override of `userAgent` only fools reads, and
`prefers-color-scheme` cannot be overridden from page JS at all. Name options in `clear` to switch
them off, or call with no arguments to see what is in force.

Three honest limits. The faked location only affects requests the page makes **after** the call — a
site that asks while it is still loading has already asked, and the answer for that case is
`browser_navigate {initScript}`. While CPU or network throttling is on, every internal wait is
scaled to match, so a throttled page is not mistaken for a broken one.

And **a page loaded before you emulated a phone still feature-detects as a desktop.** Whether
`ontouchstart` exists is decided when the document is created, so a page already open keeps the
answer it was born with, however convincingly the viewport now says otherwise. The touch-point count
updates immediately, which is what makes this confusing rather than obvious. Reload after emulating,
and the result of any call that switches touch on says so.

### Actionability: interactions wait for the element to be ready

Before a click, type, select or drag, the element must be **visible**, **enabled**, **stable** (its
box unchanged across an animation frame) and — for pointer actions — **hit-testable** (nothing is
covering it). A failing check is waited out for up to a second; after that the action is refused,
naming the check and what was in the way:

```
Element "e7k2f" is not actionable: failed the "hit-testable" check after 1000ms.
It is covered by <div#cookie-banner> "We use cookies".
```

Hit-testing applies to `browser_click` and `browser_drag` only — `browser_type` and
`browser_select_option` go through focus, so something covering the element cannot misdirect them.

After the action the page is given ~100 ms of mutation-free time (capped at 1 s) before the tool
returns, so the snapshot you take next is of the settled DOM rather than a page mid-re-render. Set
`AUTOMATE_BROWSER_ACTIONABILITY=off` to skip both the checks and the settle.

**What it costs:** ~110 ms per click. Measured on a real Chrome (2026-08-30), 10 clicks on an
ordinary page: **450 ms** per click with the checks on, **341 ms** with them off. The default stays
on — a fast click on the wrong element is the fault this exists to prevent.

Two paths are **not** covered yet: `browser_fill_form` / `browser_clear`, and `browser_click` /
`browser_press_key` while advanced (debugger) mode is attached.

**The honest limit — a CSS fade never completes in the agent's background tab.** Chrome does not
advance a transition in a tab it is not drawing. The page's script sets the target opacity and the
animation simply never runs, so the element stays at its starting value and the visible check fails no
matter how long it waits. Measured 2026-09-01 mid-fade in a background tab: inline opacity `1`,
computed opacity `0`. Waiting longer cannot fix it.

This is the most likely cause of `failed the "visible" check` on something a person would plainly see
appear — a modal, a dropdown, a toast. The options are to read or act on what the transition reveals
rather than the transition itself, or `browser_switch_tab` to bring the tab forward and accept taking
the user's focus. Both fade states are pinned by `npm run test:integration`, in the background tab and
the foreground one, so neither behaviour can change unnoticed.

### Deciding when an action is finished

The settle above is the default, not the only choice. `browser_navigate`, `browser_click`,
`browser_type`, `browser_press_key`, `browser_go_back` and `browser_go_forward` take **`waitUntil`**,
which says what "finished" means for that one call:

| `waitUntil` | Returns when |
|---|---|
| `none` | immediately, without waiting for anything |
| `auto` | the DOM stops changing — the default for everything: a click, a keystroke, typing, and a navigation (after its load event) |
| `load` | the page's load event has fired, and nothing more — the fastest reply from a navigation |
| `networkidle` | after the load, the tab has had no request open for 0.5 s (gives up waiting after 5 s) |

**`settleMs`** caps that wait in milliseconds (up to 15000), and the separate **`timeout`** gives up
on the whole call. They answer different questions: `settleMs` is how long to wait for the page to go
quiet after the action worked, `timeout` is how long to wait for the action at all. Use `none` on a
click whose result you are about to poll for anyway, and `networkidle` on the one that kicks off the
fetch you actually care about.

**A navigation waits for the page to finish drawing, not just for its load event.** The load event
fires before a page that builds itself with script — YouTube, most web apps — has drawn anything, so
the snapshot a navigation returns used to show an empty shell. Now, after the load, it waits until the
page has gone **0.3 s without a change**, for at most **1.5 s**. Measured on six local test pages, a
typical navigation went from about **0.02 s to 0.34 s** — a median cost of **0.31–0.32 s** across two
runs. That 0.3 s is paid even by a page that was already still, since only a quiet spell can prove it
is. The limits: a page that never stops changing (a ticker, an animation that touches the DOM) is read
at the 1.5 s cap, mid-change; content that arrives later than that is still missed — wait for it with
`browser_wait_for`; and `settleMs` caps this wait like any other. Pass `waitUntil: "load"` for the old,
faster behaviour when you will wait for something specific yourself.

`networkidle` used to be a fixed 0.5 s after the load. It now watches the tab's requests and waits for
0.5 s with none open. A page that holds a connection open for good — a chat socket, a long-poll —
never goes idle, so there it always costs the full 5 s cap.

### What `settled` means on a navigation

`browser_navigate` answers with `settled` and `elapsedMs`, and `settled: true` means **the navigation
you asked for** finished — the tab went into loading and came back out of it. The status the tab had
before you asked does not count towards that: straight after a reload is issued, a tab still reports
the document you are *leaving* as complete, and taking that for an answer is how a reload used to come
back `settled: true` in 0 ms with the old page still on screen.

Three consequences worth knowing before you read one of these results:

- **A move that never loads settles as soon as the url changes.** A `#fragment` jump, or a history
  step that stays inside one document, fires no load event at all, so waiting for one would hold the
  call for its whole budget instead of returning.
- **A transition that never begins gives up after about 1 second**, with `settled: false`. A url that
  turns out to be a download, a "Leave site?" prompt nobody answered, a forward entry that was not
  there — nothing loads, and saying so in a second beats blocking for fifteen. **But the tab gets
  asked before that is believed**: if it reports itself loading, the navigation is underway and the
  full budget applies, even though no event said so. Chrome does exactly this to a page it has
  refused before — a certificate warning is re-attempted after roughly **3 seconds**, and the second
  it was given used to be reported as a page that never loaded.
- **`settled: false` is not an error.** It means the load was not seen to finish inside what you
  allowed — you asked for `waitUntil: "none"`, your `settleMs` ran out, the tab was closed, or the page
  is genuinely still loading. The call still tells you `urlBefore`, `urlAfter` and `navigated`.

The budget is 15 seconds for `browser_navigate` and 10 for `browser_go_back` / `browser_go_forward`,
and `settleMs` only ever shortens it — a `settleMs` of 300 gives up at 300 ms, grace included.

### A navigation that did not happen says so

`browser_navigate` used to answer `Navigated to <url>` whatever the browser did with it. The extension
has always reported the truth — `navigated`, `settled`, and the url the tab is really on — but that
only reached `structuredContent`, and **asking for a snapshot discards `structuredContent` entirely**.
So the common call handed you the *previous* page's snapshot under a success message.

Now, when the tab is not where the call asked it to go, the reply says so instead — in the snapshot
reply too, at the top, where it cannot be skipped:

> Did NOT reach `https://example.test/two` — after 2.0s the tab was still on `http://example.test/one`,
> so anything you read now is that OLD page, not `https://example.test/two`.

**Read it as an observation, not a verdict**, because a verdict is not available: the browser is still
moving while the reply is being written. Before saying anything, the server re-asks the tab where it
is, every 200 ms for up to **2 seconds** (`AUTOMATE_BROWSER_NAV_CONFIRM_MS`) — a page the browser is
slow to commit typically lands about **700 ms** after the call returns, and announcing failure on the
first answer got it wrong on two visits out of three. That wait is paid **only** by a call already
reported as having gone nowhere; a navigation that worked costs nothing extra.

**The honest limit.** This is a race against a browser that is still moving, so it is not exact.
Measured over 16 real navigations to a host the browser refuses (a bad certificate, which reproduces
the case reliably): **14 were reported correctly**, one warned about a page that arrived just after
the window closed, and one stayed quiet about a page that bounced back to the old document after the
window. Both disagreements are at that boundary. It is silent by design where an unchanged url is
correct anyway — a reload, `waitUntil: "none"` (which asked not to wait, and so cannot know), a
navigation to the page already open, and a redirect that lands somewhere other than the url you typed.

### A page that failed to load says so

A navigation to a host that refuses the connection, does not resolve or has a bad certificate used to
answer `ok` — the tab *had* moved, onto Chrome's own error page — and the next tool then failed with
`RESTRICTED_PAGE` and advice about `chrome://` pages. Now `browser_navigate` fails with
`NAVIGATION_FAILED`, naming the url and Chrome's own error, and takes no snapshot of the error page:

> `http://127.0.0.1:1/` did not load — Chrome showed its error page instead (net::ERR_CONNECTION_REFUSED).
> Nothing on that page can be read or clicked.

When you asked for `http://` and Chrome's "Always use secure connections" setting upgraded it to
`https://`, which then failed, the message says that too — only a person can allow the http site. Any
other tool run on an error page answers `NAVIGATION_FAILED` as well, instead of `RESTRICTED_PAGE`.

**The honest limits.** A download is not a failure, although its request is aborted the same way: it
is reported only when the load finished. `browser_go_back` and `browser_go_forward` do not throw on an
error page; the next tool you run there does. A page that loads and then shows its *own* error (a 404
page, a "something went wrong" screen) loaded fine as far as the browser is concerned — read it.

### Waiting for a condition, not a duration

`browser_wait` sleeps for a fixed number of seconds and is almost always the wrong tool — it is too
short on a slow run and wasted time on a fast one. `browser_wait_for` returns the moment the thing
you are waiting for is true, and gives up after 15 seconds unless you say otherwise:

- **an element**, by CSS selector, in whichever state you mean — `visible` (the default), `hidden`,
  `attached` or `detached`. The last two are the ones that catch a spinner being removed rather than
  merely faded out.
- **text**, as a case-sensitive substring anywhere in the page body or, wrapped in slashes, a regular
  expression. A plain `"Result:"` matches a "Result: n/a" placeholder the moment you ask, which is how
  a benchmark run read the old value; `"/Result: \d+/"` waits for the number. With `state: "hidden"`
  or `"detached"` it waits for the text to **go** — a "Loading..." notice clearing, say. A pattern that
  is not a valid regular expression is matched as plain text instead of failing.
- **the URL**, as a substring or, wrapped in slashes, a regular expression — which is how you wait
  out a login redirect without guessing how long it takes.

### Reading a page without a snapshot

A snapshot is for interacting; three cheaper tools are for reading, and each truncates rather than
flooding the reply:

- `browser_read_page` strips the navigation, scripts and styling and returns the article as plain
  text or Markdown. It returns no element references, which is the point — it is the cheapest way to
  answer a question about what a page says.
- `browser_get_html` returns raw `outerHTML`, for the attributes and structure a snapshot leaves out.
  Whole document by default, or one element by reference, capped at 50000 characters.
- `browser_find` returns just the elements matching a text substring, an ARIA role, a CSS selector or
  any combination, with working references and a default cap of 20. It is the tool for "click the
  Sign in button" when you already know that is what you want.

The two that truncate say `…(truncated)` when a cap bit, and `maxLength` moves it; `find` simply
returns at most `max` matches.

A text search returns the **innermost** element that holds the text. The text of a link is also the
text of the paragraph, the `<body>` and the `<html>` around it, so all of those used to match, came
first in page order and could fill `max` before the link was reached — `find "Sign in"` answered
`html`, `body`, `div`. Now an element that contains another match is dropped, and a control keeps the
label inside it: `<button><span>Sign in</span></button>` comes back as the button. The limits: a
text search now reads the whole page before cutting to `max` (it used to stop early); and with only
a `role` or `selector`, nested matches are all returned, because there you asked for exactly those.

Each match also prints the attributes that carry data rather than text — `id`, `href`, `title`,
`datetime` and `content`, when present — as `- link "Sign in" [ref=e3] <a href="/login" id="go">`.
That is what makes a `<relative-time>`'s real date or a link's target readable without
`browser_get_html`. And a `selector` now reaches elements that are never drawn: everything in
`<head>` has no box on screen, so `{ selector: "meta[name=user-login]" }` used to answer "no matching
elements" on a page that plainly had one. Such matches are marked `(hidden)` — read them, do not click
them. The limits: a text or role search still sees only what is drawn; each attribute value is cut to
120 characters, so a very long `href` ends in `…` (use `browser_get_html` for the whole thing); and
other attributes (`data-*`, `aria-*`, `value`) are not shown. None of the three throws away the element references you are already
holding. → [Element refs survive a re-render](#element-refs-survive-a-re-render)

### Tools the page declares about itself

Some pages publish the things they can do, so an agent can call the action directly rather than
finding and clicking the controls for it. A call made that way does not break when the site is
redesigned, and it works on pages an accessibility snapshot reads poorly. `browser_page_tools` reads
two conventions in one pass: the **WebMCP** draft (`document.modelContext`, with the older
`navigator.modelContext` as a fallback) and the **`devtoolstooldiscovery`** event that
chrome-devtools-mcp introduced.

`action: "list"` returns what the page offers, with each tool's argument names. `action: "call"` runs
one — `name` is the tool, `args` is a JSON object **string**. The result comes back JSON-encoded.

**The honest limit: expect an empty list.** This is a forward-looking capability, shipped so that
pages adopting the standard work here the day they do, not a feature with sites to use it on today.

- The standard is a **draft**, and essentially no live site declares anything through either
  convention yet.
- Availability differs **between builds of the same Chrome version**. Measured on 2026-09-05:
  `document.modelContext` was present in Chrome for Testing 152.0.7977.54 with no flags and absent
  from installed stable 152.0.7977.83. `navigator.modelContext` was gone in both. The discovery event
  needs no flag and answered everywhere.
- A page that declares nothing returns an **empty list and a plain reason**, never an error. That is
  a fact about the page. Do not retry it.
- A result that will not encode as JSON — a DOM node, a circular object — comes back as a note rather
  than a value. `browser_eval` and `window.__dtmcp.executeTool(name, args)` keep the live object if
  you need it.
- Calling a page tool can do anything the page can, so it is refused in read-only mode like any other
  write.

### Dialogs are armed in advance, not answered afterwards

`browser_handle_dialog` sets a **policy for the dialogs a page raises next** — `accept` (with
`promptText` for a `window.prompt`), `dismiss`, or `native` to hand them back to the browser. Called
with no arguments it reports the policy in force and the dialogs seen recently, without changing
anything.

**The honest limit: a dialog that is already up cannot be answered this way.** An open `alert`,
`confirm` or `prompt` pauses the page's renderer, so the override this tool installs is itself frozen
along with everything else. Clear one with `browser_navigate {reload: true}`, or turn on
`browser_advanced_mode` first — the debugger sits outside the renderer and is the only thing that can
answer a modal already blocking it. A page-acting tool that times out names this as the likely cause
rather than leaving you to guess.

A dialog fired synchronously during the very first moments of a page load can also be missed, because
the override is installed at document start and that race is genuinely tight.

### Where the LCP time actually went

"Your LCP was 3.2 seconds" is a number. "1.9 of those seconds were the server thinking before it sent
the first byte" is a task. Every trace that carries an LCP now also carries the four spans that add up
to it, each with its share of the total:

```
LCP breakdown — 1300ms total:
  time to first byte       200ms (15%)
  resource load delay      300ms (23%)
  resource load time       600ms (46%)
  render delay             200ms (15%)
  cause: the LCP image itself took 600ms to download (46%).
  fix: serve it in AVIF or WebP, sized for the viewport rather than the original upload.
```

Underneath it, the **render-blocking resources**: the requests that finished before first paint and
held it up, slowest first, with their own cause and fix line. An `async` script is deliberately left
out — it is already doing the right thing, and listing it would be advice to break working code.

The spans always **sum to the reported LCP**. That is what makes the biggest one safe to act on, and
it is the property the whole feature rests on.

**The honest limits, which are most of the value here.** Chrome never says "the LCP resource was X";
the breakdown reaches it by joining an element id across two different events, and there are three
cases where it cannot:

- **A text LCP** has no resource to download, so you get **two** spans, not four zeroes, and a line
  saying so.
- **An image whose network request cannot be matched** in the trace folds the download into render
  delay and says that in as many words, rather than reporting a download of zero.
- **A trace with no document-request timing**, or one whose spans come out negative because the
  document belongs to a different navigation, reports **no breakdown at all** and names what was
  missing.

Read those lines as "not measured", never as "fine". None of this needs a new tool, a new parameter,
or a bigger trace — it is the same recording, read more carefully. The parsing is pure and covered by
`tests/trace-insights.test.ts`, so it needs no browser to test.

### Log durability

The network log is mirrored into the browser's session storage, so it survives Chrome idling the
extension's service worker — the case where `browser_network_requests` used to come back empty and
`browser_issues` reported nothing wrong. It does **not** survive a browser restart.

Both list tools take `includePreserved`, which reaches back over the last 3 navigations instead of
just the current page — for debugging a login redirect, where the log you want belongs to the page
you were just bounced off. The console half is best-effort by construction: the page hands its buffer
over as it is being unloaded, so a crashed renderer, a killed tab or a `chrome://` navigation leaves
nothing to preserve, and the tool says so rather than pretending.

### Errors name the next step, not just the problem

Failures carry a **typed code** and the tool that recovers from it, so an agent has somewhere to go
instead of guessing or retrying the same call. `STALE_REF` names `browser_snapshot`. `NOT_ACTIONABLE`
says which check refused and what was covering the element. `ORIGIN_BLOCKED`, `READ_ONLY` and
`EVAL_BLOCKED` name the setting that refused and point at `browser_status`. `ADVANCED_MODE_REQUIRED` names the tool that turns
it on.

The same idea runs through the messages that are not errors at all. A timeout on a page-acting tool
mentions that an open dialog pauses the renderer and names two ways to clear one. A trace with no
measurements says whether the cause is provable (nothing was recorded) or a guess (the window may not
have been drawn). A screenshot on an unfocused window refuses and names both escapes rather than
handing back a stale frame.

The set is closed — seventeen codes, and no others. The first twelve describe something that went
wrong with your call; the last five label an entry in the issues feed, so a silent failure and a
raised error name the same problem the same way.

| Code | Means | Next step |
|---|---|---|
| `STALE_REF` | the element was replaced, not just re-rendered | `browser_snapshot` |
| `NOT_ACTIONABLE` | it failed the visible / enabled / stable / hit-testable check | the message names which, and what was covering it |
| `TAB_CLAIMED` | another agent is driving that tab | `browser_force_claim` |
| `TAB_GONE` | the tab was closed underneath you, or could not be recovered after the browser reconnected | `browser_list_tabs` |
| `LEASE_LOST` | your claim expired or was taken — usually arrives as a notice on your next successful call, not as a failure | `browser_select_tab` |
| `NO_BROWSER` | nothing is connected, the link dropped mid-call, or the browser the call was aimed at did not come back | retried once automatically when the action demonstrably never happened, and only against that same browser. When the link dropped *after* the request went out and the tool is one that cannot be repeated safely, it is **not** flagged retryable and the message says the action may already have landed |
| `NAVIGATION_FAILED` | the page did not load — the tab shows Chrome's error page (refused, unresolved, bad certificate) | check the url; an http site Chrome upgraded to https needs a person |
| `RESTRICTED_PAGE` | a `chrome://` page, the store, or the PDF viewer | drive an ordinary http(s) page |
| `ADVANCED_MODE_REQUIRED` | the option needs the debugger | `browser_advanced_mode` |
| `CAPTURE_STALLED` | Chrome stopped drawing the tab, twice | flagged retryable — a screenshot has no side effect |
| `TAB_HIDDEN` | Chrome is not drawing the tab (minimised window or background tab), so a real click / key / hover or a page-load trace cannot work | `browser_switch_tab` — it restores the window; it takes the user's screen, so ask |
| `ORIGIN_BLOCKED` | your own allow / deny / sensitive list refused it, or the tab moved between the check and the action | `browser_status` prints the policy |
| `READ_ONLY` | read-only mode is on and this tool changes the page | `browser_status` |
| `EVAL_BLOCKED` | running JavaScript you wrote is switched off — even to read | `browser_status`; use a snapshot or `browser_find` instead |
| `CSP_BLOCKED` `MIXED_CONTENT` `CORS_BLOCKED` `DEPRECATED_API` `THIRD_PARTY_COOKIE_BLOCKED` | why something on the page silently did nothing | `browser_issues` |

With `AUTOMATE_BROWSER_STRUCTURED=1` each also arrives as `structuredContent` — the code, the message,
whether it is retryable, and the tool to call next — so a script can branch on it without reading the
prose ([why that is off by default](#machine-readable-results)).

**The honest limit:** under that switch, the nine tools that declare an output schema (`browser_get_cookies`,
`browser_storage`, `browser_downloads`, `browser_network_requests`, `browser_status`,
`browser_list_clients`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`) get the code in
the **text only**. A client validates any `structuredContent` against the declared schema — failures
included — so attaching the error head there replaced the real reason with a schema-validation
complaint. The `CODE: message` line and the `Recover:` line are identical either way.

**Every one of these exists because the bare version cost someone a debugging session.**

### Automatic retry for transient failures

If a call fails because the connection to the relay dropped or the extension's worker was being
replaced — failures where the action demonstrably never happened — the server retries it **once** and
notes that it did. This applies only to tools that declare themselves idempotent: a click, a form fill
or a force-claim is never retried, because "it probably didn't happen" is not good enough for a side
effect. Timeouts are never retried either, for the same reason.

### Five outcomes, not two

`isError` is a boolean, and five different things were being squeezed through it. Three of them came
out wrong, and every one of them was wrong in the direction that costs you something:

| What happened | What you get now |
|---|---|
| **Refused** — a safety policy, a bad argument, a section name that does not exist | the failure, with its code. Nothing was sent, so nothing can have happened |
| **Done** | the result. Optional extras that failed on the way out are footnotes, never a demotion |
| **Partly done** | `outcome: "partial"`, plus the per-field verdicts. `browser_fill_form` also returns `{ filled, total, errors }` as `structuredContent` when `AUTOMATE_BROWSER_STRUCTURED=1` |
| **Failed** | `isError: true`. A tool that *returns* a failure is now recorded as one in the audit trail too — it used to be logged `ok` |
| **Nobody knows** | the link dropped **after** the request went out. The message says the action **may have taken effect**, points you at `browser_snapshot`, and is **not** flagged retryable |

The last row is the one that mattered most. A `browser_click` whose reply was lost used to come back
as "usually transient — retry in a moment", flagged retryable. The request had already gone out.
"Nobody knows whether it happened" is not "it did not happen", and the difference is a second click —
a second payment, a second message sent. Tools that declare themselves idempotent, and every read, are
unaffected: repeating them is free, so they keep the retry and the old wording.

`outcome` rides **beside** `isError`, not inside `structuredContent`, so it is visible on a tool that
declares an output schema without breaking that schema. It is present only when `isError` alone would
mislead — in practice on a partial fill.

**The honest limit:** "may have taken effect" is the best answer available, not a lookup. Nothing
tells the server whether a request it never got an answer to was executed, and a **timeout** is
outside this rule entirely — it keeps the existing advice about a possible open dialog, which is the
far likelier cause.

### The link to the relay repairs itself

The retry above is about one call. This is about the connection underneath it. When the server loses
the relay — it crashed, it was restarted, the editor that was hosting it quit — the server dials back
on its own, waiting **0.5 seconds** before the first attempt and doubling up to **8 seconds** between
later ones. It keeps going for as long as the relay is unreachable, and the delay only returns to
0.5 seconds once a relay has actually completed the handshake, so a relay that accepts the connection
and then rejects it is backed off from rather than hammered.

The same is true at startup: a server that comes up while the relay is briefly unavailable is not
stranded. It reports the failure to whatever asked, and then keeps trying in the background.

**The honest limit:** until it is back, calls fail with `NO_BROWSER`, and a call is what tells you it
recovered — nothing announces the reconnection. `browser_status` is the cheapest way to ask, and it
does not itself force a connection. Shutting the server down cancels the retries for good; a server
you deliberately stopped never comes back on its own.

### `browser_status` says whether it is coming back

That question used to have no answer. `browser_status` printed one line —
*"relay: not connected yet (starting / retrying)"* — for four different situations, including the one
where nothing is being retried at all, so "wait a moment" and "this is over" read identically.

It now prints a `link:` line whose first word is the state, in capitals, so it can be matched without
reading the sentence after it:

| Line | What to do |
|---|---|
| `link: CONNECTED` | nothing |
| `link: WAITING — connected to the relay, but no browser has joined it yet` | open a browser with the extension; the server is fine |
| `link: RETRYING — 2 failed attempts, next attempt in 1.5s. It will keep trying on its own. Last failure: …` | wait; it recovers without you |
| `link: CONNECTING — 1 failed attempt so far. Last failure: …` | wait |
| `link: STOPPED — this server is shutting down and will NOT reconnect.` | **stop waiting** — restart the server |

**Being on the relay and having a browser are separate states**, which is why `WAITING` exists: a
server can be perfectly connected and still unable to drive anything, and reporting that as
"connected" is what makes it look like the tools are broken.

The failure reason is the error's message only — never a stack — capped at 200 characters, with the
shared token spliced out by value if it appears. The count is of *consecutive* failures and resets on
a handshake the relay actually completed, not on a socket that merely opened.

**The honest limit:** it is one reason and one count, not a log. An earlier failure is overwritten by
a later one, and nothing here is persisted — a history buffer would grow fastest in exactly the
situation where nobody is reading it. It is also deliberately **not** in `outputSchema`: that is paid
for on every request by every agent, and the state is already the first word of the line.

### A retry never changes browser or tab

A retry goes back to the **same browser and the same tab** the call was aimed at, and nowhere else.
The browser is matched by the identity the extension stores for itself, so reloading it — or its
worker being evicted and revived — brings the same browser back under a new connection id and the
retry follows it, carrying the original tab.

**The honest limits, all of which refuse rather than guess:**

- If that browser does not come back within `AUTOMATE_BROWSER_CONNECT_WAIT_MS`, you get `NO_BROWSER`.
  Another browser being connected changes nothing — a different profile has different tabs and a
  different logged-in session, so delivering there is not a recovery.
- If the extension is old enough not to report a stable identity, a reconnect cannot be recognised at
  all, so there is no retry: `NO_BROWSER` on the first failure.
- If the tab cannot be carried across, you get `TAB_GONE` and the action is **not** attempted. Adopt a
  tab again with `browser_select_tab` and repeat it.

This matters more than it sounds. Before this, a retry re-resolved the browser for itself, and the
browser it landed on owned no tab of yours — so the extension fell back to the tab **the user was
looking at**, and a navigation meant for a test page could replace their work.

### Reload, and the two options that need the debugger

`browser_navigate { reload: true, ignoreCache: true }` forces a cache-bypassing reload — the answer to
"but I already fixed that". It needs nothing special.

Two navigation options **do** require `browser_advanced_mode`, and say so in their own descriptions,
because no debugger-free browser API can provide them:

- `initScript` — run your JS **before any page script** on this navigation (stub `Date.now`, mock
  `fetch`, pre-seed storage, kill a consent banner before it renders).
- `handleBeforeUnload: "accept" | "dismiss"` — answer a native "Leave site?" prompt so the navigation
  cannot hang on it. The dialog policy that covers `alert`/`confirm`/`prompt` cannot: that prompt is
  drawn by the browser, and page scripts can neither see nor answer it.

Both are armed before the navigation is issued, and torn down again once it has finished or failed, so
nothing is left running on later pages. **Torn down once it has finished** is the load-bearing half: a
teardown that happened when the call returned would pull the init script before the new document
existed, and the call would report `initScript: "installed"` for a script that never ran. So when
either option is in play, `waitUntil: "none"` still waits for the page to commit before cleaning up —
that one combination is not instant, and it is capped by the same 15-second budget. With advanced mode
off they refuse and tell you to enable it — they never silently do nothing.

Separately, and with no debugger involved: when an open `alert`/`confirm`/`prompt` freezes the page,
a page-acting tool used to time out with an unexplained "Socket message timeout". It now names the
dialog as the likely cause and points at `browser_handle_dialog`.

A click that **leaves the page** used to fall into the same trap without any dialog: Chrome never
answers an in-page step whose document unloads, so following a link (or a `browser_type` with
`submit: true` that sends a form) hung for the full 8 seconds and was then blamed on a dialog. It now
returns as soon as the tab starts loading the new page — measured **0.4 s instead of an 8 s error** —
with `navigated: true` and the new `urlAfter`. **Honest limits:** the "did the page settle" check
inside the old page is skipped in that case, so the result carries no `domSettled`; and a page that
starts navigating on its own at that very moment cannot be told apart from one the click sent away.

And when a page-acting call **does** run out of time while its tab is loading a new page — a short
`timeout` against a slow page, or a load Chrome never reports — the error no longer blames a dialog.
It names the page that started loading and says the action most likely landed, so the next step is a
snapshot, not a blind repeat. The question behind it ("did a top-level load begin during this call?")
is put to the browser's request log **only after a timeout**, so a call that succeeds pays nothing;
measured, it added about **8 ms** to the failed call. Without the request log (an extension too old to
keep one), the dialog hint is given as before.

### Loading a site with a bad certificate

Internal staging environments routinely serve a certificate the browser refuses — self-signed, expired,
or issued for a different host. **AutomateBrowser cannot get you past that, and no longer pretends to.**

**What to do instead:** start the browser with `--ignore-certificate-errors`, or click through the
warning page by hand once — the click is remembered for that host for the session, and everything else
in AutomateBrowser then works against it normally.

**Why there is no switch for it.** There was one, `browser_advanced_mode {acceptInsecureCerts: true}`,
from 2026-09-10 until it was deleted on 2026-09-16. It never worked on any build: the call comes back
`'Security.setIgnoreCertificateErrors' wasn't found`, because `chrome.debugger` exposes a **fixed
allow-list** of DevTools Protocol domains to extensions and `Security` is not on it — the same
allow-list that makes a heap snapshot impossible here. Measured against headless Chrome 153, headed
Chrome 153 and Edge; identical in all three. A permanent error is not a feature, and it was charged to
every request in every IDE, so it was removed rather than kept as a signpost.

**If you pass it anyway, you get told.** The argument is refused by name — it is not quietly dropped,
which would leave an agent working from older guidance believing certificate checking was off. The
refusal says it never worked, why, and names both workarounds above.

**The honest limit this leaves.** Nothing now probes that allow-list, so if a future Chrome adds
`Security` to it, no check will announce it — the tripwire went with the feature. That was the
deliberate trade: a per-request cost, forever, is too much to pay for an early warning about a command
nobody can call. Note also that even a working bypass could not help where Chrome offers none, such as
an HSTS-pinned host or an enterprise-policy interstitial, and that a tab already parked on the
certificate interstitial will not accept a debugger attachment **at all** (`Cannot attach to this
target`).

**How this was missed for six days, since that is the more useful lesson.** The command was verified
present in Chromium's own source, which is true and was the wrong thing to check: what decides this is
`chrome.debugger`'s allow-list, not whether the browser implements the command. Ten smoke checks
covered it against a fake browser and all ten passed, because they assert the flag *leaves the server*
correctly — which it did. Nothing exercised a real browser until `npm run test:live` was written.

### A click the page ignored is reported

The default click is synthetic, and some pages act only on a real (trusted) one. Those pages used to
answer "Clicked" and nothing more, so the agent carried on as if the click had worked. Now, when a
click by ref shows no reaction at all and did not navigate, the reply adds one line:

```
Clicked "Generate"
No change seen on the page. If the click should have done something, it may need a real click: browser_advanced_mode, with the tab visible.
```

"A reaction" is any of: the page's content changed (watched from **before** the click is dispatched,
so a handler that changes the page synchronously counts), a checkbox flipped, focus moved into a field
or somewhere else, or the tab sent a request — or any tab began a new page load, which covers a link
that opens a new tab. It costs no extra time: the watch runs during the settle the click already waits
for, and the request check is an in-memory lookup made only when nothing else changed. Measured on the
integration pages (2026-10-02): **0 notes on 13 clicks that really worked**, and the note on a button
that acts only on `isTrusted` clicks.

It is a note, not an error, and nothing is retried for you. The honest limits:

- **A click can work and change nothing visible** — then the note is a false alarm. Read it as "check",
  not "failed".
- **Changes inside a shadow tree other than the clicked element's own are not seen**, so a web
  component that re-renders a sibling's shadow tree can draw a false note.
- **A late reaction is missed.** The watch ends when the click's settle does — usually a few hundred
  milliseconds; a handler that waits longer before touching the page, without sending a request, draws
  the note.
- **Another tab starting a page load at the same moment hides the note** (it errs towards silence).
- **Only a click by ref is measured.** A coordinate click, a click in advanced mode, and a call run with
  `AUTOMATE_BROWSER_ACTIONABILITY=off` never carry the note.

### Hover: what the page sees, and what CSS sees

The default `browser_hover` fires synthetic mouse events. The page's own scripts see them, so a menu
opened by a `mouseover` or `mouseenter` handler opens. But the browser's real pointer never moves, so
**CSS `:hover` rules do not apply** — a menu, tooltip or style that exists only in CSS stays hidden.
The reply used to say "Hovered over" either way; it now says which kind it was:

```
Hovered over "Products" (synthetic: page scripts saw the mouse; CSS :hover styles do not apply. For the hover look, use browser_advanced_mode with the tab visible.)
```

With `browser_advanced_mode` on, hover is a **real mouse move** to the element's centre and replies
`(real mouse)`; the element then matches `:hover`, checked in a real Chrome by the integration suite.
The limits are the trusted click's: it is **refused on a tab Chrome is not drawing** (a minimised
window or a background tab — Chrome would discard the move and report success), and it cannot reach an
element inside a cross-origin frame. The real pointer stays where it was left until something else
moves it.

### Advanced mode does not change what interactions return

With `browser_advanced_mode` on, `browser_click`, `browser_hover` and `browser_press_key` are
dispatched as real OS-level input rather than synthetic events. That is the only difference an agent
sees. **Click and key press still wait for the page to settle and still return the same fields** —
`navigated`, `urlBefore`, `urlAfter`, `settled`, `elapsedMs`, plus the `hit` naming what was actually
under a coordinate click. Hover never settled on either path; its reply only changes from
`(synthetic: …)` to `(real mouse)`.

**Only `browser_advanced_mode` switches input to real.** Other calls attach the debugger for their own
sake — `browser_get_network_request` or `browser_upload_file` with `keepEnabled: true`, a full-page
screenshot with it, a `browser_perf_trace` recording. Until 2026-10-02 any leftover attach silently
moved every later click, key and hover onto the real-input path, which a background tab then
**refused** (a benchmark run read one response body and its next click failed). Input is now chosen
on the mode alone, checked in a real Chrome by the integration suite. A trace that attached the
debugger detaches it again on stop, and `browser_advanced_mode {}` answers **OFF** for a leftover
attach while still listing the tab under "Attached tabs" — the banner is up, your input is unchanged.
One limit: a `keepEnabled` capture made *while* a trace is recording is detached when that trace stops.

Until 2026-09-01 they returned a bare `{ok: true}` instead. Enabling the debugger for something
unrelated — reading one response body, recording one trace — therefore changed both the shape of every
click reply and its timing, because the settle was skipped entirely. Pressing Enter to submit a form
returned before the navigation had started, handing the next call a page still in motion. Nothing
announced this, and no error was ever raised.

Two honest limits, and the first one matters more than the fix:

- **Trusted input cannot reach a background tab at all.** Chrome discards real input aimed at a tab it
  is not drawing. Since the agent works in a background tab by default, `browser_click`,
  `browser_hover` and `browser_press_key` **refuse** while advanced mode is on, naming the reason and telling you to bring
  the tab forward or turn the mode off. They never report a success that did not happen — but it does
  mean the practical pattern is: enable advanced mode for the thing that needs it, then turn it off
  before interacting. The debugger-free path works fine in a hidden tab.
- The trusted path still does not report `recovered` or `domSettled`. Those describe the injected
  operation's ref-recovery, which real input genuinely does not perform, so they are omitted rather
  than faked.

Related, and found by the same test on 2026-09-01: trusted **Enter** dispatched only a raw key-down,
which fires `keydown` listeners but runs no default action — so it moved focus, reported success, and
**did not submit the form**. It now carries the character payload that makes the renderer run the
default action, as does Space. Modifier combos (`Control+A`) deliberately still send no character: a
shortcut is not a keystroke.

### The agent's own tab

The agent drives **only a tab it explicitly owns**. On its first action against a browser it opens a
new tab in the background and works there; that tab is its target until it selects another. It never
adopts whichever tab you happen to have in front of you, so a request to "test this page" cannot
navigate away a tab holding unsaved work.

To point it at a tab **you** already have open, use `browser_select_tab` — by `tabId`, `index`, or a
`url`/`title` substring (`{ url: "localhost:3000" }`). That is a deliberate takeover, and the tab is
driven where it sits, without being brought to the front.

**On `browser_release_client`, a tab the agent OPENED is closed; a tab it ADOPTED from you is left
exactly where it is.** The distinction is deliberate — cleaning up after itself must never mean
closing something of yours.

The honest limits:

- **If a background tab cannot be given to the agent, the call fails** rather than falling back to
  your tab. The error names `browser_select_tab` as the way out.
- **The agent's tab is not closed when your editor simply exits** — only on an explicit release. An
  abandoned session leaves one background tab behind.
- **A tab you handed over with `browser_select_tab` is never cleaned up**, by design. Closing it is
  your call.
- **Cleanup is deferred, never redirected, when the browser that owns the tabs is gone.** Releasing
  sends closes only to that browser; if it has disconnected — or quits part-way through the sweep —
  the remaining tabs stay on its books and the next release closes them once it is back. So a release
  can legitimately close nothing and still report success. The alternative was worse: tab ids are
  small and allocated per browser, so Chrome's tab 101 and Edge's tab 101 both exist, and a close that
  re-resolved "the active browser" closed one of the user's tabs in the other one.
- **Reloading the extension mid-session used to break cleanup entirely. Fixed 2026-09-02.** A relay
  id belongs to a *connection*, so reloading the extension — or the background worker being evicted
  and revived — brought the same browser back under a new one, and the record of which tabs the agent
  had opened went with the old id. Release then closed nothing. Ownership is now keyed by the
  extension's own stored id, which survives both. Found by hand in Edge: open a tab, reload the
  extension, release, and the tab was still there. A 90-second idle spell did **not** trigger it, so
  the trigger is the reconnect, never the waiting.

### A clean, logged-out session on demand

Every tab the agent drives is your real, signed-in profile, so "what does a first-time visitor see?"
has no answer without logging yourself out for real. `browser_new_tab { incognito: true }` opens a
**private window** instead — a clean session with none of your cookies or logins — and drives a tab
inside it. That is how a signup flow, a paywall, a cookie banner or any logged-out state gets checked
without touching your account.

**It needs one setting, and only a person can turn it on.** On the extension's details page:
"Allow in Incognito" in Chrome, "Allow in InPrivate" in Edge. Turning it on restarts the extension,
so the connection blinks. Until then the call fails with `INCOGNITO_BLOCKED` and a message naming that
exact setting in both browsers' words, rather than a bare failure.

Measured in Chrome 152 and Edge on 2026-09-05, and re-runnable with
`node scripts/incognito-check.mjs [--edge]`:

- **The refusal had to be built, not caught.** Asking for a private window without permission does not
  fail — `chrome.windows.create({incognito:true})` **resolves with nothing at all**, in both browsers.
  Anything trusting that promise gets a "success" and no window. Permission is therefore checked
  first, which is what turns silence into a sentence.
- **A private tab is owned, claimed and released like any other**, and appears in `browser_list_tabs`
  marked `(private)` so a clean session is never mistaken for your real one.
- **Cookies are a separate jar, and the tools now address the right one.** A private window has its own
  cookie store; asking Chrome for cookies without naming a store reads *your* real one. So
  `browser_get_cookies` and `browser_set_cookie` resolve the driven tab's own store and use it. Before
  this, driving a private tab would have shown the agent your live session while it believed it was
  looking at a stranger's.
- **Web storage was already correct** — `browser_storage` runs inside the tab, so it sees the private
  origin's storage and not yours.
- Closing the tab ends the session. Nothing survives it, and there is nothing to clean up.

### What can take your focus

Exactly one tool takes focus: **`browser_switch_tab`**, whose description says so, and which exists
for "show me what you did". Everything else works in the background:

- `browser_new_tab` opens in the **background** by default. `active: true` is the explicit opt-in and
  is the only argument anywhere that brings a window forward.
- `browser_select_tab` takes over a tab **without** activating it.
- Navigation, clicks, typing, reads and snapshots all run on a background tab.

#### Switching restores a minimised window

Focusing a window does not un-minimise it in Chrome, so `browser_switch_tab` used to report success
while the page stayed hidden. It now restores a minimised window first, then focuses it, and the reply
says what the **page** reports: `— the page is visible`, or `— but the page is still hidden` with the
likely reason. In a test Chrome the page went from `hidden` to `visible` within the call; with the old
behaviour the window stayed minimised. Nothing else touches the window. Measured on a Windows 11
desktop with another app (Excel) in front: the restored window became the front window about 45 ms
after the call, and a window that was maximised came back maximised (normal came back normal).

Limits: that was a test Chrome, not a long-running everyday one. Windows can still refuse to bring a
window forward and only flash it in the taskbar, and a window covered by another one or on another
virtual desktop can stay hidden — in each case the reply says hidden rather than claiming success. On a settings page, or with an older
extension, the reply says nothing about visibility.

Screenshots included: **`browser_screenshot` works on a background tab and does not bring it
forward.** How it gets there is worth knowing, because it has a visible cost.

The cheap capture Chrome offers extensions photographs *whatever is on screen* — the foreground tab
of a window. Pointed at a background tab it returns the wrong page, and pointed at a window the OS
is not drawing it returns a **stale or blank frame with no error at all** (measured 2026-08-27). So
when the target tab is not the foreground tab of a drawn window, this server does not use that path.
It renders the exact tab through the debugger instead, which needs nothing on screen.

- **The cost:** Chrome shows its "being debugged" banner for the duration. The debugger is detached
  again straight after, unless `keepEnabled: true`. This is the same mechanism `fullPage: true` has
  always used. A debugger left attached this way does not switch your clicks to real input — only
  `browser_advanced_mode` does.
- **The result says so.** A capture taken this way comes back with a line naming the reason — the tab
  was not the foreground one, or its window was minimised, or not focused — so an agent can tell you
  why the banner appeared instead of leaving you to wonder. It rides alongside the image, and in
  `structuredContent` with `AUTOMATE_BROWSER_STRUCTURED=1`. A capture on the cheap path carries neither,
  so nothing changed for the ordinary case. **Fixed 2026-09-04:** the extension had always reported
  both, and the server dropped them before the reply was assembled, which made this very line untrue
  in both this file and the shipped skill for as long as either has said it.
- **When the foreground tab IS the target**, nothing changes — the cheap path is used and no banner
  appears.
- **The honest failure:** if the debugger cannot attach — a restricted page, or policy — the call
  **fails with that reason named**, and suggests `browser_switch_tab`. It never silently falls back
  to the capture that would return the wrong tab's pixels. Verified 2026-09-02 by pointing it at
  `edge://extensions/` from another tab: it refused, quoted Chrome's own reason, and returned no
  image.
- **Having DevTools open does not block it, despite what this file used to say.** Until 2026-09-02
  the line above named DevTools as the first cause and offered closing it as the first remedy. Both
  were wrong: measured in Edge 152, a background tab with the DevTools panel open attached and
  captured correctly, because Chromium permits several debugger clients on one tab. The picture you
  get is whatever that tab is really rendering — including a phone-sized page if their DevTools is in
  device-emulation mode.

### Sharing a browser with another agent

Ownership is **per tab**, so two editors can drive two different tabs of the same browser at the same
time. Only same-tab access is serialized, through a soft claim that expires on idle, on
`browser_release_client`, or when a client disconnects.

When another agent does take a tab you were driving, you are **told on the result of your next call**,
whatever that call was — not left to discover it when an action lands somewhere unexpected. It arrives
as a notice on a successful result, not as an error, because your call did succeed.

`browser_list_clients` shows every connected browser with who is driving it; `browser_select_client`
picks one (`force: true` takes over and notifies the other agent); `browser_status` is the diagnostic
when something is missing. The roster lists agents that are merely *connected*, not just those
currently holding a claim, so an idle editor never silently disappears.

### The server leaves when your editor does

A stdio MCP server normally exits when its client closes the pipe. That is watched here three ways
(`close`, end-of-file, and a pipe reset, because `close` alone is unreliable on Windows) and so are
`SIGINT` and `SIGTERM`. Shutdown is also bounded: if closing cleanly takes more than five seconds,
the process exits anyway.

**An editor can also vanish without closing anything** — the window is killed, the machine sleeps and
the MCP session is rebuilt, the process tree is reparented. The open relay socket keeps the event
loop alive and the crash guards swallow the errors, so nothing would ever bring that process down;
it would sit in every other editor's roster as an agent that is connected and never does anything.
So the server watches the process that launched it and exits within five seconds of it disappearing.

Two things this deliberately does not do. It does not take the relay with it — the relay is shared,
and idles out on its own about five minutes after the last agent *and* browser have gone. And it does
not close the tab the agent was working in; only an explicit `browser_release_client` does that.
→ [The agent's own tab](#the-agents-own-tab)

Separately, an unexpected asynchronous error never kills the session. It is logged to stderr and the
process carries on, because the alternative — the transport closing and your editor showing
"Transport closed" — is a worse outcome than one failed tool call. A relay that is slow to start is
handled the same way: the connection is made in the background and tool calls wait for it, so a
failing relay can never make the initial handshake fail.

### Machine-readable results

An agent gets the written reply — the summary, the warnings, the "call this next" line. The
machine-readable copy of each result (`structuredContent`) is **off by default** since 2026-10-02.

The reason is one client's behaviour, measured rather than assumed: when a result carries both,
**Claude Code shows the agent the structured copy instead of the text**. `browser_status` came back
as bare JSON with its warnings gone, and in the plan 13 benchmark `browser_get_console_logs` showed
`{"page":1,"totalPages":1,"total":1,"hasNext":false}` and none of the messages — three times. About
25 replies across the server were hiding their text this way, the console-error footer included.

- **Scripts that want the fields** set `AUTOMATE_BROWSER_STRUCTURED=1`. Results then carry
  `structuredContent` again and the nine data tools list their output schemas.
- **The terminal CLI is unchanged:** `--json` still prints the whole result, structured copy included.
- **The honest limit:** with the switch on, an agent in Claude Code is back to reading the bare data.
  Leave it off for any agent.

### Finding out your copy is out of date

A stale install is not a harmless thing here — the multi-IDE partition bug that shaped this whole
roadmap was caused by one, and nothing in the product told anyone they were behind. The section
below it compares two *local* processes to each other, so it can never notice that both are old.

So, on startup, the server checks whether a newer release exists and prints one line on **stderr**
if there is:

```
A newer @automatebrowser/mcp is available: 1.0.0 -> 1.1.0. Update with `npm i -g @automatebrowser/mcp`.
Set AUTOMATE_BROWSER_NO_UPDATE_CHECK=1 to silence this.
```

**Exactly what happens, since this is the one thing that leaves your machine.** A single unauthenticated
`GET https://registry.npmjs.org/@automatebrowser/mcp/latest`, with no body, no identifier and no
telemetry of any kind. The registry learns that some machine asked for this package's version number,
which is the same thing it learns when you install it. Nothing about your browsing, your tabs, your
profile or your machine is sent, because none of it is in the request.

**The honest limits.**

- **At most one request per 24 hours.** The answer is cached in `~/.automate-browser/update-check.json`
  next to the audit log, and a failed attempt is stamped too — so an offline machine retries tomorrow
  rather than on every start.
- **It never blocks and never fails loudly.** Startup does not wait for it, the request gives up after
  3 seconds, and being offline, blocked by a proxy or served nonsense is a silent no-op. If the very
  first run cannot reach the registry, the notice simply arrives on a later one.
- **stderr only, never stdout.** stdout carries the MCP protocol frames and one stray byte there would
  corrupt the session.
- **It respects `AUTOMATE_BROWSER_LOG_LEVEL`.** Set it to `error` and the notice is suppressed with
  everything else at warning level.
- **It cannot update anything.** It tells you; you run the command.
- **`AUTOMATE_BROWSER_NO_UPDATE_CHECK=1` prevents the request itself**, not just the printed line, and
  no cache file is written.
- **The CLI does not do this** — only the MCP server does, once per server start.

### Relay version mismatch

The relay is shared and single-instance, so whichever build starts it first owns the port until it
shuts down. If one editor points at an older copy of AutomateBrowser, every other editor ends up
driving *its* relay. `browser_status` now says so explicitly, naming both versions. The fix is to
point every editor at the same build, close them all so the relay exits, then reopen.

### File-path sandbox

Every tool that takes a local path only accepts one inside the **roots your MCP client advertises**,
plus the system temp directory. That is one read path — `browser_upload_file`, which without this
could make your logged-in browser upload `~/.ssh/id_rsa` to any site — and four write paths:
`browser_perf_trace`, `browser_snapshot`, `browser_screenshot` and `browser_eval`, each of which can
send a large result to a file instead of into the reply.

A client that sends no roots gets the server's working directory + temp instead; there is no
allow-everything mode short of the env var above. Paths are resolved through symlinks before the
check, so neither `../` nor a symlink out of a root gets past it, and a refusal names the roots it
would have accepted so the agent can retry correctly.

**Naming your own folders: `AUTOMATE_BROWSER_WORKSPACE`.** Roots are a client feature, and plenty of
clients do not implement them — at the time of writing Cline, Zed, Windsurf, Gemini CLI, OpenAI Codex
and Amazon Q Developer CLI all connect without one, while Claude Code, Cursor and VS Code (GitHub
Copilot) do send roots. Rather than reaching for the allow-everything switch, set this variable to the
folders you want writable:

```jsonc
"env": { "AUTOMATE_BROWSER_WORKSPACE": "D:\\work\\my-app;D:\\work\\traces" }  // ":" separated on macOS/Linux
```

The honest limits. It **adds** to whatever your client sent and never replaces it, so scoped roots
stay scoped. Blank entries are dropped, which means an empty or whitespace-only value adds nothing
rather than quietly meaning "everywhere" — that is the one behaviour worth knowing, because a variable
set to `""` by a wrapper script is how a sandbox usually falls open. It grants the named folder and
its children only, not the parent. And it is not a bypass: `..` and symlinks are still resolved and
still checked. To see what actually took effect, run with `AUTOMATE_BROWSER_LOG_LEVEL=debug` — at
startup the server prints every root in force and where each one came from:

```text
path sandbox: 3 root(s) in force — D:\work\my-app [AUTOMATE_BROWSER_WORKSPACE]; \
  D:\D Drive\Projects\thing [working directory (no client roots)]; C:\...\Temp [temp directory]
```

**A write target is also checked before the work starts, not after it.** Once the path is known to be
inside a root, the parent directory is created if it does not exist, and the target is confirmed
writable and not an existing directory. A trace can record for a minute before it writes; discovering
a bad path then would throw all of it away. It also means `{filePath: "traces/run1.json"}` simply
works rather than failing because `traces/` was not there yet.

### Cookie, storage and header values are hidden by default

`browser_get_cookies`, `browser_storage {action:"get"}` and `browser_get_network_request` return the
**names** and every other field, with each secret value replaced by `<redacted>`. Pass
`revealValues: true` to get the real ones.

The reason is that this server drives a browser you are signed into everywhere. "List the cookies on
this page" is a reasonable thing for an agent to do while debugging a login, and the default answer
to it should not be your session token — copied into a transcript, a log, and whatever the model
provider retains. The redaction is applied on the server, so the values do not reach the reply at
all. The result also carries a `redacted` flag, so a client can tell a hidden value from an empty one.

Reveal them when you actually need them, which is rarer than it sounds — checking that a cookie
**exists**, or when it expires, or whether it is `httpOnly`, needs no value at all. Note that
`browser_eval` can read `document.cookie` directly and is not covered by this; the redaction is a
sensible default on the tools built for the job, not a containment boundary. The audit log applies
the same rule from the other side: a value that could be a secret is recorded as a length, never as
a value.

**Request and response headers are the same secret by another name.**
`browser_get_network_request` returns both header sets alongside the body, and hides the value of
any header named `authorization`, `proxy-authorization`, `cookie` or `set-cookie`, or whose name
contains `token`, `api-key`, `apikey`, `secret`, `password` or `credential`. Matching is
case-insensitive, because HTTP header names are. The substring rule is deliberately wide: it will
also hide a pagination `x-continuation-token`, and that costs one re-call with `revealValues: true`,
where missing a real bearer token costs a live credential in a transcript that is already written.

Header **names** are always kept, and the result says how many values were withheld — because "this
request sent no auth header" and "this request sent an auth header you cannot see" are different
answers, and an agent debugging a `401` needs the difference. A realistic 20-header request/response
pair costs **277 output tokens**, paid only when you call the tool — the schema cost of the new
`revealValues` argument, which every request pays, is **27 tokens**.

### Where a navigation may go

`browser_navigate` and `browser_new_tab` accept `http:`, `https:` and `about:` URLs, and refuse
everything else by name. That rules out `javascript:` (which would execute in whatever page is open),
`file:` (which would read the disk through the browser, around the file sandbox above), and the
browser's own `chrome://` / `edge://` pages, which no extension can read.

A settings page gets one answer from every tool: `RESTRICTED_PAGE` — *"a browser settings page cannot
be read by the agent; a person must look at it."* A screenshot of a settings tab the user opened says
the same, before trying to capture. **Fixed 2026-10-02:** `browser_new_tab` used to open such a page,
and the next call on it reported `TAB_GONE` — "the tab has closed" — while the tab was still open.

This is a scheme check, not a site policy — it is always on and there is nothing to configure. To
restrict *which sites*, use the allow and deny lists below.

### What can reach the local socket

The relay listens on loopback, which any program on this machine can reach — including a web page,
since a page's JavaScript is free to open a WebSocket to `127.0.0.1`. Three rules sit in front of it:

- **A peer that presents a browser-extension origin must be the AutomateBrowser extension.** Any
  other extension origin is rejected with a 403 before the connection opens. Set
  `AUTOMATE_BROWSER_EXTENSION_ORIGINS` if you build the extension yourself under a different id.
- **A peer that floods the socket is disconnected** — more than 120 frames in a second and the
  connection is closed. Genuine automation bursts sit far below that; the ceiling and its window are
  both configurable.
- **A malformed frame ends the connection**, rather than being skipped. Anything that is not JSON, or
  that is JSON without the expected envelope, closes the socket immediately.

With `AUTOMATE_BROWSER_TOKEN` set, every peer must additionally prove it holds the secret — and the
secret itself is never transmitted. The relay sends a random challenge, each side signs it with
HMAC-SHA256, and only the signature crosses the wire. Both browsers and agents are checked the same
way, and the comparison is constant-time.

### Which sites the agent may touch

Off by default. Set none of the four variables above and nothing changes — no extra round-trip, no
refusals, exactly today's behaviour.

Set one and every page-acting tool is judged before it runs. A pattern is an origin with `*`
wildcards (`http://localhost:*`, `https://*.example.com`, or a bare host meaning any scheme):

```jsonc
"env": {
  "AUTOMATE_BROWSER_ALLOW_ORIGINS": "http://localhost:*, https://*.staging.example.com",
  "AUTOMATE_BROWSER_SENSITIVE_ORIGINS": "https://mail.example.com",
  "AUTOMATE_BROWSER_READ_ONLY": "1"
}
```

- A navigation is judged on **where it is going**; every other tool on **the tab it is on**, read from
  the browser at the moment of the call. Only a tool that genuinely takes a destination can be judged
  on an argument — `browser_navigate`, and `browser_perf_field_data`, which asks a public API about an
  address and drives no page at all. A `url` on anything else is a filter or a field the tool never
  declared, and it grants nothing: attaching `url` to a click does not move the click.
- A refusal names the origin and the variable that refused it, so the agent can say why it stopped.
- The tab that was checked is the tab that is driven. If the target changes between the check and the
  action — another call on the same server selecting a different browser — the call is refused with
  `ORIGIN_BLOCKED` and nothing is sent, rather than acting on a verdict about somewhere else. Retrying
  it is safe.
- Denied origins are also blocked at the **network** layer via `declarativeNetRequest`, because
  otherwise `browser_eval` on an allowed page could just `fetch()` them. Network matching is by
  **domain** — subdomains included, scheme and port ignored — which is deliberately broader than the
  tool gate.
- **Every browser you drive gets those rules, not just the first one.** They are installed before the
  first protected call on each browser, and again after that browser reconnects — a reconnect is the
  moment the server stops being able to prove the rules are still there, and one 2-second round-trip
  is cheaper than assuming. A browser that already has the current deny-list is not asked twice, so
  the cost is once per browser per connection, not once per call.
- **Several agents on one browser keep each other's blocks.** Each server's deny-list is stored
  against that server, and the browser blocks the **union** of all of them. Two IDEs with different
  lists therefore both get what they asked for, rather than the second one silently deleting the
  first one's rules. The honest cost: a browser shared with another agent blocks more than your own
  list names. If the combined lists exceed **500 domains** the install fails rather than landing
  half of them, and the tool gate carries on alone.
- **Read-only mode and the no-JavaScript switch are settled before any of that.** Neither depends on
  where the tab is, so neither waits for the page to be read — and neither can be skipped by the page
  failing to be read. Read-only holds when the lookup times out, when it answers with nonsense, and
  before any browser has connected at all.
- **An allow-list refuses an unknown location; a deny-list alone does not.** If the page's address
  cannot be read, "I could not tell where this was going" resolves to a refusal only when an
  allow-list says where it must be. With just a deny-list configured there is nothing to be outside
  of, so the call proceeds. That is deliberate, and it is why read-only is decided first.
- `browser_status` prints the active policy; the browser/tab-selection tools are never gated, or an
  agent being refused would have no way to ask why.

**What this does not do.** It decides which origins the agent may touch — never what it may do once
it is on one. An agent allowed onto a site can still do anything a logged-in user could do there.
Running its own JavaScript is the one exception, and only if you take it away with the switch below.
Read-only mode is keyed off each tool's own read-only annotation, so opening and closing tabs is
still permitted. And the network-layer half needs the rebuilt extension; without it the tool gate
still applies but `fetch()` from page JS does not.

### Forbidding JavaScript the agent wrote

Off by default. `AUTOMATE_BROWSER_NO_EVAL=1` refuses every call that would run source the agent
composed, and leaves everything else alone:

| Refused | Still works |
|---|---|
| `browser_eval` — both the `expression` and the `function` form | click, type, hover, drag, fill a form, upload |
| `browser_navigate {initScript}` — the rest of the same call is fine | snapshot, find, read text/HTML, screenshot, console, network |

That is the middle setting between full trust and read-only, and it is a different setting from
either. Read-only stops the agent *changing* anything; this stops it *running* anything, including a
read as harmless-looking as `browser_eval {expression:"document.title"}`. On a browser signed into a
bank, "you may click the buttons on this page, but you may not execute code in it" is the distinction
that matters, and until now there was no way to say it.

The refusal carries its own code, `EVAL_BLOCKED`, and names the variable and the fact that a person
set it — so an agent reports a policy rather than a bug, and reaches for a snapshot instead of
retrying. `browser_status` prints `no-eval` in its safety line.

**The honest limit — read this before relying on it.** This bars the two doors the *server* owns. It
is not a sandbox around the page:

- **Advanced mode is untouched.** With the debugger attached, tools that drive CDP still do what they
  do; this switch does not audit their internals, it refuses the two arguments that carry your
  agent's source.
- **It cannot stop the page's own JavaScript**, which runs on every page regardless. Nor
  `browser_page_tools`, which calls an action the page declared about itself — that is the page's
  script either way.
- **It is a server-side setting, not a browser one.** Another agent on the same relay with the
  variable unset is unaffected; the switch belongs to the MCP server you set it on. Set it in the
  same `env` block as the origin lists.
- **It costs zero tokens.** No schema changed, so a refused tool still advertises itself normally —
  an agent finds out by being refused, not by reading a shorter list.

### What the agent did: the action audit log

Every tool call appends one line to `~/.automate-browser/automate-browser-audit.log` (or wherever
`AUTOMATE_BROWSER_AUDIT_FILE` points): the tool, the browser and tab it targeted, the URL when there
was one, whether it succeeded, and how long it took. `browser_status` names the file and prints the
last few lines.

It is **on by default** because this server drives your real, logged-in browser: "what did it touch?"
has to be answerable *after* something looks wrong, not only if you predicted you would want to ask.
It is a local file and nothing is sent anywhere. `AUTOMATE_BROWSER_AUDIT=off` stops it.

Argument values that could be secrets — anything named like text, value, token, password, cookie,
headers — are recorded as a **length**, never a value. Everything else is truncated. The trail rotates
at 1 MB, keeping one predecessor.

It lives in `~/.automate-browser/`, **not** the OS temp directory. That is the whole point of the
rotation: a trail you can still read tomorrow. Temp directories get swept — on the machine this was
measured on, **2026-09-02, not one file in the temp folder was older than 24 hours** — so a log kept
there answers "what did it touch?" only for questions you ask the same day. The relay's own connection
log moved to the same folder for the same reason: `~/.automate-browser/automate-browser-relay.log`
records every `browser connected` and `browser removed` with a timestamp, which is what tells you
whether a browser that went quiet ever came back on its own.

`AUTOMATE_BROWSER_AUDIT_FILE` still points the audit trail anywhere you like. If the home directory
cannot be created, both logs fall back to the temp directory rather than writing nothing.

### Performance: this machine, and what real visitors get

`browser_perf_trace` records a trace and now **reports LCP / FCP / INP / CLS with a good /
needs-improvement / poor rating** instead of handing over a file; `{action:'analyze', filePath}`
re-reads a trace saved earlier without recording another. A metric the trace did not contain is
reported as missing, never as zero.

#### A hidden page is refused, not measured

Chrome reports no LCP for a page that loads while nobody can see it (a minimised window, or a
background tab). A trace with `reload` or `autoStop` on such a page used to attach the debugger,
reload, record — about 11 s on a real site in the plan 13 benchmark — and only then say the window
was not visible. It now asks the page first and refuses at once with `TAB_HIDDEN`, before attaching,
reloading or recording anything; the live check holds it under 1 s. `browser_switch_tab` brings the
tab forward (restoring a minimised window), after which the same call reports an LCP.

Limits: a manual `{action:'start'}` with no reload is NOT refused — long tasks need no paint, and
the agent may be driving the hidden page on purpose. A page that hides part-way through a recording
is not caught. Bringing the tab forward takes the user's screen, so an agent should ask first.

`browser_perf_field_data {url}` answers the other half — what real Chrome users experienced at p75 —
and touches no browser at all. It needs a free Chrome UX Report API key in `AUTOMATE_BROWSER_CRUX_KEY`
and is inert without one. **It sends the URL you ask about to Google's public CrUX API**, and
nothing else about you or the page goes with it. That is one of the only two outbound calls this
server ever makes; the other is the daily version check, which sends nothing at all.
→ [Finding out your copy is out of date](#finding-out-your-copy-is-out-of-date)

### Memory: is the page leaking?

`browser_perf_trace {action:'memory'}` samples `performance.memory.usedJSHeapSize` **every 500 ms**
across a window and reports the start, the end, every reading, and a **least-squares trend in MB/s**.
The trend is a fit rather than end-minus-start because the heap saws: one garbage collection
mid-window drops it a long way, and a genuinely leaking page can finish the window *lower* than it
started.

**The reply states the cadence it achieved, which is often not 500 ms.** Chrome throttles timers in a
tab it is not drawing to roughly once a second, and your tab is a background tab by default — so the
same window returns about half the samples. The trend is computed from the **real elapsed time** the
page measured, so the MB/s figure stays right either way; only the sample count changes.
`browser_switch_tab` is the one thing that changes it.

It is the one performance action that **needs no advanced mode** — no debugger attaches, no banner
appears — so it is safe to run against a tab a person is looking at. `durationMs` accepts
**1000-30000** (default **5000**) and an out-of-range value is **refused, not clamped**; for a longer
watch, call it again between your own interactions. The 500 ms interval is deliberately not an
argument: Chrome quantises the reading into coarse buckets, so sampling faster buys more points off
the same staircase, not more resolution.

**The honest limit, and the reply says it every time: a rising heap is not proof of a leak.** It may
be memory a collection has not reclaimed yet. And `performance.memory` is a **Chrome-family API** —
in Firefox or Safari the call fails and says so. It is verified working on **Chrome and Edge**.

**There is no heap-snapshot action, and there cannot be one.** It was built, and Chrome refused it:
`chrome.debugger` exposes a fixed allow-list of DevTools Protocol domains, and `HeapProfiler` is not
on it — the CPU `Profiler` is, the heap one is not. `Target.attachToTarget` inherits the same filter,
and no `chrome.*` API dumps a heap, so no extension can capture one by any route. To find out *what*
grew, open **DevTools → Memory** yourself, take two snapshots and use the comparison view. This server
tells you the heap is rising; a person still has to say why.

### Accessibility: a floor, not a pass

`browser_issues {audit:'a11y'}` runs **axe-core 4.13.0** against the page you are on and returns the
violations grouped by impact, **critical first**. Each rule reports the number of elements it matched,
up to **five examples** each, and a link to the rule's own fix guidance. The reply names the axe
version, so a report can be reproduced against the same rules later.

**Findings map back to snapshot refs.** Where an element already carries a ref from a
`browser_snapshot`, the finding shows it — so you can click, read or fix that exact element with any
other tool instead of parsing a CSS selector. Take the snapshot *first*: an audit run before any
snapshot has nothing to map to, and shows selectors alone. A missing ref never hides a finding.

**The honest limit, and the reply says it every time: automated rules catch roughly a third of real
accessibility barriers.** They check that attributes exist, not that they are *right* — nothing here
can tell you whether alt text describes the image, whether the focus order makes sense, or whether a
custom widget is actually operable by keyboard. A clean result means the automatable third found
nothing. It is a floor, not a pass, and "0 violations" is not an accessibility claim.

Rules axe cannot decide alone are **counted, not listed** — contrast over a background image, say. The
count appears at the end so you know how much was left undecided without the report filling up with
things that are probably fine.

Findings are **paged, 20 rules per page, worst first** (`limit` changes the page size), and the footer
names the exact next call. It
runs in the extension's isolated world, so it leaves nothing behind on the page and works on sites
whose content-security policy blocks injected script. No debugger, no banner. It adds about **151 KB**
to the packed extension, which is the whole cost.

### Driving a browser on another machine

The relay listens on `127.0.0.1` only. Set `AUTOMATE_BROWSER_RELAY_HOST` (with
`AUTOMATE_BROWSER_TOKEN`) and it binds that address instead, so a browser on a *different* computer
can connect — type that computer's address into the extension popup's "Editor on another computer"
field and set the same token there.

**A non-loopback bind without a token is refused, on both sides** — the relay will not listen and the
extension will not dial. `browser_status` warns whenever the relay is reachable beyond this machine.

### Proxy control (whole browser)

`browser_proxy` routes traffic through a proxy — `{mode:'fixed_servers', server:'host:port'}`,
`{mode:'pac_script', pacUrl:'…'}`, `direct`, `system`. Call it with no arguments to see what is in
force, and `{clear:true}` to hand the setting back.

> ⚠ **This affects the whole browser, not just the automated tab.** Chrome has no per-tab proxy, so
> the tabs you are working in are routed the same way until it is cleared. Every call that changes the
> setting says so in its reply, and a change another extension outranks is reported as *not applied*
> rather than as success.

## Skills that ship with it

The tools say what *can* be done; the skill says what to do with them. One skill —
**`automate-browser`** — ships inside the package. Its `SKILL.md` is the short part an agent always
reads: the tab-ownership rules, the standard loop, and an index telling it which reference to open
**at which lines**, so it never reads a whole file to answer one question.

**Installing it in Claude Code** (this repo is its own marketplace):

```bash
/plugin marketplace add farazpawle/automatebrowser
/plugin install automate-browser@automatebrowser
```

**That one install gives you both halves** — since `1.0.0` the plugin registers the MCP server itself
(pinned `npx @automatebrowser/mcp@1.0.0`, named `Claude` in the peer list) as well as shipping the
skill. Before that it carried the skill alone and the server still had to be configured by hand, which
meant most people got one half and never knew the other existed.

> **If you have already configured the server by hand, remove that entry first.** Installing the
> plugin on top of an existing `automatebrowser` entry runs the server **twice** in one client —
> duplicate `browser_*` tools and an agent that cannot tell which it is calling. One entry per
> client, always.

A local path also works in place of `farazpawle/automatebrowser` if you are developing against a
checkout.

**Any other agent, or no plugin system at all** — every
[release](https://github.com/farazpawle/automatebrowser/releases/latest) carries
[`automate-browser-skill.zip`](https://github.com/farazpawle/automatebrowser/releases/latest/download/automate-browser-skill.zip). Unzip it into the agent's skills folder (`~/.claude/skills/`
for Claude Code, or wherever your client looks); it unpacks to one `automate-browser/` folder. This
copies the skill only, so register the server as well.

Or from a shell: `claude plugin marketplace add /path/to/AutomateBrowser` then
`claude plugin install automate-browser@automatebrowser`. Verify a manifest change with
`claude plugin validate .`.

**Working inside this repository, the skill does not load** — and that is correct, not a fault. Claude
Code loads a plugin's skills only once the plugin is *installed*. A
checkout is the plugin's **source**, not an installed copy of it.

| Reference | For |
|---|---|
| `tabs-and-multi-agent` | Which tab an agent may drive, focus, cleanup on release, and sharing one browser with other agents |
| `page-interaction` | Refs rather than selectors, finding elements cheaply, filling a form in one call, waiting, stale refs |
| `reading-and-extraction` | Getting structured data out — which read tool is cheapest, extracting with a function, pagination, big results to a file |
| `sessions-and-state` | Working inside the user's existing session, cookies and storage, dialogs, uploads, and stopping cleanly for 2FA |
| `capture-and-diagnostics` | Screenshots (including background tabs), console logs, the issues feed, network, performance, advanced mode |
| `troubleshooting` | Nothing connected, calls that hang, actions that silently do nothing, and what each error code means |
| `tool-reference` | All 46 tools with their arguments and the gotcha for each |

**The tool tables inside `tool-reference` are generated from the server's own schemas**, and
`npm run docs:generate` fails if a tool exists with no entry — so the shipped guidance cannot quietly
fall behind the code. `npm run verify:release` additionally asserts the `SKILL.md` and all seven
references are actually inside the published tarball.

They live in [skills/](skills/).

## Development

```bash
npm run check            # the gate CI runs — every starred command below, plus `npm audit --omit=dev`
npm run contracts:check  # * assert the extension's generated command types still match the schemas
npm run typecheck        # * tsc --noEmit
npm run typecheck:tests  # * the same over tests/
npm run lint             # * eslint .
npm run format:check     # * prettier --check .
npm run test             # * the unit suite — 410 tests over 34 files (node:test via tsx)
npm run build            # * build dist/index.js + dist/relay.js + dist/cli.js (tsup)
npm run watch            # rebuild on change
npm run smoke            # * connection smoke test (isolated ports, fake browsers + controllers)
npm run inspector        # run the server under the MCP Inspector
npm run docs:generate    # * rewrite the generated tables and counts in README + the shipped skill
npm run verify:release   # * assert the version matches everywhere and the tarball carries every file
npm run tokens           # * measure what the advertised schemas cost per request (all three profiles; name one for its table)
npm run test:integration # drive a real Chrome (Puppeteer) through the live behaviours
npm run test:live        # the checks that used to say "needs a person" — real certs, real traces
npm run memory:relay     # profile the relay's heap across connection churn (its own CI job)
npm run eval             # score an agent against the scenarios in scripts/eval-scenarios.json

node scripts/incognito-check.mjs [--edge]   # private-browsing behaviour, both settings states
```

`check` is the one to run before committing. It fails on a type error, a build error, a version that
has drifted, a generated table that no longer matches the schemas, a broken connection path, or a
dependency advisory — the same set CI enforces, so a green `check` locally is a green CI run.

The extension is built separately from [Chrome-extension/](Chrome-extension/) (`npm run build`,
`npm run dev`, `npm run compile`). `src/` and `Chrome-extension/` are the sources of truth.

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the gates above,
the token budget every tool schema is charged against, and the two separate sets of skills. What
changed in each version is in [CHANGELOG.md](CHANGELOG.md). To report a vulnerability, do **not** open
a public issue; see [SECURITY.md](SECURITY.md).

### Watching the relay for leaks

Every process here dies with its client except one. The relay is a singleton that outlives every
editor and is meant to run for days, so it is the only place a slow leak is both plausible and
expensive. `npm run memory:relay` connects and disconnects waves of browsers and controllers, then
measures the relay's heap at the point where it is back to zero peers — a correct relay returns to
roughly where it started.

Measured on the 0.2.0 build: **0.25 MB of growth across 600 connections**, flat over the last five
waves. CI fails the run at 2 MB, eight times the worst observed figure. The honest limit is that this
watches the JS heap only, so a leak in native socket buffers would show up in RSS and could hide from
it.

### Troubleshooting

If tools return **"No connection to browser extension"**, check, in order: the extension popup shows
a green dot; only one relay is live on `9009–9013`; and the client points at `node dist/index.js`
(not a published npx package). Full triage:
[the troubleshooting reference](skills/automate-browser/references/troubleshooting.md).

## Privacy

The extension can read any page you point it at, so what it does with that is written down rather
than left to be inferred: [docs/privacy.html](docs/privacy.html) — served at
[farazpawle.github.io/automatebrowser/privacy.html](https://farazpawle.github.io/automatebrowser/privacy.html)
once Pages is on. The short version is that it collects nothing, sends nothing to us, and passes what
you ask for over a loopback connection to software on your own machine. Both extension stores require
this page before they will list an extension with these permissions.

## License

[Apache License 2.0](LICENSE). Contains portions © Microsoft Corporation and © Google Inc.
