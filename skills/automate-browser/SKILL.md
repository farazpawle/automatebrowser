---
name: automate-browser
description: >
  Drive the user's real, logged-in browser with AutomateBrowser — tab ownership, clicking and
  filling, extraction, sessions, screenshots and diagnostics, across all 46 tools.
  Read lines 11-24 of SKILL.md first to confirm scope.
---

# AutomateBrowser

## Scope Gate — Read First (Lines 11-24)

**This skill IS for:**
- Driving the user's real browser: navigating, clicking, filling, reading, extracting
- Choosing the right tool, and the right tab, out of the 46 tools this server serves
- Diagnosing a call that failed, did nothing, or collided with another agent

**This skill is NOT for:**
- Building or debugging AutomateBrowser itself — that is the maintainer skills, not this one
- Any other browser automation (Playwright, Puppeteer, chrome-devtools-mcp)

**Matches → keep reading. No match → stop.**

---

## Golden rules

1. **Your tab is one you own — never the user's.** You either opened it or adopted it because you
   were asked to. On your first action you are given a background tab automatically. There is no
   fallback to "whatever tab is in front", and you must not build one.
2. **Fresh work goes in a background tab.** That is the default; you do not have to ask for it.
3. **To pick up work already in progress**, adopt it explicitly:
   `browser_select_tab { url: "localhost:3000" }` — or by `title`. It is driven where it sits.
4. **Only `browser_switch_tab` takes the user's focus.** Use it when, and only when, they asked to be
   *shown* something. Same for `browser_new_tab { active: true }`.
5. **Address elements by `ref`, never a raw CSS selector.** Refs come from `browser_snapshot` or the
   much cheaper `browser_find`, and every interaction wants a human-readable `element` description
   alongside the ref.
6. **Release when you finish.** `browser_release_client` closes the tabs **you opened** and leaves
   any tab you adopted from the user exactly where it was.
7. **You are acting as the user.** Their logins, their address, their accounts. Respect rate limits
   and terms of use, never type credentials you were not given, and leave their session as you found
   it.

## The standard loop

```
adopt a tab   →  browser_select_tab   (only to take over something the user has open)
navigate      →  browser_navigate { url }          ← already returns a snapshot with refs
survey        →  browser_find { text: "..." }      ← only when you did NOT just navigate
act           →  browser_click / browser_type / browser_fill_form   (on refs)
verify        →  browser_read_page, or include: "snapshot" on click / type
```

**Do not call `browser_find` straight after `browser_navigate`.** Navigation returns a full snapshot by
default — the refs you need are already in that reply, so a survey call there is a wasted round-trip.
Survey when you have arrived some other way, or when the page has changed under you.

Two habits that save most of the remaining round-trips:

- **`include: "snapshot"`** on click or type returns the fresh page in the same reply. (Navigation
  does it for you; interactions do not, because most of them do not change the page enough to matter.)
- **`browser_fill_form`** fills every field at once. Never click-and-type field by field.

When something silently does nothing, `browser_issues` is the tool that sees it — CSP blocks, dropped
third-party cookies, CORS — none of which produce a console error.

## Section index

Open the reference you need, at the lines you need. Do not read a whole file to answer one question.

<details><summary>references/tabs-and-multi-agent.md (156 lines) — which tab am I allowed to drive?</summary>

| Section | Lines |
|---|---|
| The one rule | 17-31 |
| Getting a tab — `new` vs `select` vs `switch` | 32-48 |
| A logged-out tab, and the setting it needs | 49-73 |
| Focus: who may take it | 74-83 |
| Finishing: what gets cleaned up | 84-109 |
| Two agents, one browser — claims, `TAB_CLAIMED`, `LEASE_LOST` | 110-131 |
| Several browsers | 132-147 |
| Being a good neighbour | 148-156 |

</details>

<details><summary>references/page-interaction.md (237 lines) — clicking, typing, waiting</summary>

| Section | Lines |
|---|---|
| Refs, not selectors | 18-30 |
| Finding an element cheaply | 31-50 |
| The interaction tools | 51-63 |
| Filling a form in one call | 64-107 |
| Clicking what a snapshot cannot name | 108-120 |
| Waiting for the page to catch up | 121-136 |
| The defaults includeSnapshot / waitUntil / settleMs already have | 137-152 |
| Reading a navigation's settled | 153-172 |
| When a navigation did not happen at all | 173-189 |
| Actionability: why a click refuses | 190-211 |
| When a ref goes stale | 212-237 |

</details>

<details><summary>references/reading-and-extraction.md (113 lines) — getting data out</summary>

| Section | Lines |
|---|---|
| Pick the cheapest tool that answers the question | 16-28 |
| The extraction loop | 29-39 |
| Extract with a function, not an expression | 40-64 |
| Big results go to a file | 65-81 |
| Pagination | 82-99 |
| What will bite you | 100-113 |

</details>

<details><summary>references/sessions-and-state.md (186 lines) — logins, cookies, dialogs, files</summary>

| Section | Lines |
|---|---|
| Start from "already signed in" | 19-32 |
| Never type credentials you were not given | 33-37 |
| 2FA, CAPTCHA and consent screens | 38-52 |
| Cookies and storage | 53-77 |
| Dialogs | 78-92 |
| Uploads and downloads | 93-105 |
| Restricted pages | 106-110 |
| When something works signed in and fails signed out | 111-120 |
| **Recipe** — a session that will not stick, in six calls | 121-182 |
| Leave the session as you found it | 183-186 |

</details>

<details><summary>references/capture-and-diagnostics.md (486 lines) — screenshots, logs, network, speed, recipes</summary>

| Section | Lines |
|---|---|
| Screenshots — incl. what a picture costs, the size ceiling and `ref` crops | 24-84 |
| A strip of stills — several frames on a timer | 85-114 |
| Screenshotting a tab the user is not looking at | 115-148 |
| Console logs — incl. paging | 149-162 |
| The issues feed: failures with no console error | 163-176 |
| Accessibility: a floor, not a pass | 177-205 |
| Network — incl. paging | 206-217 |
| The footers on every action | 218-237 |
| Performance — incl. the LCP breakdown and render-blocking list | 238-264 |
| Memory: is this page leaking? | 265-302 |
| Emulation | 303-311 |
| Advanced mode, and what it costs — incl. why there is NO certificate bypass | 312-369 |
| **Recipe** — "this page is slow", cheapest evidence first | 370-438 |
| **Recipe** — auditing a page for accessibility | 439-486 |

</details>

<details><summary>references/troubleshooting.md (136 lines) — when it will not drive the browser</summary>

| Section | Lines |
|---|---|
| Always start here — `browser_status` | 17-28 |
| The `link:` line — whether it is coming back | 29-45 |
| "No connection to browser extension" | 46-77 |
| A call that hangs, then times out | 78-83 |
| An action reports success but nothing happened | 84-93 |
| It acted on the wrong tab | 94-105 |
| The error codes | 106-126 |
| Three things that are not faults | 127-136 |

</details>

<details><summary>references/tool-reference.md (236 lines) — all 46 tools, arguments and gotchas</summary>

| Section | Lines |
|---|---|
| The tools — generated from the live schemas, grouped | 18-126 |
| Arguments and gotchas — hand-written, one row per tool | 127-236 |

The tables are regenerated by `npm run docs:generate` and the build fails if a tool exists with no
entry, so this list cannot fall behind the server.

</details>
