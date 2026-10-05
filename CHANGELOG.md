# Changelog

Notable changes to `@automatebrowser/mcp`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**`1.0.1` is the current release.** `1.0.0`, on 2026-09-19, was the first published to npm under
this name — take `1.0.1` over it: a freshly built extension cannot connect to `1.0.0` at all.
`0.2.0` and `0.3.0` were cut the same way, on 2026-08-26 and 2026-09-17, and held; `0.3.0` reached
npm on the day of the `1.0.0` release and was withdrawn within the hour. Its tag stays in the
repository because the cut was real. Every version before those belongs to `@browsermcp/mcp`, the
project this one was extracted from. That lineage is kept below rather than hidden, because an
installed copy that predates the rebrand is still out there and its users need somewhere to see
what changed.

Dates are the date of the work, not of a release.

## [Unreleased]

`1.0.1` was published on 2026-09-21, and work after it lands here.

### Added

- **Release downloads.** Every GitHub release now carries two files: `automatebrowser.mcpb` for a
  one-click Claude Desktop install, and `automate-browser-skill.zip`, the agent skill for any agent's
  skills folder. `1.0.1` got them too. The names carry no version, so
  `releases/latest/download/<name>` always fetches the newest. The browser extension is still a
  separate install.
- **Download section on the website.** A Download menu item, a hero button and a section that
  downloads both files in one click, and points to the extension setup.

## [1.0.1] — 2026-09-21

A connection fix, and the extension stops wearing someone else's name badge. Anyone on `1.0.0`
should take this: with a freshly built extension, `1.0.0` will not connect at all.

### Fixed

- **The server refused the extension.** The relay accepted a websocket only from ONE hard-coded
  `chrome-extension://` id — the id the extension's manifest `key` forced. With that key removed
  (below), the extension's id is random per profile, so `1.0.0` turns its own extension away with
  a 403 and nothing visible to explain it. The default is now the `chrome-extension://` **scheme**,
  which is what the check was always really for: a malicious web page dialling
  `ws://127.0.0.1:9009` sends an `http(s)` Origin and is still refused. Pin exact origins with
  `AUTOMATE_BROWSER_EXTENSION_ORIGINS` if you want the old behaviour. **This boundary had no test
  at all**; it has one now.

### Changed

- **`browser_eval` needs Chrome's "Allow User Scripts" switch, once.** Your code now runs through
  Chrome's user-scripts feature instead of `eval`: the Chrome Web Store allows an extension to run
  code it did not ship only that way, and names `eval` of a supplied string as a violation. Turn it
  on at `chrome://extensions` → **Details** on AutomateBrowser → **Allow User Scripts** (before
  Chrome 138: **Developer mode**). Until then `browser_eval` refuses with the new code
  `USER_SCRIPTS_DISABLED` and runs nothing; every other tool is unaffected. The extension gains the
  `userScripts` permission, so Chrome asks you to re-approve it after updating.
- **The extension has its own identity.** Its manifest carried a `key` pinning
  `bjfgambnhccakkhmkepdoekmckoijdlc` — a live Chrome Web Store listing owned by browsermcp.io, the
  project this was forked from, and its public key, not ours. It is gone. **An already side-loaded
  copy will not update; a rebuild appears as a second card, so remove the old one.**
- **The extension is named `AutomateBrowser`**, not "AutomateBrowser - Automate your browser using
  VS Code, Cursor, Claude, and more" — a tail identical to that listing's, which both stores treat
  as a confusingly similar listing. It gained a real one-line description in place of an internal
  engineering note.
- **`externally_connectable` removed.** It named a domain this project does not own, for an
  `onMessageExternal` handler that does not exist anywhere in the extension.

### Added

- **One install now delivers both halves in Claude Code.** The plugin registers the MCP server
  itself, so `/plugin install` brings the 46 tools AND the `automate-browser` skill. It shipped the
  skill alone before, and the server had to be configured separately — so most people got one half
  and never learned the other existed. Remove any hand-written entry first, or the server runs
  twice in one client.
- **A privacy policy**, and the full text of both extension store submissions, in `docs/`.

## [1.0.0] — 2026-09-19

The first release published to npm. This is the bulk of the current product, substantially more than
`[0.2.0]` contains, so it is this section and not that one that describes what a user actually
receives. `[0.2.0]` stays rather than being absorbed, because it names a real cut that the link block
below points at.

