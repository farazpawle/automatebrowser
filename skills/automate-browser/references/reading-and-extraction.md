# Reading a page and extracting data

## Contents

| Section | What it answers |
|---|---|
| [Pick the cheapest tool](#pick-the-cheapest-tool-that-answers-the-question) | read_page vs find vs get_html vs eval |
| [The extraction loop](#the-extraction-loop) | The shape of a scraping task |
| [Extract with a function](#extract-with-a-function-not-an-expression) | Using `browser_eval` properly |
| [Big results](#big-results-go-to-a-file) | Keeping output out of your context |
| [Pagination](#pagination) | Walking multiple pages |
| [What will bite you](#what-will-bite-you) | Late rendering, frames, infinite lists |

---

## Pick the cheapest tool that answers the question

| You want | Use | Why not the others |
|---|---|---|
| The visible text of the page | `browser_read_page` | Cheapest. Already stripped of markup. `format: "markdown"` keeps headings and links; `maxLength` caps it. |
| A few elements matching text, role or selector — or one value kept in an attribute or `<head>` | `browser_find` | Returns `ref`s you can act on, and is far smaller than a snapshot. Each match prints its `id`, `href`, `title`, `datetime` and `content` when present, so `{ selector: "meta[name=user-login]" }` or a `<relative-time>` answers without `get_html` |
| A table, repeated cards, any structure | `browser_eval` with a **function** | Returns real JSON. Do the mapping in the page, not in your head. |
| The raw markup of one element | `browser_get_html { ref }` | Whole-page HTML is almost never what you want |
| The page's interactive shape | `browser_snapshot` | The most expensive call here — for finding things to click, not for reading |

`browser_read_page` is the default answer to "what does this page say". Reach past it only when you
need structure it has thrown away.

## The extraction loop

```
browser_navigate → browser_read_page          (does the answer just fall out?)
                 → browser_find               (locate the container)
                 → browser_eval (function)    (map it to JSON)
                 → next page
```

Take a snapshot only if you cannot find what you need without one.

## Extract with a function, not an expression

`browser_eval` takes either an `expression` (a quick one-liner) or a `function` plus `args` of element
refs. The function form is what you want for anything structured, because a ref passed in `args`
arrives as a real element:

```js
// browser_eval {
//   function: "(row) => ({ name: row.querySelector('.name').innerText, price: row.querySelector('.price').innerText })",
//   args: ["e4k2"]
// }
```

For a whole table, one call beats one call per row:

```js
// browser_eval {
//   function: "() => [...document.querySelectorAll('table tbody tr')].map(r => [...r.cells].map(c => c.innerText.trim()))"
// }
```

Return **plain JSON-serialisable values**. DOM nodes do not survive the trip. Passing both
`expression` and `function` is refused, and `args` without `function` is refused — both before
anything runs.

## Big results go to a file

`browser_eval`, `browser_snapshot` and `browser_screenshot` all take `filePath`. A five-thousand-row
table pasted into your reply costs more than the whole task did. Write it, then read the file with
your normal file tools.

```
browser_eval { function: "...", filePath: "./out/rows.json" }
```

Paths are sandboxed to the folders your editor advertises, plus any in `AUTOMATE_BROWSER_WORKSPACE`,
plus the temp directory. A refusal names the directories it *would* have accepted, so you do not have
to guess. Editors that advertise none (Cline, Zed, Windsurf, Gemini CLI, Codex) leave only the
server's working directory — if that is the refusal you hit, tell the user to set that variable to the
folder they want written, rather than suggesting they turn the sandbox off. Writing to the temp
directory always works and needs no configuration at all.

## Pagination

Prefer the URL over the button when the site puts the page number in the URL — one call instead of
three, and it cannot get stuck mid-animation:

```
browser_navigate { url: ".../results?page=2" }
```

Otherwise click and wait for the content to change, not for a fixed delay:

```
browser_click { element: "next page", ref: "e9", include: "snapshot" }
```

`include` returns the fresh page in the same reply. Use `browser_wait_for` when the site swaps content
without navigating.

## What will bite you

- **A page that renders after load** returns nothing on a first read. `browser_wait_for` a selector or
  some text, then read.
- **Content behind a scroll** may not be in the DOM at all on an infinite list. Scroll, then read, and
  repeat — do not assume one read got everything.
- **Refs go stale on a re-render.** You get `STALE_REF` and the tool names the fix. Never cache a ref
  across a navigation.
- **An embedded widget** — a map, a payment field — is a separate frame, whether or not it shares
  the page's origin. Reads reach inside it. Its contents appear under their own `- frame <url>`
  heading rather than inline, and its refs are prefixed `f1:` and so on. Pass them through unchanged.
  An `<iframe>` in the tree itself is just a marker; look below for its block.
- **Rate limits and terms of use are yours to respect.** This drives the user's real, logged-in
  browser: whatever you do is done as them, from their address, with their account.
