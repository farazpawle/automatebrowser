# Interacting with a page

## Contents

| Section | What it answers |
|---|---|
| [Refs, not selectors](#refs-not-selectors) | How you address an element |
| [Finding an element cheaply](#finding-an-element-cheaply) | `browser_find` vs a full snapshot |
| [The interaction tools](#the-interaction-tools) | click, type, hover, drag, select, clear, scroll |
| [Filling a form](#filling-a-form-in-one-call) | `browser_fill_form` |
| [Clicking what a snapshot cannot name](#clicking-what-a-snapshot-cannot-name) | Canvases, maps, PDFs |
| [Waiting](#waiting-for-the-page-to-catch-up) | `wait_for` vs `wait` vs settle options |
| [Actionability](#actionability-why-a-click-refuses) | Why a click refused before running |
| [Stale refs](#when-a-ref-goes-stale) | Recovering from a re-render |

---

## Refs, not selectors

Every interaction addresses an element by a **`ref`** handle plus a human-readable `element`
description, never a raw CSS selector:

```
browser_click { element: "the Sign in button", ref: "e17" }
```

Refs come from `browser_snapshot` or `browser_find`. The `element` string is not decoration — it is
what appears in the error if the click refuses, and what the user sees in the audit log. Describe the
thing as a person would.

## Finding an element cheaply

`browser_snapshot` is the **map, not the data**. It returns the page's interactive elements with
their refs. Read it once to learn the page's shape, then stop — it is the most expensive call in the
set.

When you already know what you are after, `browser_find` is far smaller:

```
browser_find { text: "Add to basket" }
browser_find { role: "button", max: 5 }
browser_find { selector: "form#checkout input" }
```

It returns matching elements with refs you can act on immediately. Reach for a full snapshot only
when you genuinely need to survey an unfamiliar page.

`browser_snapshot { verbose: true }` returns the fuller tree; `{ filePath }` writes it to disk instead
of into your context.

## The interaction tools

| Tool | Required | Notes |
|---|---|---|
| `browser_click` | `element`, `ref` — or `x`, `y` | `dblClick: true` for double-click |
| `browser_type` | `element`, `ref`, `text`, `submit` | `submit` is required — say whether to press Enter |
| `browser_hover` | `element`, `ref` | For menus that open on hover |
| `browser_select_option` | `element`, `ref`, `values` | `values` is an array, even for one |
| `browser_drag` | `startElement`, `startRef`, `endElement`, `endRef` | Both ends need a description |
| `browser_clear` | `ref` | Empties an input properly, better than typing over |
| `browser_press_key` | `key` | `"Enter"`, `"Control+A"`, `"Escape"` — no ref, goes to the page |
| `browser_scroll` | — | `{ ref }` scrolls to an element, or `{ dx, dy }`, or `{ to: "bottom" }` |

## Filling a form in one call

Do not click-and-type field by field. `browser_fill_form` takes them all at once and is dramatically
faster and less brittle:

```
browser_fill_form { fields: [
  { element: "email", ref: "e3", value: "a@b.com" },
  { element: "country", ref: "e7", value: "United Kingdom" }
] }
```

It handles text inputs, selects, checkboxes and radios. Submit separately, so a failed fill never
half-submits a form.

**Read the count, not the error flag.** A fill where some fields landed and some did not is neither
a success nor a failure, and the flag alone cannot say so. It returns `outcome: "partial"`, the
`Filled 2/3 field(s)` line with a `✗ ref: reason` for each field that refused, and the same thing
structured as `{ filled, total, errors }`. Only a fill where **nothing** landed sets `isError`.
Acting on the flag without reading the count is how a form gets submitted a third empty.

**A checkbox or radio takes a boolean and nothing else** — `"true"` or `"false"` (also `1`/`0`,
`on`/`off`, `yes`/`no`, `checked`/`unchecked`). Any other value is refused for those two, as a
per-field error; the rest of the batch still fills. **Pick one option of a group by setting THAT
option's own ref to `"true"`** — not by passing the option's label, which is how a `<select>` is
filled and is refused here. `"false"` on a radio clears it and leaves the group with nothing selected;
it never promotes a sibling.

**A form that spans frames still goes in ONE call.** This is the one tool that may mix prefixes: a
checkout puts the card number inside an embedded widget and the address in the page around it, and
splitting that up would defeat the tool. Pass the fields in the order you want them written and that
is the order they are written, even when the batch crosses back and forth.

Three things follow from that, and they are the ones worth relying on:

- **Nothing is written until every ref parses.** A bad prefix anywhere refuses the whole call with the
  form untouched, rather than stopping halfway through with no way to tell how far it got.
- **Failures are per field, and name the ref you passed.** A frame that has gone fails only its own
  fields; the rest of the batch still reports its own result. Read `errors`, not just the count.
- **Submit is still separate.** Nothing here changes that.

`browser_clear` follows the same rules. Both reach a field inside a shadow root, so a design-system
input with a perfectly good ref is fillable.

## Clicking what a snapshot cannot name

A canvas, an embedded map, a PDF viewer — nothing in the accessibility tree to point at. Click by
coordinate instead:

```
browser_click { x: 420, y: 310 }
```

Coordinates are viewport pixels. The reply names what was actually under the point, so you can tell a
hit from a miss. Pass **either** a ref or coordinates, never both; giving both is refused before
anything runs.

## Waiting for the page to catch up

In order of preference:

1. **`include: "snapshot"`** on the action itself — the fresh page comes back in the same reply, with
   no second call. On `browser_navigate`, `browser_click` and `browser_type` **only**; elsewhere it is
   rejected. The plain `includeSnapshot: true` reaches further — those three plus `browser_hover`,
   `browser_select_option` and `browser_drag`, but **not** `press_key`, `fill_form`, `clear` or
   `scroll`.
2. **`browser_wait_for`** — waits for a real condition: `{ selector }`, `{ text }`, `{ urlPattern }`,
   or `{ state }`. This is the right tool when a site swaps content without navigating.
3. **`settleMs` / `waitUntil`** on the action — tune how long it waits for the page to go quiet after
   acting.
4. **`browser_wait { time }`** — a blind sleep. Last resort. It is either too short and flaky or too
   long and slow, and usually both on different days.

### The defaults these three already have

They are **not** in the tool schemas, deliberately — a sentence in a schema is re-sent on every
request, and saying these six times over cost 10% of the entire tool budget. Read them here, once:

| | Navigation (`browser_navigate`, back/forward) | Interactions (click, type, hover, …) |
|---|---|---|
| `includeSnapshot` | **true** — a snapshot comes back unasked | **false** — the reply stays lean |
| `waitUntil` | **`load`** | **`auto`** |
| `settleMs` | 15 s cap for navigate, 10 s for back/forward | **2000** |

So you rarely need to set any of them. Set `includeSnapshot: false` on a navigation whose page you
are not about to touch; set `waitUntil: "none"` when you want the reply immediately and will wait for
a real condition yourself; and prefer an explicit `browser_snapshot` when what you actually want is
fresh refs, or `browser_eval` when one value would answer the question.

### Reading a navigation's `settled`

`settled: true` means **the navigation you asked for** finished — not that the tab says "complete",
which straight after a reload still describes the page you are leaving. Three things follow:

- A `#fragment` jump, or a history step that stays inside one document, settles as soon as the url
  changes. No load event is coming for one of those.
- A transition that never starts — a link that turns out to be a download, an unanswered "Leave site?"
  prompt, a forward entry that was not there — gives up after **about a second** with `settled: false`.
  The tab is asked before that is believed, so a navigation the browser is merely slow to begin gets
  its full budget: Chrome re-attempts a page it has refused before after roughly **3 seconds**, and
  that used to come back as a page that never loaded.
- **`settled: false` is not a failure.** It means the load was not seen to finish inside what you
  allowed. Read `urlAfter` and `navigated` for what actually happened, then take a fresh snapshot
  before you use any ref.

`settleMs` only ever shortens the wait (15 s for `browser_navigate`, 10 s for back/forward). The one
exception to `waitUntil: "none"` returning immediately is `initScript`: the script has to stay
installed until the new document is built, so that combination waits for the page to commit.

### When a navigation did not happen at all

`browser_navigate` no longer claims success regardless. If the tab is not where you asked it to go,
the reply opens with `Did NOT reach <url> — after 2.0s the tab was still on <old url>`, and that line
appears **inside the snapshot reply too**, at the top. Believe it: the snapshot underneath it is the
OLD page, and every ref in it belongs to that page. Do not act on them as though you had arrived.

Read it as an observation over a window, not a verdict. The server re-asks the tab for up to 2 s
before saying anything, because a page the browser is slow to commit lands roughly 700 ms late, and
that wait is paid only when the first answer already said nothing had moved. It is a race against a
still-moving browser, so at the boundary it can warn about a page that arrives a moment later, or stay
quiet about one that bounces back — 14 of 16 real navigations were reported correctly.

It stays silent wherever an unchanged url is correct: a reload, `waitUntil: "none"`, a navigation to
the page already open, and a redirect that lands somewhere other than the url you typed. So the line
appearing means something went wrong; its absence is not a guarantee that nothing did.

## Actionability: why a click refuses

Every interaction waits for the element to be genuinely ready — visible, enabled, not moving, and not
covered by something else — before acting. A refusal names **which check failed and what was in the
way**:

> `NOT_ACTIONABLE: "Submit" is covered by "Cookie consent banner"`

That is usually the real bug, not a timing problem. Dismiss the overlay rather than retrying or
padding the wait.

**The one exception, and it will catch you: an element that fades in with a CSS transition never
becomes visible in your background tab.** Chrome does not advance transitions in a tab it is not
drawing, so the opacity stays at its starting value indefinitely — the script sets the target, the
animation never runs, and you get `failed the "visible" check` no matter how long you wait. Measured
2026-09-01. Padding the timeout cannot help.

When a click refuses as invisible and the element is one a human would see appear — a modal, a
dropdown, a toast, anything revealed on interaction — that is this, not a slow page. Either drive the
element's final state directly (`browser_eval` to read it, or act on what the fade reveals), or
`browser_switch_tab` to bring the tab forward, accepting that you are taking the user's focus.

## When a ref goes stale

Refs survive small re-renders and recover themselves once if the page swapped the element out
underneath you. When one truly cannot be found you get `STALE_REF`, and the recovery is always the
same: take a fresh `browser_find` or `browser_snapshot` and use the new ref.

**Do not cache refs across a navigation.** A new document means new refs, always.

**Frames:** an embedded widget is a separate document. **Every** frame's refs are prefixed `f1:`,
`f2:` and so on — same-origin ones too, and a `srcdoc` frame as well. Pass them through unchanged;
they work like any other ref. In the page tree an `<iframe>` shows as a bare `- iframe` marker and its
contents appear below under their own `- frame <url>` heading, never inline.

**But one INTERACTION acts inside one frame.** For `browser_click`, `browser_hover`, `browser_type`,
`browser_select_option`, `browser_drag` and `browser_eval`, every ref in the call has to carry the
same prefix, and **no prefix means the top page** — it is not a wildcard that joins whatever frame the
other ref named. `browser_drag { startRef: "f3:e9c4", endRef: "e1a2" }` is a mismatch, not a
shorthand, and you get `BAD_ARGS` before anything is clicked, typed or dragged. There is no
cross-frame drag; do the work one frame at a time.

`browser_fill_form` and `browser_clear` are the exception and may mix frames freely — see
[Filling a form in one call](#filling-a-form-in-one-call).

Copy a prefix exactly as the snapshot printed it. A half-written one — `f3:` alone, `fx:e1a2` — is
refused rather than guessed at, because guessing means acting on a same-named element in the wrong
document and telling you it worked.
