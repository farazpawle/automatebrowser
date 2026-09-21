# Store listing images

Generated 2026-09-21 from `docs/logo.png` and the site's own brand values, so a listing and the
website cannot drift apart. Not shipped: `package.json`'s `files` does not include `Chrome-extension`,
and these never reach a user's disk.

| File | Size | Required by |
|---|---|---|
| `icon-128.png` | 128×128, white card on transparent | **Chrome — mandatory.** 96×96 of artwork inside 16px of transparent padding, which is the rule; `public/icon/128.png` is full-bleed and does not satisfy it. Made by `scripts/gen-icons.mjs` alongside the extension icons, so the two stay the same picture. |
| `promo-440x280.png` | 440×280 | **Chrome — mandatory** (small promotional tile). Optional on Edge, which takes the same size. |
| `logo-300.png` | 300×300 | **Edge — mandatory** (extension logo, 1:1; 300×300 recommended, 128×128 floor). |

Still missing, and not producible here: **screenshots**, 1280×800, at least one for Chrome. They have
to show the extension doing something in a real browser with a real agent connected. The marquee
tile (1400×560) is optional on both stores and only matters for featuring.

## How they were made

A throwaway Chrome via Puppeteer, rendering HTML at the exact viewport size and screenshotting it —
no image library, no design tool, and the brand colours come from the same hex values as
`docs/index.html` (`#faf7f2` paper, `#0D1D34` ink, `#0C54C3` accent). The script was not kept: it is
twenty lines and the logo changes about never. Two things it did are worth repeating if you redo it:

- **Inline the logo as a data URI.** A page created with `setContent` lives at `about:blank` and is
  refused `file://` subresources, so a `file://` path renders a broken-image box — which is exactly
  what the first run produced, and only looking at the output caught it.
- **Assert the margins, do not eyeball them.** Measure every element's bounding box against the
  frame and fail the render if anything crosses it. The second run looked fine at a glance and had
  the wordmark touching the right edge.