**Numbered `1.0.0`, not `0.3.0`.** The same content went up as `0.3.0` first and was withdrawn within
the hour. `0.x` was chosen in September on the grounds that stages were still being added; that
reasoning expired once the product was complete, gated and documented, and a first public release is
a statement about the interface being committed to rather than about how much work remains.

### Added

- **A terminal client.** `automate-browser` drives the same browser from a shell, joining the same
  relay mesh as any connected editor.
- **Performance answers, not just numbers.** Core Web Vitals (LCP, FCP, CLS, INP) rated against
  Google's thresholds, the long tasks that blocked the main thread, a breakdown of where the LCP time
  actually went, and re-analysis of a saved trace with no browser attached. Field data from real
  visitors where an API key is supplied.
- **A JS heap sampler** that reports the trend over a window, with no debugger and no banner.
- **Cross-origin iframes** can be driven without the debugger.
- **`browser_eval` takes a function plus element refs**, so a script can act on elements already
  found rather than re-querying the DOM.
- **`browser_emulate`** — location, user agent, extra headers, colour scheme and a responsive set.
- **`browser_downloads`**, **`browser_issues`**, element and WebP screenshots, coordinate clicking
  for targets no ref can address, and a strip of stills for showing a person what happened.
- **`include`** attaches the fresh console or network state to the same reply as the action, removing
  a round-trip after every navigation.
- **A structured error taxonomy** — codes, recovery hints and a retryable flag, delivered both as
  prose and as `structuredContent`.
- **An action audit log**, with secrets redacted before they are written.
- **Origin allow/deny lists**, a sensitive-value tier, and a read-only mode.
- **A remote browser** on another machine, and whole-browser proxy control.
- **A shipped agent skill** with seven references, installable as a plugin, plus the manifests that
  make it discoverable.
- **A landing page** and an out-of-date-install check.
- **A file-path sandbox** over the client's MCP roots, a pre-flight on write targets so a bad path
  fails before the work rather than after it, and `AUTOMATE_BROWSER_WORKSPACE` for the many clients
  that send no roots at all.
- **An opt-in switch to forbid agent-written JavaScript** entirely.
- **A ceiling on inline screenshot size**, so a high-density display does not silently cost three
  times the context for the same picture.
- **The first unit suite** — no browser, no relay, no model — and a real-Chrome integration suite.
- **A memory profile of the relay** in CI. It is the one process meant to outlive its clients, and
  nothing watched it before.
- **Recovery is visible rather than inferred.** When the connection to the browser drops and comes
  back, the existing diagnostics say so, instead of leaving an agent to work it out from a failure.
- **A real-browser regression suite that runs on two browsers**, covering two profiles driven at
  once, actions two frames deep, and partial form fills — with every failure reporting the scenario,
  the page, the browser and the two commands that reproduce it.
- **The extension's command definitions are generated from the server's schemas**, so the two halves
  of the wire protocol can no longer drift apart without a gate noticing.

### Changed

- **The tool list costs 9,435 tokens per request instead of 10,469 — 9.9% less, with nothing
  removed.** Every MCP client re-sends every tool schema on every message, so this is the one cost a
  user pays for doing nothing. Measured across 348 real Claude Code sessions and 89,258 model turns it
  came to **934 million tokens, 80% of everything this server has ever cost a context** — 92 million of
  it in 36 sessions that never called a browser tool at all. Two cuts, neither touching a tool, a
  parameter or a validation rule: the `$schema` dialect key that `zod-to-json-schema` stamps on all 46
  input and 9 output schemas and the protocol never reads (770 tokens, stripped at the wire by
  `wireSchema`), and three parameter descriptions that were being restated on up to six tools each —
  `includeSnapshot` cost 29 tokens six times over. Those explanations moved to the shipped skill's
  `page-interaction` reference, read once per **task** rather than once per **turn**. Profile ceilings
  in `scripts/count-tokens.mjs` were lowered to match, the first time they have ever moved down:
  full 9,580, core 4,210, slim 1,855.
- **`browser_screenshot` now says what a picture costs**, because the same scan found screenshots to be
  **half** this server's footprint on a heavy browser day: 249 inline captures averaging ~1,531 tokens
  each, and an MCP result is re-read on every later turn until the session ends. Only 20 of 445
  captures scoped themselves to one element. The tool's description and the skill's
  `capture-and-diagnostics` reference now point at `ref` for a single element, and at `browser_eval` /
  `browser_find` for a value that needs no picture at all. Deliberately spent 30 of the tokens saved
  above to say it.
