/**
 * browser_find (plan 14, F10 and F11).
 *
 * F10: a text match is tested against an element's whole-subtree text, so
 * every ancestor of the real target matches too. Matches came back in document
 * order - html, body, div, ... - and the `max` cut could drop the link itself
 * (benchmark run T32: find "Sign in" returned html/body/div).
 *
 * F11: every element in <head> has no box, so the visibility filter hid a
 * `<meta>` even from an explicit selector (T32 could not read the logged-in
 * user), and a match carried only role and name - a `<relative-time>`'s date
 * lives in its `datetime` attribute and came back blank (T33).
 *
 * The page function runs for real against a tiny hand-built DOM - see
 * `form-radio-values.test.ts` for why not jsdom.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { find as findTool } from "@/tools/content";

import { loadExtensionModule } from "./helpers/extension-harness";
import { all, type El, h } from "./helpers/fake-dom";

const CONTENT = "Chrome-extension/lib/automation/content-ops.ts";

interface Match {
  ref: string;
  role: string;
  name: string;
  tag: string;
  attrs?: Record<string, string>;
  hidden?: boolean;
}
interface ContentModule {
  find(tabId: number, args: Record<string, unknown>): Promise<Match[]>;
}

/** Run the real `find` against the page rooted at `html`. */
async function findOn(html: El, args: Record<string, unknown>): Promise<Match[]> {
  const els = all(html);
  const mod = loadExtensionModule<ContentModule>(CONTENT, {
    globals: {
      document: {
        // "*", the ref-attribute scan, or a bare tag name - all this DOM needs.
        querySelectorAll: (sel: string) =>
          sel === "*"
            ? els
            : sel.startsWith("[")
              ? els.filter((e) => e.attrs["data-bmcp-ref"])
              : els.filter((e) => e.tagName === sel.toUpperCase()),
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      Node: { TEXT_NODE: 3 },
    },
    mocks: {
      "./run-func": {
        runFunc: async (_t: number, fn: (...a: unknown[]) => unknown, a: unknown[]) => fn(...a),
      },
    },
  });
  try {
    return await mod.exports.find(1, args);
  } finally {
    mod.dispose();
  }
}

describe("find returns the innermost match", () => {
  it("a link inside wrappers comes back alone", async () => {
    const page = h("html", {}, h("body", {}, h("div", {}, h("a", { href: "/login" }, "Sign in"))));
    const m = await findOn(page, { text: "Sign in" });
    assert.deepEqual(
      Array.from(m, (x) => x.tag),
      ["a"],
    );
    assert.equal(m[0]!.role, "link");
  });

  it("the wrappers cannot crowd the target out of a small max", async () => {
    const page = h("html", {}, h("body", {}, h("div", {}, h("a", { href: "/login" }, "Sign in"))));
    const m = await findOn(page, { text: "Sign in", max: 2 });
    assert.deepEqual(
      Array.from(m, (x) => x.tag),
      ["a"],
    );
  });

  it("a control keeps its match over the label span inside it", async () => {
    const page = h(
      "html",
      {},
      h("body", {}, h("button", { "aria-label": "Sign in" }, h("span", {}, "Sign in"))),
    );
    const m = await findOn(page, { text: "Sign in" });
    assert.deepEqual(
      Array.from(m, (x) => x.tag),
      ["button"],
    );
  });

  it("two separate matches both come back, in page order", async () => {
    const page = h(
      "html",
      {},
      h("body", {}, h("a", { href: "/a" }, "Sign in"), h("p", {}, "Please sign in first")),
    );
    const m = await findOn(page, { text: "sign in" });
    assert.deepEqual(
      Array.from(m, (x) => x.tag),
      ["a", "p"],
    );
  });

  it("dropped wrappers are not tagged with refs", async () => {
    const div = h("div", {}, h("a", { href: "/login" }, "Sign in"));
    await findOn(h("html", {}, h("body", {}, div)), { text: "Sign in" });
    assert.equal(div.getAttribute("data-bmcp-ref"), null);
  });

  it("a selector without text still returns nested matches - the agent asked for those", async () => {
    const page = h(
      "html",
      {},
      h("body", {}, h("ul", {}, h("li", {}, "x", h("ul", {}, h("li", {}, "y"))))),
    );
    const m = await findOn(page, { selector: "ul" });
    assert.equal(m.length, 2);
  });
});

describe("find with a selector sees what is not drawn", () => {
  const page = () =>
    h(
      "html",
      {},
      h("head", {}, h("meta", { name: "user-login", content: "octocat" })),
      h("body", {}, h("a", { href: "/login" }, "Sign in")),
    );

  it("a <meta> in <head> is found by selector, marked hidden, with its content", async () => {
    const m = await findOn(page(), { selector: "meta" });
    assert.equal(m.length, 1);
    assert.equal(m[0]!.tag, "meta");
    assert.equal(m[0]!.hidden, true);
    assert.equal(m[0]!.attrs?.content, "octocat");
  });

  it("a text search still skips what is not drawn", async () => {
    const m = await findOn(page(), { text: "octocat" });
    assert.equal(m.length, 0);
  });

  it("a drawn match is not marked hidden", async () => {
    const m = await findOn(page(), { selector: "a" });
    assert.equal(m[0]!.hidden, undefined);
  });
});

describe("find returns the attributes that carry data", () => {
  it("a <relative-time> carries its datetime", async () => {
    const page = h(
      "html",
      {},
      h("body", {}, h("relative-time", { datetime: "2026-10-01T12:00:00Z" }, "2 days ago")),
    );
    const m = await findOn(page, { text: "days ago" });
    assert.equal(m[0]!.attrs?.datetime, "2026-10-01T12:00:00Z");
  });

  it("id, href and title come back; other attributes and absent ones do not", async () => {
    const page = h(
      "html",
      {},
      h("body", {}, h("a", { id: "go", href: "/login", title: "Log in", class: "btn" }, "Sign in")),
    );
    const m = await findOn(page, { text: "Sign in" });
    assert.equal(
      JSON.stringify(m[0]!.attrs),
      JSON.stringify({ id: "go", href: "/login", title: "Log in" }),
    );
  });

  it("a match with none of them carries no attrs at all", async () => {
    const page = h("html", {}, h("body", {}, h("button", {}, "Save")));
    const m = await findOn(page, { text: "Save" });
    assert.equal(m[0]!.attrs, undefined);
  });
});

describe("find names an icon-only control (F12)", () => {
  const page = () =>
    h(
      "html",
      {},
      h("body", {}, h("div", {}, h("button", {}, h("img", { alt: "Settings", src: "cog.png" })))),
    );

  it("a button holding only an image is named by the image's alt", async () => {
    const m = await findOn(page(), { selector: "button" });
    assert.equal(m[0]!.name, "Settings");
  });

  it("so a text search for that name finds the button itself", async () => {
    const m = await findOn(page(), { text: "settings" });
    assert.deepEqual(
      Array.from(m, (x) => x.tag),
      ["button"],
    );
  });

  it("a wrapper is never named from an image inside it", async () => {
    const m = await findOn(page(), { selector: "div" });
    assert.equal(m[0]!.name, "");
  });
});

/** The find tool's reply for a browser that answered `matches`. */
async function reply(matches: Match[]): Promise<string> {
  const ctx = { sendSocketMessage: async () => matches } as unknown as Context;
  const r = await findTool.handle(ctx, { selector: "x" });
  return (r.content[0] as { text: string }).text;
}

describe("find reply prints the tag and the attributes", () => {
  it("a meta: tag, content and hidden", async () => {
    assert.equal(
      await reply([
        {
          ref: "e1",
          role: "meta",
          name: "",
          tag: "meta",
          attrs: { content: "octocat" },
          hidden: true,
        },
      ]),
      '- meta [ref=e1] <meta content="octocat"> (hidden)',
    );
  });

  it("a link: role, name, then the tag with its href", async () => {
    assert.equal(
      await reply([
        { ref: "e2", role: "link", name: "Sign in", tag: "a", attrs: { id: "go", href: "/login" } },
      ]),
      '- link "Sign in" [ref=e2] <a href="/login" id="go">',
    );
  });

  it("a div acting as a button shows its real tag", async () => {
    assert.equal(
      await reply([{ ref: "e3", role: "button", name: "Go", tag: "div" }]),
      '- button "Go" [ref=e3] <div>',
    );
  });

  it("a plain button prints as before - no tag that repeats the role", async () => {
    assert.equal(
      await reply([{ ref: "e4", role: "button", name: "Save", tag: "button" }]),
      '- button "Save" [ref=e4]',
    );
  });

  it("a quote inside a value cannot break the line", async () => {
    assert.match(
      await reply([{ ref: "e5", role: "a", name: "", tag: "a", attrs: { title: 'say "hi"' } }]),
      /title="say \\"hi\\""/,
    );
  });
});
