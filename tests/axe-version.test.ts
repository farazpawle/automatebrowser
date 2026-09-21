/**
 * The vendored axe-core must be the version the extension SAYS it ships (D8).
 *
 * `Chrome-extension/public/vendor/axe.min.js` is a verbatim copy, not something
 * the bundler resolves, so nothing in the build would notice if it went stale.
 * The `axe-core` entry in the extension's package.json is what `npm audit
 * --omit=dev` and Dependabot actually watch — so if the copy and the entry drift
 * apart, security tooling is watching a version nobody runs and reporting green.
 *
 * That is the failure this pins: not "is axe present", but "is the file we ship
 * the file we are being audited on". It is also the reminder that updating one
 * means updating the other.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "Chrome-extension");

describe("vendored axe-core", () => {
  const bundle = readFileSync(join(extension, "public", "vendor", "axe.min.js"), "utf8");
  const declared = JSON.parse(readFileSync(join(extension, "package.json"), "utf8")).dependencies[
    "axe-core"
  ];

  it("is declared as an exact version, so the copy has something to match", () => {
    // A range (`^4.13.0`) would let `npm audit` resolve a different build than
    // the one committed, which is the whole problem this file exists to stop.
    assert.match(declared, /^\d+\.\d+\.\d+$/, `expected an exact version, got "${declared}"`);
  });

  it("ships the version package.json declares", () => {
    const stamped = bundle.match(/axe\.version\s*=\s*["']([\d.]+)["']/)?.[1];
    assert.equal(
      stamped,
      declared,
      `vendored axe.min.js is ${stamped}, package.json declares ${declared} — ` +
        "recopy node_modules/axe-core/axe.min.js or fix the dependency.",
    );
  });

  it("keeps the MPL-2.0 notice the licence requires be distributed with it", () => {
    // MPL-2.0 §3.1: the copyright notice must travel with the file. Minifiers
    // strip banner comments by default, so a well-meaning "optimise the bundle"
    // step is a licence violation that nothing else would catch.
    assert.match(bundle.slice(0, 600), /Mozilla Public\s+\*? ?License/);
    assert.match(bundle.slice(0, 600), /Deque Systems/);
  });
});
