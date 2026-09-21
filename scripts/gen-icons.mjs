// Regenerate the browser-extension icons from the website logo.
//
// Uses docs/logo.png — the same image the landing page and the store listing
// show — so the installed extension cannot drift from them. The logo is
// transparent, which reads as faint on a dark toolbar, so it sits on a white
// rounded card. Writes to the WXT source (public/icon), the current build
// output (.output/chrome-mv3/icon) so a loaded unpacked extension picks up the
// new icon on reload without a full rebuild, and the Chrome store icon.
//
// Usage:  npm i --no-save sharp && node scripts/gen-icons.mjs
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logo = resolve(root, "docs/logo.png");

// A white rounded card of `card` px centred on a transparent `size` px canvas,
// with the logo inset inside it.
async function icon(size, card, file) {
  const pad = Math.round(card * 0.14);
  const inner = card - 2 * pad;
  const off = (size - card) / 2;
  const radius = Math.round(card * 0.22);
  const bg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${off}" y="${off}" width="${card}" height="${card}" rx="${radius}" fill="#ffffff"/></svg>`,
  );
  const mark = await sharp(logo)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp(bg)
    .composite([{ input: mark, left: off + pad, top: off + pad }])
    .png()
    .toFile(file);
  console.log(`wrote ${file}`);
}

// Sizes declared in the generated manifest (icons + action.default_icon) —
// full-bleed card, since the toolbar supplies no margin of its own.
const sizes = [16, 32, 48, 128];
const targets = [
  resolve(root, "Chrome-extension/public/icon"),
  resolve(root, "Chrome-extension/.output/chrome-mv3/icon"),
];
for (const dir of targets) {
  await mkdir(dir, { recursive: true });
  for (const size of sizes) await icon(size, size, resolve(dir, `${size}.png`));
}

// Chrome Web Store rule: 96×96 of artwork inside 16px of transparent padding.
await icon(128, 96, resolve(root, "Chrome-extension/store-assets/icon-128.png"));
