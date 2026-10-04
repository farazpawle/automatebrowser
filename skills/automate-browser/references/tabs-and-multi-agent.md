# Tabs, ownership, and sharing a browser

## Contents

| Section | What it answers |
|---|---|
| [The one rule](#the-one-rule) | Which tab am I allowed to drive? |
| [Getting a tab](#getting-a-tab) | `new` vs `select` vs `switch` |
| [Focus](#focus-who-may-take-it) | What is allowed to interrupt the user |
| [Finishing](#finishing-what-gets-cleaned-up) | What `browser_release_client` closes |
| [Two agents, one browser](#two-agents-one-browser) | Claims, leases, `TAB_CLAIMED`, `LEASE_LOST` |
| [Several browsers](#several-browsers) | `browser_select_client` and friends |
| [Being a good neighbour](#being-a-good-neighbour) | The habits that keep you welcome |

---

## The one rule

**You drive a tab you own. Never the user's.**

A tab becomes yours in exactly two ways: you **opened** it, or you **adopted** it because the user
asked you to. There is no third way, and there is no fallback to "whatever tab is in front".

You do not have to do anything to get one. On your first action the server opens a background tab and
adopts it for you. It stays yours until you select another.

> **This changed on 2026-08-30, and older guidance says the opposite.** Previously, an agent with no
> explicit selection inherited the browser's *focused* tab — the one the user was reading. That meant
> "go and test this URL" could navigate away a tab holding unsaved work. If you have seen advice that
> says your target follows the user's focus, it is out of date.

## Getting a tab

| You want | Call | What happens |
|---|---|---|
| Somewhere to work | *nothing* | A background tab is opened and adopted on your first action |
| Somewhere to work, at a URL | `browser_new_tab { url }` | Opens **in the background**, adopted automatically |
| The tab the user already has open | `browser_select_tab { url \| title \| tabId \| index }` | Adopted where it sits, **not** brought forward |
| To show the user something | `browser_switch_tab { tabId \| index }` | Brings it to the front — **takes their focus** |
| To see the site logged OUT | `browser_new_tab { url, incognito: true }` | A **private window**, with none of the user's logins |

Prefer `url` or `title` over `index` when adopting. An index shifts every time any tab is opened or
closed; a URL substring does not.

```
browser_select_tab { url: "localhost:3000" }
```

### A logged-out tab, and the setting it needs

Every tab you drive is the user's real, signed-in profile, so "what does a first-time visitor see?"
is normally unanswerable without logging them out for real. `incognito: true` opens a private window
instead: a clean session with no cookies and no logins. It is the way to check a signup flow, a
paywall, a cookie banner, or anything that looks different to a stranger.

**It needs a one-off setting that only a person can turn on**, on the extension's own details page —
"Allow in Incognito" in Chrome, "Allow in InPrivate" in Edge. Without it the call fails with
`INCOGNITO_BLOCKED` and the message spells out where to click. **Ask the user to do it; do not retry.**
Turning it on restarts the extension, so the connection blinks.

Three things behave differently in a private tab, all of them measured rather than assumed:

- It is **claimed and released like any other tab**, and shows in `browser_list_tabs` marked
  `(private)`. Check that marker before you trust a session — a private tab that looks ordinary is how
  "why am I logged out?" starts.
- **Cookies are a separate jar.** `browser_get_cookies` and `browser_set_cookie` read and write the
  private tab's own jar, not the user's. A cookie you set in a private tab is gone when the window
  closes, and the user's real session is neither visible there nor at risk from it.
- **`localStorage` and `sessionStorage` are the private ones too**, so `browser_storage` sees an empty
  origin rather than the user's saved state.

Closing the tab ends the session. There is nothing to clean up, and nothing survives.

## Focus: who may take it

`browser_switch_tab` is the **only** tool that moves the user's focus, and `browser_new_tab { active:
true }` is the only argument that does. Both are for one situation: the user asked to be *shown*
something.

`browser_switch_tab` restores a **minimised** window before focusing it, then ends its reply with what
the page reports: `— the page is visible`, or `— but the page is still hidden` (Windows kept the
window behind others, or it is covered or on another desktop). Read that ending before a step that
needs a drawn page — a real click, a trace. No ending means it could not be asked (a settings page).

Everything else — navigating, clicking, typing, reading, snapshotting, screenshotting — runs on a
background tab without disturbing them. Assume the user is working in another window the entire time
you are running, because they usually are.

## Finishing: what gets cleaned up

`browser_release_client` frees the browser for other agents **and closes every tab you opened**. A tab
you *adopted* from the user is left exactly where it was.

That asymmetry is deliberate and enforced in the server, not a convention you have to remember.
Closing a tab the user handed you would lose their work just as surely as navigating it away.

Three honest limits:

- Cleanup happens on an **explicit** release. If the editor simply exits, the tab you opened is left
  behind. Call `browser_release_client` when you are genuinely finished.
- Nothing cleans up a tab you adopted. That is the user's tab and stays their business.
- Cleanup only ever goes to the browser that owns the tabs. If that browser has disconnected, or quits
  part-way through the sweep, the rest stay on its books and the next release closes them. So a release
  can legitimately close nothing and still report success — that is not a fault, and those tabs are
  not forgotten.

**If one of your tabs survives a release while its browser stayed connected throughout, say so.**
That should not happen. Until
2026-09-02 it did, and silently: the extension reconnecting mid-session (the user reloading it, or its
background worker being evicted and revived) gave the browser a new identity, and the list of tabs you
had opened was filed under the old one. Release closed nothing. Ownership now follows the extension's
own stored id, which a reconnect does not change. Worth knowing because the failure leaves no error —
the release reports success and the tabs simply stay.

## Two agents, one browser

Every editor's server connects to one shared relay, so **every agent sees every browser**. Ownership
is per **tab**: two agents drive two tabs of the same browser concurrently, and only same-tab access
is serialised. Driving takes a soft lease of about a minute, renewed by each action and released on
idle, on disconnect, or on `browser_release_client`. *Selecting* a tab does not claim it — only
acting does.

Because each agent now opens its own tab, two agents that select nothing **cannot** collide. A
conflict means you deliberately aimed at the same tab.

**`TAB_CLAIMED` — someone else is driving that tab.** The message names them. In order of politeness:

1. Work somewhere else — `browser_select_tab { url: "the thing you were sent for" }`, or just open a
   new tab.
2. `browser_force_claim` — only when that exact tab is the point of the task. The other agent is told
   immediately, mid-task.

**`LEASE_LOST` — you were the one displaced.** It arrives as a notice on your next result, whatever
tool that was, and names the tab and who took it. Stop: your refs belong to a page you no longer
control. Pick another tab, or take it back if the task demands it.

## Several browsers

Tools refuse with a list rather than guessing which browser you meant. Choose once:

```
browser_select_client { browser: "chrome" }     // or { label: "..." } or { id: "..." }
```

It sticks for your session only and does not change what other agents see. `browser_force_claim` is
the same selector plus a steal, and takes the **whole browser** — it is the only thing that still
does, now that a drive always names its tab.

`browser_status` is the one call that explains the rest: which relay you are on and whether its
version matches yours, your own agent name, every connected browser with its live tab and driver, and
every other agent connected. Call it before guessing.

## Being a good neighbour

- **Never drive the user's real, logged-in tabs while testing.** You now get a throwaway tab by
  default — do not go out of your way to defeat that.
- **Do not close tabs you did not open.** The server enforces this on release; do not undo it by
  calling `browser_close_tab` on a tab you adopted.
- **Release when you are done** with a browser others may want.
- **Take a name.** `AUTOMATE_BROWSER_CLIENT_NAME` is what a human sees in the extension popup and
  what other agents see in a claim error. `mcp-12345` tells nobody anything.
