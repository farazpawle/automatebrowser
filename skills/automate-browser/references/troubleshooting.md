# When it will not drive the browser

## Contents

| Section | What it answers |
|---|---|
| [Always start here](#always-start-here) | The one call that explains most of this page |
| [No connection](#no-connection-to-browser-extension) | Nothing connected, empty browser list |
| [A call that hangs](#a-call-that-hangs-then-times-out) | Timeouts |
| [Success but nothing happened](#an-action-reports-success-but-nothing-happened) | Silent failures |
| [Wrong tab](#it-acted-on-the-wrong-tab) | Targeting |
| [Error codes](#the-error-codes) | What each means and the tool that fixes it |
| [Not faults](#three-things-that-are-not-faults) | Expected behaviour that looks broken |

---

## Always start here

```
browser_status
```

One round-trip, and it answers most of this page: whether you are on the relay and whether its version
matches yours, which browsers are connected, which tab each is on, who is driving them, your own agent
name, and whether an old self-hosting server is squatting the port and hiding browsers.

Call it before guessing. Call it whenever a claim error names an agent you did not expect.

### The `link:` line — whether it is coming back

Its second line begins `link:` and the first word is the state, in capitals. Read that before you
read anything else on this page, because it decides whether waiting is the right move at all:

| Line starts | Meaning | Do |
|---|---|---|
| `link: CONNECTED` | on the relay, with a browser | carry on |
| `link: WAITING` | on the relay, **no browser has joined** | ask the user to open a browser with the extension — the server is fine, and nothing on this page applies |
| `link: RETRYING` | reconnecting on its own; the line gives the attempt count, the countdown and the last failure | wait and retry the call — do not restart anything |
| `link: CONNECTING` | first connect in flight | wait |
| `link: STOPPED` | shutting down, **nothing is being retried** | stop waiting; this needs the server restarted |

`WAITING` and `STOPPED` are the two that look like a broken tool and are not. `WAITING` means the
half that is missing is a browser, not the connection. `STOPPED` is the only state where waiting is
always wrong.

## "No connection to browser extension"

In the order worth trying:

1. **Is the extension loaded and enabled?** Open the browser's extensions page. After an update that
   added permissions, the browser **disables it until the user re-approves** — the single most common
   cause after an upgrade, and it looks exactly like a crash.
2. **Is it asleep?** The extension's background worker is evicted after about 30 seconds idle. It is
   built to revive itself — a repeating alarm plus the browser's own startup hooks — and **opening
   the extension's popup wakes it instantly**.
   **Do not assume it always revives.** Measured 2026-09-01: after an idle spell a call failed
   *immediately* with "No connection to browser extension", and `browser_status` then reported no
   browsers at all across five calls spanning several minutes, against a relay that was up and
   healthy the whole time. It came back only when a person clicked the extension icon.
   So: **retry two or three times across about a minute.** If `browser_status` still lists no
   browser, stop and tell the user to click the AutomateBrowser icon in their toolbar, or reload the
   extension. Retrying past that point cannot help — nothing an agent can call reaches a worker that
   is not running.
   **Say what happened, with times.** The relay writes `~/.automate-browser/automate-browser-relay.log`,
   one timestamped line per `browser connected` / `browser removed`. If you can read files, the tail of
   it says exactly when the browser dropped and whether it ever returned by itself — which is the
   difference between "asleep and slow" and a fault worth reporting. It lived in the temp directory
   until 2026-09-02, where it was swept daily, so older sessions have no history to read.
3. **Is the tab a normal page?** `chrome://`, the extension store and PDF viewer pages refuse
   automation entirely — `RESTRICTED_PAGE`. Open an ordinary `http(s)` page.
4. **Version mismatch.** If `browser_status` warns the relay is a different build: the first editor to
   start owns the shared relay. Killing that editor alone does not help — the next one respawns
   whichever build asks first. Point every editor at the same build, close them all so the relay exits
   on its own, then reopen.

This is a user-visible situation. Say which of the four you think it is rather than retrying silently.

## A call that hangs, then times out

Almost always a **dialog**. An `alert`, `confirm`, `prompt` or a "Leave site?" prompt freezes the
page, so anything injected into it never runs and the call waits out its whole budget.
`browser_handle_dialog` clears it. Tools that touch the page name this cause in the timeout message.
If instead the tab **started loading a new page** during the call, the message says that and names
the page: the action most likely landed. Take a snapshot before repeating it.

## An action reports success but nothing happened

The action landed on the wrong thing, or the page refused it silently. In order of cost:

- `browser_click { ..., include: "console, network" }` — the new console lines and the request log come
  back with the click itself.
- `browser_issues` — the **only** tool that sees failures producing no console error at all: blocked
  content-security policy, dropped third-party cookies, mixed content, CORS.
- A fresh `browser_snapshot`. If the page re-rendered, your ref pointed somewhere else.

## It acted on the wrong tab

You drive a tab you own — one you opened, or one you adopted. If an action landed somewhere
unexpected, name your target explicitly:

```
browser_select_tab { url: "localhost:3000" }
```

Prefer a `url` or `title` substring over an `index`, which shifts whenever any tab opens or closes.
See [tabs-and-multi-agent.md](tabs-and-multi-agent.md) for the full ownership model.

## The error codes

| Code | Meaning | Do this |
|---|---|---|
| `NO_BROWSER` | Nothing connected, or the link dropped mid-call | The list above. Retryable **unless** the message says the action **may have taken effect** — that means the request went out and the reply was lost, so check the page with `browser_snapshot` before repeating anything that changes it |
| `TAB_CLAIMED` | Another agent is driving that tab | Use another tab, or `browser_force_claim` |
| `LEASE_LOST` | You were displaced mid-task | Stop; your refs are stale. Pick a tab again |
| `TAB_GONE` | The tab closed, or none could be opened | `browser_list_tabs`, then `browser_select_tab` |
| `STALE_REF` | The page re-rendered under you | `browser_snapshot`, then reuse the new ref |
| `BAD_ARGS` | The arguments could not be understood, so **nothing ran** | Fix the call and send it again. The commonest cause is refs from two different frames in one call, or a half-written `f3:` prefix — see [page-interaction](./page-interaction.md) |
| `NOT_ACTIONABLE` | Hidden, disabled, moving, or covered | The message names the failing check and what covered it |
| `RESTRICTED_PAGE` | Browser settings page (`chrome://`, `edge://`), store or PDF viewer — not a closed tab | Ask the person to look at it, or open a normal page |
| `NAVIGATION_FAILED` | The page did not load: Chrome showed its own error page (the message carries Chrome's `net::ERR_…` and the url that failed) — or a tool hit that error page later | **Do not read or click on**; nothing is there. Check the url, or try again later if the site is down. If the message says Chrome **upgraded http to https**, only a person can allow the http site in Chrome |
| `ADVANCED_MODE_REQUIRED` | Needs the debugger | `browser_advanced_mode { enable: true }` |
| `CAPTURE_STALLED` | Chrome stopped drawing a tab nobody is looking at, so the screenshot got no frame | **Just call it again** — this one is marked retryable, and a repeat usually works. `browser_switch_tab` always captures, at the cost of the user's focus |
| `TAB_HIDDEN` | Chrome is not drawing the tab (minimised window or background tab): real input would be discarded and a page load reports no LCP, so a trusted click / key / hover or a `reload`/`autoStop` trace refuses up front | `browser_switch_tab` restores the window — it takes the user's screen, so **ask first**. For click / key / hover, turning advanced mode off uses synthetic input, which works hidden |
| `ORIGIN_BLOCKED` / `READ_ONLY` | A safety setting refused it — or, for `ORIGIN_BLOCKED` alone, the tab moved between the check and the action | `browser_status` prints the policy; a refusal it explains is the operator's choice, not a bug. A message saying the target **moved between the safety check and the action** is the other case: nothing was sent, so call it again |
| `EVAL_BLOCKED` | Running JavaScript you wrote is switched off for this server | **Do not retry, and do not look for another way in — there isn't one.** Read the page with `browser_snapshot`, `browser_find` or `browser_read_page` instead, and drive it by clicking. Only `browser_eval` and `browser_navigate`'s `initScript` are refused; everything else works normally |
| `USER_SCRIPTS_DISABLED` | `browser_eval` runs through Chrome's user-scripts feature, and the browser's **Allow User Scripts** switch for this extension is off | **Do not retry — only a person can fix it.** Tell the user: `chrome://extensions` → **Details** on AutomateBrowser → turn on **Allow User Scripts** (before Chrome 138: **Developer mode**). Meanwhile read with `browser_snapshot` or `browser_find`; every other tool works |
| `CSP_BLOCKED`, `CORS_BLOCKED`, `MIXED_CONTENT`, `THIRD_PARTY_COOKIE_BLOCKED`, `DEPRECATED_API` | Browser-detected issues | Surfaced by `browser_issues`; these are page bugs, not tool bugs |

Every code arrives as `CODE: message`, with a `Recover: call <tool>` line when there is a next step.
**Read the code, not the prose** — the prose may be reworded, the code will not.

## Three things that are not faults

- **A slow first call after idle** is the background worker waking up. Expected — *as long as it
  then works*. A first call that fails, and keeps failing, is a real fault and not patience owed;
  see "No connection to browser extension" above for how long to keep trying.
- **A "being debugged" banner** appears while advanced mode is attached, for a full-page screenshot,
  or for a screenshot of a background tab. It detaches again afterwards. See
  [capture-and-diagnostics.md](capture-and-diagnostics.md).
- **A new background tab appearing on your first action** is the server giving you a tab of your own,
  so you never drive the user's. That is the design, not a stray tab.