- **The agent drives only a tab it owns**, and works in the background. It no longer takes over
  whatever tab the user happens to be looking at.
- **Element refs survive a re-render**, via stable signatures rather than positional indexes.
- **Interactions wait for the element to be ready** and for the DOM to settle afterwards.
- **Transient failures retry automatically**, gated on whether the tool is idempotent.
- **Five outcomes are told apart, instead of being squeezed through one error flag.** A form fill
  that lands two fields of three now reports itself as partial rather than as a clean success, and a
  reply lost on the way back is no longer advertised as safe to retry — for a click, that advice was
  "click twice". The audit log records which of the five actually happened.
- **Cookie, storage and header values are redacted by default**; ask for them explicitly.
- **The console and network lists are paged**, newest first.
- Snapshots can be lean, full, or written to a file.

### Fixed

- A reconnecting extension no longer orphans the agent's tabs.
- Background screenshot captures no longer hang; a stall is bounded and named.
- Advanced mode no longer reshapes a click, and a trusted Enter submits forms.
- Uncaught page errors keep their stacks.
- The network log survives a service-worker eviction.
- Two long-lived logs moved out of the swept temp directory.
- Dependency advisories pinned so `npm audit --omit=dev` passes.
- Retrying an action can no longer land on a different browser or a different tab than the one it
  started against.
- Passing an address to a tool no longer sidesteps the page restrictions that were meant to judge it.
- A failed address check no longer skips read-only protection entirely.
- Invalid response options are rejected **before** the action runs, not after it has already happened.
- Network restrictions reach every connected browser, not only the first one to connect.
- One failed reconnection attempt no longer ends automatic recovery for the rest of the session.
- Element references from different embedded pages no longer resolve against the wrong page, and a
  form fill or clear aimed at an embedded page reaches it rather than the page around it.
- A doubly-nested frame is no longer listed twice under a reference that does not work.
- Reloading a page now waits for the new document rather than reporting the one it replaced.
- Setting a radio button to "false" no longer switches it on.
- The schema size budget is enforced for **every** tool profile. It had been measuring only the
  default one, so two of the three had been quietly over their ceiling for two weeks.

### Removed

- **`acceptInsecureCerts`.** It never worked on any build — Chrome does not expose the certificate
  domain to extensions — so it could only ever return an error, charged against every request in
  every editor. Passing it now fails by name rather than being quietly ignored, and says what to do
  instead: start the browser with `--ignore-certificate-errors`, or click through the warning page
  once, which is remembered for that host for the session. Everything else works against such a site
  normally either way.

## [0.2.0] — 2026-08-26

Cut and verified, **not published**. The first version under the AutomateBrowser name.

### Added

- **A singleton relay.** One process owns the port; every editor connects to it as a controller, so
  several editors share one browser instead of fighting over a port.
- **Per-tab ownership** — two editors can drive two tabs of the same browser at once, with soft-claim
  leases, lease-loss notifications and a roster in the extension popup.
- **A debugger-free extension**, rewritten with an always-on connection, so the yellow automation
  banner is gone for everything but the opt-in CDP features.
- **Tool profiles** (`full`, `core`, `slim`) behind a registry, a per-call timeout, a per-controller
  send queue, and a console-error footer on mutating calls.
- **A tool-schema token budget** and a release verification gate, both enforced in CI.
- **A generated tool reference** in the README, written from the live schemas.
- **Auto-recovery** when the extension's service worker is asleep.
- A warning when the relay is a different build from the server talking to it.

### Changed

- Renamed from `@browsermcp/mcp` to `@automatebrowser/mcp`; de-branded throughout.

## [0.1.3] — 2025-04-25

The last release of `@browsermcp/mcp`, the upstream project this was extracted from, published to npm
under that name. `0.1.0` through `0.1.2` precede it; this repository begins at the point the server
was extracted from that monorepo on 2025-03-27, and no history before that is reproduced here.

[Unreleased]: https://github.com/farazpawle/automatebrowser/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/farazpawle/automatebrowser/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/farazpawle/automatebrowser/compare/cf28a4b...v1.0.0
[0.2.0]: https://github.com/farazpawle/automatebrowser/commit/cf28a4b
