# Screenshots, logs and diagnostics

## Contents

| Section | What it answers |
|---|---|
| [Screenshots](#screenshots) | Viewport, full page, one element, to a file |
| [A strip of stills](#a-strip-of-stills-when-one-picture-is-not-enough) | Several frames on a timer, and how fast they really are |
| [Background tabs and the banner](#screenshotting-a-tab-the-user-is-not-looking-at) | Why a banner sometimes appears |
| [Console logs](#console-logs) | What the page printed, including before you arrived |
| [The issues feed](#the-issues-feed-the-failures-with-no-console-error) | Failures that produce no console error |
| [Accessibility](#accessibility-a-floor-not-a-pass) | Auditing the page, and what an audit cannot tell you |
| [Network](#network) | The request list, and one request's body |
| [The footers](#the-footers-on-every-action) | The counts appended to each action |
| [Performance](#performance) | This machine, and what real visitors get |
| [Memory](#memory-is-this-page-leaking) | Watching the JS heap, and the snapshot DevTools opens |
| [Emulation](#emulation) | Pretending to be somewhere or something else |
| [Advanced mode](#advanced-mode-and-what-it-costs) | When the debugger is worth it |
| [Recipe: a slow page](#recipe-this-page-is-slow) | The order to diagnose it in |
| [Recipe: an accessibility audit](#recipe-auditing-a-page-for-accessibility) | Running one, and reporting it honestly |

---

## Screenshots

```
browser_screenshot                              // the visible viewport
browser_screenshot { fullPage: true }           // the whole scrollable page
browser_screenshot { ref: "e12" }               // one element, cropped
browser_screenshot { filePath: "./shot.png" }   // to disk, not into your context
```

`format` takes `png` (default), `jpeg` or `webp`; `quality` applies to both lossy formats, not to png.
All three work with `fullPage` as well as the viewport.

**Photograph the element, not the page.** This is the single most expensive habit an agent has with
this server, and it is measurable: across 445 real captures, a viewport picture averaged **~1,531
tokens** and only **20** of those captures scoped themselves to one element. A picture does not leave
your context when you are finished with it — it is re-read on every turn for the rest of the session,
so ten page captures in a long session cost more than every other browser call put together.

So before capturing, ask what you are actually checking:

| What you want to know | Reach for |
|---|---|
| Did this one button / field / card render right? | `browser_screenshot { ref }` — a fraction of a page |
| Is this text on the page, is this value right? | `browser_eval` or `browser_find` — **no picture at all** |
| What is the overall layout doing? | a plain viewport capture, once |
| A record for a human to look at later | `filePath` — it never enters your context |

**Use `filePath` whenever you do not need to look at the image yourself.** An inlined screenshot is
one of the most expensive things you can put in a reply.

**An inline capture is held under 1536 x 4096 device pixels and may come back downscaled.** The
aspect ratio is kept, and the reply tells you the size before and after whenever it happened. **Do not
measure page coordinates off an image that says it was downscaled** — read them off the smaller image,
or take the capture again with `filePath`, which is never downscaled. The user's
`AUTOMATE_BROWSER_SCREENSHOT_MAX_WIDTH` / `..._MAX_HEIGHT` set the box, and `0` switches either half
off.

**For a smaller FILE, ask for `format: "webp"` with a `quality` — not a smaller size.** Downscaling a
screenshot and re-encoding it as PNG makes the file *bigger* (measured: a 332 KB 2K capture becomes
529 KB at 1536 wide, against 74 KB as webp at quality 60), because a screenshot is flat colour and
sharp edges that PNG already compresses well.

**Three things to know about `ref` crops.** The first two were measured on a 1.5x display on
2026-09-02:

- The crop is in **device** pixels, so on a scaled or Retina screen a 300x150 element comes back
  450x225. That is correct, not a bug — do not "correct" it back to CSS pixels.
- When the element's size lands on a **half** device pixel the crop rounds outward, so up to one
  pixel of the surrounding page can show at the right and bottom edges. Rounding the other way would
  shave the element instead.
- **A ref from a SAME-ORIGIN frame crops fine**, at any depth: the element's position is measured
  inside its frame and translated up through each parent. A ref from a **cross-origin** frame is
  **refused** — that chain cannot be walked across an origin boundary, the capture covers the whole
  tab, and cropping anyway would hand you a confidently wrong region. Take the screenshot without
  `ref` and find the frame's area in the full picture.

**Judging a crop by eye is unreliable on a busy page.** Overlapping text from behind the element will
appear inside the crop because it genuinely renders there, which looks exactly like a mis-aligned
crop. If you need to be sure, give the element a temporary border, or check against a background
colour that cannot occur inside it.

## A strip of stills, when one picture is not enough

```
browser_screenshot { frames: 10, intervalMs: 150, filePath: "./out/strip.png" }
// → out/strip-01.png … out/strip-10.png, plus one summary line. Never the images.
```

For showing a **person** what happened — a transition, a flicker, a flow that scrolled past. Up to 30
frames, at least 100 ms apart. `filePath` is required: a strip is written to disk, never returned as
pictures, and asking for frames without one is refused.

**Check the achieved interval in the reply before you trust the strip.** It reports both what you
asked for and what it got, and they differ enormously depending on one thing:

| The tab is | You get | Good for |
|---|---|---|
| In the **foreground** | ~110 ms per frame | A fade, a transition, anything fast |
| In the **background** (the default) | **~3.9 seconds per frame** | Slow changes only |

Chrome does not draw a tab nobody is looking at, so each frame waits for one to be rendered. **Your
tab is a background tab unless you did something about it.** For a strip of something moving, call
`browser_switch_tab` first — it takes the user's focus, so ask, or accept the slow strip. The reply
tells you when this bit.

Two more things, neither of them optional to know:

- **It is stills, not video.** No audio, no file to play. Open them in order.
- **The debugger banner shows for the whole strip**, foreground or not, because the cheap capture path
  is capped by Chrome at 2 frames per second. It attaches once and detaches at the end.

## Screenshotting a tab the user is not looking at

This works, and it does **not** bring the tab forward. How it works is worth knowing because it has a
visible side effect.

The cheap capture the browser offers photographs *whatever is on screen* — the foreground tab of a
window. Aimed at a background tab it would return the wrong page; aimed at a window the operating
system is not drawing it returns a **stale or blank frame with no error at all**. So when your tab is
not the foreground tab of a drawn window, the server does not use that path. It renders your exact tab
through the debugger instead.

- **The cost:** the browser shows its "being debugged" banner for the duration, then detaches. This is
  the same mechanism `fullPage: true` has always used.
- **The result says so** — it comes back flagged, with the reason. If a user asks why a banner
  flashed up, that is why.
- **If the debugger cannot attach** — a restricted page, or policy forbids it — the call **fails with
  that reason named**. It never quietly falls back to photographing whatever was on screen. A refusal
  here is the tool protecting you from a wrong answer.
- **The user having DevTools open does NOT stop you.** Measured in Edge 152 on 2026-09-02: a
  background tab with the DevTools panel open attached and captured correctly. Chromium allows
  several debugger clients on one tab. This page said the opposite until that date, and the tool's
  own error offered "close DevTools" as the first remedy — advice that could never have helped.
  One caveat worth knowing: what you get back is **what that tab is actually rendering**, so if
  their DevTools is in device-emulation mode you will receive the emulated phone-sized page, which is
  correct but probably not what you expected.
- **It can stall, and stalling is not failing.** Chrome stops drawing a tab nobody is looking at, so
  a capture sometimes waits on a frame that never comes. The tool nudges the page awake and tries
  again on its own; if both attempts stall you get `CAPTURE_STALLED`, which is **marked retryable
  because a screenshot changes nothing** — simply ask again. Measured before this handling existed:
  3 stalls in 8 captures of a background tab, every one of which succeeded on a retry. Re-measured
  with it in place on 2026-09-02: **0 stalls in 11**, including two captures taken after the tab had
  sat hidden and idle for 75 seconds. So treat `CAPTURE_STALLED` as rare rather than routine — if you
  see it twice in a row on the same tab, that is worth reporting, not just retrying.

## Console logs

`browser_get_console_logs` returns what the page printed, including uncaught errors with their stacks
and service-worker lifecycle events.

`includePreserved: true` also returns the **previous pages'** logs — the answer to "it errored, then
redirected, and now I cannot see it". Logs survive the browser shutting the extension down to save
memory.

You get the **50 newest entries**. If there are more, a footer names the page you are on, the total,
and the exact call for the next one — and `page: 2` goes *further back in time*, not forward. Stacks
are printed for the thrown errors **on the page you asked for**, so an error further back needs its
page fetched.

## The issues feed: the failures with no console error

`browser_issues` is the only tool that sees problems the console never mentions:

- content blocked by a security policy
- a dropped third-party cookie
- mixed content
- a CORS refusal
- browser interventions
- failed and 4xx/5xx requests

**When something "works by hand but not here", this is usually why.** Reach for it before you start
theorising.

## Accessibility: a floor, not a pass

```
browser_snapshot                        // FIRST — this is what creates the refs
browser_issues { audit: "a11y" }        // violations, worst first
browser_issues { audit: "a11y", page: 2 }
```

Runs **axe-core** against the page you are on. Violations come back grouped by impact — **critical,
serious, moderate, minor** — with the number of elements each rule matched, up to **five examples**
each, and a link to that rule's fix guidance. **20 rules per page** by default (`limit` changes it),
worst first; the footer names the next call.

**Snapshot first.** Refs are written onto the page by `browser_snapshot`, so an audit run before any
snapshot reports CSS selectors and no refs. With a ref you can hand the failing element straight to
`browser_click`, `browser_get_html` or `browser_eval`; without one you are reading a selector. A
finding is never dropped for lacking a ref.

**Say the limit out loud when you report the result. Automated rules catch roughly a third of real
accessibility barriers.** They check that attributes exist, never that they are right — no rule here
can tell whether alt text describes its image, whether the focus order is sensible, or whether a
custom widget can actually be operated from the keyboard. **Never report "0 violations" as
"accessible."** Report it as what it is: the automatable third found nothing.

Rules axe could not decide alone are **counted at the end, not listed** — a contrast check over a
background image, say. If that count is high, the page needs a person, not another call.

No debugger and no banner, and it leaves nothing behind on the page.

## Network

- **`browser_network_requests`** lists what the current page requested — method, URL, status, type.
  `resourceTypes` filters; `includePreserved` reaches back through a redirect. You get the **50
  newest** per call (`limit` sets the page size); `page: 2` is the 50 *before* those, and a footer
  names the next call when more remain.
- **`browser_get_network_request { url | requestId }`** returns one request's **response body**, plus
  its request and response headers. Needs advanced mode. When a URL substring matches several
  requests, it returns the newest and lists the others so you can address the one you meant by
  `requestId`. Header values that look like credentials come back `<redacted>`; that is the
  [redaction rule](./sessions-and-state.md#cookies-and-storage), and `revealValues: true` opts out.

## The footers on every action

Mutating actions come back with a short footer counting **new console errors** and **new browser
issues** caused by that action. It is the cheapest possible signal that a click that reported success
actually broke something.

It only counts what is *new* since your last look, so an error the page logged before you arrived is
never blamed on you. Set `AUTOMATE_BROWSER_DELTA_FOOTER=off` to silence it.

For detail in the same reply, ask for it:

```
browser_click { ..., include: "console, network" }
```

A section that cannot be fetched comes back labelled `(unavailable: ...)` and changes nothing else —
the action still succeeded, and any other section you asked for still arrives. A section NAME you get
wrong is the opposite case: it is refused **before** the action runs, so nothing happened and the
corrected call is safe to make.

## Performance

- **`browser_perf_trace`** records a trace of this machine on this run and returns **Core Web Vitals**
  — LCP, FCP, CLS, INP — rated against Google's thresholds, plus the long tasks that blocked the main
  thread. Needs advanced mode. `action: "analyze"` re-reads a saved trace later with no browser at
  all.
- **It also breaks the LCP down and names the cause.** Where the vitals tell you *that* a page was
  slow, the breakdown tells you *which part* was: time to first byte, resource load delay, resource
  load time and render delay, each with its share of the total, followed by one line naming the cause
  and one naming the fix. Read the biggest span first — the advice for a slow server and the advice
  for a late image have nothing in common, so acting on the total alone is guesswork.
- **Render-blocking resources are listed too** — the requests that finished before first paint and
  held it up, slowest first. An async script is deliberately *not* listed: it is already doing the
  right thing, and reporting it would be advice to break working code.
- **A span the trace cannot support is named, not omitted.** A text LCP has no resource to download,
  so it correctly shows two spans rather than four zeroes; an image whose request cannot be matched
  says so; and a trace with no document-request timing says that instead of reporting a breakdown it
  cannot stand behind. **If you see one of those lines, the number you wanted was not measured** —
  record the load itself with `{ action: "start", reload: true, autoStop: true }` rather than reading
  a gap as good news.
- **`browser_perf_field_data { url }`** answers "how fast is this for *real* visitors", from Google's
  public Chrome UX Report. It needs no browser — but it **sends the URL you ask about to a Google
  API**, and needs `AUTOMATE_BROWSER_CRUX_KEY` set. It is the only outbound call this server makes.

Use them together: the trace tells you what this machine did, the field data tells you whether that
resembles reality.

## Memory: is this page leaking?

Two actions on the same tool, split by how much each can honestly tell you.

```
browser_perf_trace { action: "memory" }                    // watch the heap for 5s
browser_perf_trace { action: "memory", durationMs: 30000 } // watch it for 30s
```

**`action: "memory"`** samples `performance.memory.usedJSHeapSize` every 500 ms across the window and
reports start, end, every reading, and a **least-squares trend in MB/s**. The trend is a fit, not
end-minus-start, because the heap saws: a collection mid-window drops it a long way, and a leaking
page can easily finish *lower* than it started.

- **It needs no advanced mode** — no debugger, no banner. This is the one performance action you can
  run on a tab a person is looking at without changing anything for them.
- `durationMs` is **1000-30000**, default 5000, and out-of-range is **refused, not clamped**. For a
  longer watch, call it again between your own interactions.
- The interval is fixed at 500 ms and is not an argument. Chrome quantises the reading into coarse
  buckets, so sampling faster buys more points off the same staircase, not more resolution.
- **You will often get fewer samples than 500 ms implies, and that is fine.** Chrome throttles timers
  in a tab it is not drawing to about once a second, and your tab is a background tab. The reply says
  the cadence it **achieved**, and the trend is computed from the real elapsed time the page measured
  — so the MB/s figure is right either way. `browser_switch_tab` is what changes it.
- **Chrome-family only.** `performance.memory` does not exist in Firefox or Safari; there the call
  fails and says so. Verified working on **both Chrome and Edge** — the whole integration suite
  passes 66/66 on each.

**The sentence that matters: a rising heap is not proof of a leak.** It may simply be memory a
collection has not reclaimed yet. The reply says so every time. To go from "rising" to "leaking",
take two snapshots.

**There is no heap snapshot here, and there cannot be.** It was built and Chrome refused it:
`chrome.debugger` exposes a fixed allow-list of DevTools Protocol domains and `HeapProfiler` is not on
it — the CPU `Profiler` is, the heap one is not. No extension can capture one. To find *what* grew,
a person opens **DevTools → Memory**, takes two snapshots and uses the comparison view. Ask for that
rather than looking for a tool.

## Emulation

`browser_emulate` fakes a location, a user agent, extra headers, a colour scheme, a mobile viewport
with touch, a throttled network, or a slow CPU. `clear` takes them back off.

Everything here is **per tab** and evaporates with the tab — except `browser_proxy`, which changes the
browsing of the human sharing the browser. Treat that one as an interruption to a person, not a
setting.

## Advanced mode, and what it costs

`browser_advanced_mode { enable: true }` attaches the Chrome debugger to your tab. While attached, the
browser shows a banner saying so.

**Required for:** `browser_upload_file`, `browser_get_network_request`, `browser_perf_trace` (all
actions except `memory`, which is debugger-free), some `browser_emulate` options, and
`browser_navigate`'s `initScript` / `handleBeforeUnload`.

**Attached for you automatically, briefly, by:** `fullPage: true` screenshots, and screenshots of a
background tab.

**While attached, a `browser_click` on a CROSS-origin frame's ref is refused** — the trusted click
path drives one debugger session and cannot reach another origin's frame. Turn advanced mode off and
the default click reaches it, because that one injects into the frame directly. A same-origin frame
works either way, with the frame's offset applied so the click lands on the element rather than on
whatever sits at that point in the top page.

**It does not change what your other calls return.** With it on, clicks and key presses are dispatched
as real OS-level input instead of synthetic events, but they still wait for the page to settle and
still report `navigated`, `elapsedMs` and — for a coordinate click — the `hit` naming what was under
the point. Until 2026-09-01 they did not, so turning this on for an unrelated reason quietly changed
both the shape and the timing of every click.

**But it makes clicking impossible on a background tab, which is where you normally work.** Chrome
**discards** real input aimed at a tab it is not drawing. So with advanced mode on, `browser_click`
and `browser_press_key` **refuse outright** on your background tab and tell you to bring it forward or
turn the mode off — they never report a success that did not happen. The practical rule: enable
advanced mode for what needs it (a response body, a trace, an upload), then **turn it off again before
you interact**. The default path works perfectly in a hidden tab; the trusted one cannot.

Everything else is debugger-free by design — that is the point of this server. Turn it off when done:
`browser_advanced_mode { enable: false }`. A tool that needs it and does not have it says so with
`ADVANCED_MODE_REQUIRED` rather than failing obscurely.

### Reaching a staging site with a bad certificate

**This does not work, and you should not spend a call finding that out.** There is no argument for
it. `acceptInsecureCerts` existed until 2026-09-16 and never worked on any build: extensions get a
fixed list of debugger domains and the one it needed is not on it. It was deleted rather than kept
as a permanent error charged to every request you make.

**If you pass it anyway the call is refused by name**, not quietly ignored — so an older habit costs
you one error rather than a false belief that certificate checking is off.

**What to tell the user instead**, because this is theirs to fix and it takes them ten seconds:

- **Click through the warning page once, by hand.** Chrome remembers that host for the session, and
  every AutomateBrowser tool then works against it normally. This is almost always the right answer.
- **Or start the browser with `--ignore-certificate-errors`** if it is going to keep happening.

**Do not retry, and do not look for another way round it** — there is not one from inside an extension.
Say plainly that the site's certificate is being rejected, name which of the two fixes you want, and
wait. A certificate warning is exactly the thing a person should look at once rather than have an agent
silently bypass.

One related fact is unchanged: a tab parked on the warning page refuses a debugger attachment at all.

## Recipe: "this page is slow"

Work outwards from the cheapest evidence. Steps 1 and 2 need no debugger and no banner.

**1. Ask whether it is slow for anyone else.**

```
browser_perf_field_data { url: "https://example.com/page" }
```

Real visitors' vitals from Google's Chrome UX Report, with no browser involved. If the field data is
green and your run is not, you are measuring **this machine on this network**, not the site. Say that
before you go further. (Needs `AUTOMATE_BROWSER_CRUX_KEY`, and it sends the URL to a Google API.)

**2. Check for things failing silently.**

```
browser_issues
```

A blocked script, a CORS refusal or a 4xx on a render-blocking resource makes a page slow *and* prints
nothing in the console. Rule this out before you profile — it is the cheapest call here and it is
often the whole answer.

**3. Profile one full page load, in a single call.**

```
browser_advanced_mode { enable: true }
browser_perf_trace { action: "start", reload: true, autoStop: true, filePath: "./trace.json" }
```

`reload` + `autoStop` records from before navigation until loading finishes and returns LCP, FCP, CLS
and INP rated against Google's thresholds, plus the long tasks that blocked the main thread, **the LCP
breakdown, and the render-blocking resources**. **Pass `filePath`** — the path is checked before
recording starts, and it lets you re-read the trace later with `{ action: "analyze", filePath }`
instead of recording again.

**4. Read the LCP breakdown before you call anything else.**

It has already done the step this recipe used to send you off to do. Four spans, each with its share
of the total, and the cause and fix lines name the biggest one:

| Biggest span | What it means | What to do |
|---|---|---|
| **time to first byte** | The server was still thinking; nothing on the page could start | Nothing in the browser will fix this — it is the request handler or the cache |
| **resource load delay** | The image was discovered late, not downloaded slowly | Look at how it is referenced: a preload or a plain `<img>` in the initial HTML |
| **resource load time** | The image itself is too big for the connection | `browser_network_requests` for its size, then a smaller format |
| **render delay** | The bytes arrived and the page still could not paint | The render-blocking list right below it, and the long tasks above |

**5. Let any remaining failing vital pick the next call.**

| Vital | What it means | Next call |
|---|---|---|
| **CLS** high | The layout moved after paint | `browser_screenshot { frames: 8, intervalMs: 150, filePath: … }` — see the jump |
| **INP** slow, or long tasks | The main thread was blocked | The trace's long-task list already names the durations |

**6. If it is only slow after a while of use, it is a different question.** That is
`browser_perf_trace { action: "memory" }`, in the memory section above — and that one needs no
debugger at all.

**7. Turn advanced mode off before you interact again.**

```
browser_advanced_mode { enable: false }
```

With it on, `browser_click` and `browser_press_key` **refuse** on a background tab, which is where you
normally work. Profiling is the only thing you needed it for.

## Recipe: auditing a page for accessibility

**1. Snapshot first — this is not optional.**

```
browser_snapshot
browser_issues { audit: "a11y" }
```

Refs are written onto the page by the snapshot. An audit run before any snapshot still reports every
finding, but names them with CSS selectors, so you cannot hand a failing element to another tool.

**2. Page through, worst first.** Twenty rules per page, most severe first, and the footer gives you
the exact next call. Stop when the impact drops below what you were asked to care about — you rarely
need the `minor` pages.

**3. Read the real markup before you propose a fix.**

```
browser_get_html { ref: "e34" }
```

The rule tells you what axe checked; the markup tells you why it failed. Guessing between those two is
how a fix gets proposed for something that is not actually broken.

**4. Audit dark mode too, if the site has one.** Contrast is the most common failure and it is
theme-specific, so a light-mode pass says nothing about the other theme:

```
browser_advanced_mode { enable: true }
browser_emulate { colorScheme: "dark" }
browser_snapshot
browser_issues { audit: "a11y" }
browser_emulate { clear: ["colorScheme"] }
browser_advanced_mode { enable: false }
```

`colorScheme` needs advanced mode — `prefers-color-scheme` cannot be overridden from page JavaScript
at all. Reading and auditing still work fine while it is attached; only clicking on a background tab
does not.

**5. Report the count of rules needing human review**, printed at the end of the audit. A high number
means the page needs a person, not another call.

**6. Never write "accessible".** Automated rules catch roughly a third of real barriers, and they
check that attributes exist rather than that they are right. The honest sentence is *"the automatable
third found nothing"* — followed by what a person still has to check: keyboard traversal, focus order,
whether the alt text actually describes the image.
