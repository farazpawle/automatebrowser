/**
 * Accessibility audit (D8) — vendored axe-core, run against the live page.
 *
 * `browser_issues` already means "problems the browser found". This is the same
 * question asked of a different oracle: not what Chrome reported, but what an
 * audit finds when it walks the rendered tree. It is folded into that tool
 * rather than given its own, because a second tool would cost every agent on
 * every request for a capability most tasks never reach for.
 *
 * ── The library ──────────────────────────────────────────────────────────────
 * `public/vendor/axe.min.js` is axe-core 4.13.0, verbatim from npm, MPL-2.0,
 * zero runtime dependencies. It is COPIED rather than bundled: it must be a
 * standalone file for `chrome.scripting.executeScript({files})` to inject it,
 * and bundling 580 KB into the service worker to inject it as a string would be
 * worse on every axis. `tests/axe-version.test.ts` pins the vendored file to the
 * version `Chrome-extension/package.json` claims, so the copy cannot drift from
 * the entry that `npm audit` and Dependabot actually watch.
 *
 * To update: `npm i axe-core@<v>` in a scratch dir, copy `axe.min.js` over,
 * bump the devDependency, run the test.
 *
 * ── DEVIATION: the ISOLATED world, not MAIN ──────────────────────────────────
 * The plan said MAIN. It is wrong, in a way that only shows up on a real page:
 *
 *  1. MAIN injection leaves a 580 KB `window.axe` on the user's real, logged-in
 *     page — a side effect on the thing under test, and one that clobbers a page
 *     that ships its own axe (many CI-instrumented apps do).
 *  2. A strict `script-src` can refuse MAIN-world injection outright. The
 *     ISOLATED world is not subject to the page's CSP, so the audit still runs
 *     on exactly the hardened pages most worth auditing.
 *
 * Nothing is lost by moving: axe reads the DOM and `getComputedStyle`, and the
 * isolated world shares both. It never touches page JavaScript. That is why
 * every browser a11y extension runs it in a content script too.
 */
import { runFunc } from "./run-func";

/** axe's own scale. Ordered worst-first, which is also the report order. */
const IMPACTS = ["critical", "serious", "moderate", "minor"] as const;

/**
 * Nodes shown per rule. A single rule routinely matches hundreds of elements —
 * `color-contrast` on a page with one bad token hits every instance of it — and
 * the 300th example teaches nothing the 5th did not. The full count still
 * travels, so the size of the problem is never hidden.
 */
const NODE_CAP = 5;

export interface A11yNode {
  /** Snapshot ref, when a snapshot has been taken and tagged this element. */
  ref?: string;
  /** axe's CSS path to the element. */
  target: string;
  /** Opening tag, clipped. */
  html: string;
}

export interface A11yViolation {
  /** axe rule id, e.g. `color-contrast`. */
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  /** Up to NODE_CAP examples. */
  nodes: A11yNode[];
  /** Elements this rule matched in total, including the ones not listed. */
  nodeCount: number;
}

export interface A11yResult {
  violations: A11yViolation[];
  /** Rules that passed, and rules axe could not decide alone. */
  passed: number;
  incomplete: number;
  /** axe-core version, so a report can be reproduced against the same rules. */
  version: string;
}

/**
 * Injected: runs axe and trims the result to what crosses the wire.
 *
 * The trim happens HERE, in the page, not in the worker. A raw axe result on a
 * failing page is megabytes — every node carries its full outerHTML, every check
 * its related nodes — and all of it would be serialised through the message port
 * only to be thrown away. Self-contained by `runFunc`'s contract.
 */
function auditFn(nodeCap: number, impacts: readonly string[]) {
  const axe = (window as unknown as { axe?: any }).axe;
  if (!axe) return { ok: false as const, error: "axe-core failed to load into the page." };

  return axe
    .run(document, {
      // Only violations get full node detail built; passes and incomplete come
      // back as rule lists we count. Measurably faster on a large DOM, and the
      // difference is data we would discard anyway.
      resultTypes: ["violations"],
    })
    .then((r: any) => {
      const violations = (r.violations || [])
        .map((v: any) => {
          const all = v.nodes || [];
          return {
            id: v.id,
            impact: v.impact || "minor",
            help: v.help,
            // axe appends `?application=axeAPI` to every help URL. It is the same
            // page without it, and it is 20 characters the model pays for on
            // every finding.
            helpUrl: String(v.helpUrl || "").split("?")[0],
            nodeCount: all.length,
            nodes: all.slice(0, nodeCap).map((n: any) => {
              // `target` is an array, and an array of arrays when the element is
              // inside a frame. Only a plain single selector can be resolved back
              // to an element here, which is exactly when a ref could exist.
              const flat = (n.target || []).flat(2);
              const sel = flat.length === 1 ? String(flat[0]) : "";
              let ref: string | undefined;
              if (sel) {
                try {
                  ref =
                    document.querySelector(sel)?.getAttribute("data-bmcp-ref") ||
                    undefined;
                } catch {
                  // A selector axe built that this document will not parse is a
                  // missing ref, never a failed audit.
                }
              }
              return {
                ref,
                target: flat.join(" >>> ") || "(unknown)",
                // Strip our own tagging out of the reported markup. `data-bmcp-ref`
                // is written by the snapshot, not by the page, and leaving it in
                // means the developer reads their own HTML with an attribute they
                // never wrote — and pastes it into a bug report that way.
                html: String(n.html || "")
                  .replace(/\s*data-bmcp-ref="[^"]*"/g, "")
                  .slice(0, 120),
              };
            }),
          };
        })
        // Ascending, worst LAST. `paginate` serves the tail as page 1, so this
        // is what puts the critical findings on the page nobody has to ask for.
        .sort(
          (a: any, b: any) => impacts.indexOf(b.impact) - impacts.indexOf(a.impact),
        );

      return {
        ok: true as const,
        violations,
        passed: (r.passes || []).length,
        incomplete: (r.incomplete || []).length,
        version: axe.version || "unknown",
      };
    })
    .catch((e: any) => ({ ok: false as const, error: String(e?.message || e) }));
}

export async function auditA11y(tabId: number): Promise<A11yResult> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["/vendor/axe.min.js"],
      world: "ISOLATED",
    });
  } catch (e: any) {
    throw new Error(
      `RESTRICTED_PAGE: Cannot audit this page (${e?.message || e}). It may be a restricted page (chrome://, the Web Store, a PDF) — open a normal http(s) page.`,
    );
  }

  // chrome.scripting awaits a returned promise and hands back the RESOLVED
  // value; the type parameter cannot express that, so it is asserted once here.
  const r = (await runFunc(tabId, auditFn, [NODE_CAP, IMPACTS], "ISOLATED")) as unknown as
    | ({ ok: true } & A11yResult)
    | { ok: false; error: string };

  if (!r.ok) throw new Error(r.error);
  return r;
}
