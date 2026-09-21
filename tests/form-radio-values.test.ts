/**
 * A radio honours the value it was given (B10).
 *
 * The bug: the injected fill computed the boolean and then threw it away for
 * radios — `inp.checked = inp.type === "radio" ? true : on`. So
 * `{ ref: <radio>, value: "false" }` SELECTED the option it had been asked to
 * leave alone, displaced whatever was selected in that group, and reported full
 * success. Every unsupported value did the same: "banana" selected the radio.
 *
 * These cases run the REAL injected function against a hand-built DOM rather than
 * asserting on a mock. The function is serialised by source and executed in the
 * page, so what matters is what it does to elements — and a test that mocked the
 * element would be asserting the shape of the call rather than the state it
 * leaves behind. The DOM here is deliberately tiny and dependency-free: `jsdom`
 * for one branch of one function would be a package to keep current forever.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

const FORMS = "Chrome-extension/lib/automation/forms.ts";

interface FieldResult {
  ref: string;
  ok: boolean;
  error?: string;
}

interface FormsModule {
  fillForm(
    tabId: number,
    args: { fields: Array<{ ref: string; value: string }> },
  ): Promise<{ filled: number; total: number; errors: FieldResult[] }>;
}

/** One fake element: the surface `fillFormFn` actually touches on an input. */
interface FakeInput {
  ref: string;
  tagName: string;
  type: string;
  name?: string;
  checked: boolean;
  /** Every event this element dispatched, in order — "input", "change". */
  events: string[];
  scrollIntoView(): void;
  dispatchEvent(ev: { type: string }): boolean;
  getAttribute(name: string): string | null;
  shadowRoot: null;
  isContentEditable: boolean;
}

function input(ref: string, type: string, checked = false, name?: string): FakeInput {
  return {
    ref,
    tagName: "INPUT",
    type,
    name,
    checked,
    events: [],
    scrollIntoView() {},
    dispatchEvent(ev) {
      this.events.push(ev.type);
      return true;
    },
    getAttribute: () => null,
    shadowRoot: null,
    isContentEditable: false,
  };
}

/**
 * The globals the injected function closes over, backed by `elements`.
 *
 * `querySelector` is given the one selector the function builds —
 * `[data-bmcp-ref="<ref>"]` — and answers from the list. `querySelectorAll("*")`
 * drives the shadow-root and iframe walk, which has nothing to find here and must
 * simply not throw.
 */
function domFor(elements: FakeInput[]) {
  const REF = /\[data-bmcp-ref="([^"]+)"\]/;
  const document = {
    querySelector: (selector: string) => {
      const ref = REF.exec(selector)?.[1];
      return elements.find((e) => e.ref === ref) ?? null;
    },
    querySelectorAll: () => elements,
  };
  // Present only so the references resolve: `setNativeValue` reads
  // `.prototype`, and the frame walk uses `instanceof`. No radio path reaches
  // either, and a missing `value` setter falls through to plain assignment.
  const HTMLInputElement = { prototype: {} };
  const HTMLTextAreaElement = { prototype: {} };
  class HTMLIFrameElement {}
  class Event {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  class InputEvent extends Event {}
  return { document, HTMLInputElement, HTMLTextAreaElement, HTMLIFrameElement, Event, InputEvent };
}

/**
 * Load the real forms module and let the injected function RUN, instead of
 * recording that it was asked to.
 */
function loadForms(elements: FakeInput[]) {
  const mod = loadExtensionModule<FormsModule>(FORMS, {
    globals: { chrome: {}, ...domFor(elements) },
    mocks: {
      "./driver": { parseRef: (ref: string) => ({ frameId: 0, bare: ref }) },
      "./run-func": {
        runFunc: async (_tabId: number, fn: (...a: unknown[]) => unknown, args: unknown[]) =>
          fn(...args),
      },
    },
  });
  return { fillForm: mod.exports.fillForm, dispose: mod.dispose };
}

/** Fill one field and hand back the batch result. */
async function fill(elements: FakeInput[], ref: string, value: string) {
  const { fillForm, dispose } = loadForms(elements);
  try {
    return await fillForm(1, { fields: [{ ref, value }] });
  } finally {
    dispose();
  }
}

describe("filling a radio honours the value", () => {
  it('"false" does not select an unselected radio', async () => {
    const radio = input("r1", "radio", false, "plan");
    const r = await fill([radio], "r1", "false");
    assert.equal(r.filled, 1, JSON.stringify(r.errors));
    assert.equal(radio.checked, false, '"false" selected the radio');
  });

  it('"false" clears a radio that WAS selected', async () => {
    const radio = input("r1", "radio", true, "plan");
    const r = await fill([radio], "r1", "false");
    assert.equal(r.filled, 1, JSON.stringify(r.errors));
    assert.equal(radio.checked, false);
    assert.deepEqual(radio.events, ["input", "change"], "a real change must report itself");
  });

  it('"true" selects a radio from either starting state', async () => {
    const fresh = input("r1", "radio", false, "plan");
    await fill([fresh], "r1", "true");
    assert.equal(fresh.checked, true);
    assert.deepEqual(fresh.events, ["input", "change"]);

    const already = input("r1", "radio", true, "plan");
    await fill([already], "r1", "true");
    assert.equal(already.checked, true, "re-selecting must not turn it off");
  });

  it("does not fire change for a state that did not change", async () => {
    // A radio's `onChange` handler commonly selects `event.target.value`, so an
    // event for a non-change would re-select the option a "false" just cleared.
    const already = input("r1", "radio", true, "plan");
    await fill([already], "r1", "true");
    assert.deepEqual(already.events, [], "fired change without changing anything");

    const stillOff = input("r2", "radio", false, "plan");
    await fill([stillOff], "r2", "false");
    assert.deepEqual(stillOff.events, []);
  });

  it("clearing one option of a group leaves the others alone", async () => {
    // The group is three radios sharing a name. Clearing the selected one must
    // not promote another — the group ends with nothing selected, which is what
    // was asked for.
    const a = input("ra", "radio", true, "plan");
    const b = input("rb", "radio", false, "plan");
    const c = input("rc", "radio", false, "plan");
    const r = await fill([a, b, c], "ra", "false");
    assert.equal(r.filled, 1, JSON.stringify(r.errors));
    assert.deepEqual(
      [a.checked, b.checked, c.checked],
      [false, false, false],
      "clearing one option displaced another",
    );
  });

  it("selecting one option of a group is still how a group is set", async () => {
    const a = input("ra", "radio", true, "plan");
    const b = input("rb", "radio", false, "plan");
    const { fillForm, dispose } = loadForms([a, b]);
    try {
      // The browser itself unselects the sibling; a fake DOM has no group, so
      // this asserts only what the fill DID — it set the one it was given, and
      // touched no other element.
      const r = await fillForm(1, { fields: [{ ref: "rb", value: "true" }] });
      assert.equal(r.filled, 1, JSON.stringify(r.errors));
      assert.equal(b.checked, true);
      assert.deepEqual(b.events, ["input", "change"]);
      assert.deepEqual(a.events, [], "the fill touched an element it was not given");
    } finally {
      dispose();
    }
  });

  it("refuses a value that is neither, instead of silently selecting", async () => {
    // This is how a <select> is filled twenty lines above in the same function,
    // so it is the mistake to expect — and before the fix it SELECTED the radio.
    const radio = input("r1", "radio", false, "plan");
    const r = await fill([radio], "r1", "Male");
    assert.equal(r.filled, 0);
    assert.equal(radio.checked, false, "an unsupported value selected the radio");
    assert.match(r.errors[0]!.error ?? "", /not a radio value/);
    assert.match(r.errors[0]!.error ?? "", /"true" or "false"/);
    assert.match(r.errors[0]!.error ?? "", /that option's own ref/i);
  });

  it("still accepts every documented spelling of the boolean", async () => {
    for (const yes of ["true", "1", "on", "yes", "checked", "TRUE"]) {
      const el = input("r1", "radio", false);
      await fill([el], "r1", yes);
      assert.equal(el.checked, true, `"${yes}" should select`);
    }
    for (const no of ["false", "0", "off", "no", "unchecked", "FALSE"]) {
      const el = input("r1", "radio", true);
      await fill([el], "r1", no);
      assert.equal(el.checked, false, `"${no}" should clear`);
    }
  });
});

describe("checkbox behaviour is unchanged", () => {
  it("checks and unchecks from either state", async () => {
    const off = input("c1", "checkbox", false);
    await fill([off], "c1", "true");
    assert.equal(off.checked, true);
    assert.deepEqual(off.events, ["input", "change"]);

    const on = input("c1", "checkbox", true);
    await fill([on], "c1", "false");
    assert.equal(on.checked, false);
    assert.deepEqual(on.events, ["input", "change"]);
  });

  it("refuses an unsupported value for a checkbox too", async () => {
    const box = input("c1", "checkbox", false);
    const r = await fill([box], "c1", "banana");
    assert.equal(r.filled, 0);
    assert.equal(box.checked, false);
    assert.match(r.errors[0]!.error ?? "", /not a checkbox value/);
  });

  it("reports per field, so one bad value does not lose a good one", async () => {
    const good = input("c1", "checkbox", false);
    const bad = input("r1", "radio", false);
    const { fillForm, dispose } = loadForms([good, bad]);
    try {
      const r = await fillForm(1, {
        fields: [
          { ref: "c1", value: "true" },
          { ref: "r1", value: "maybe" },
        ],
      });
      assert.equal(r.filled, 1);
      assert.equal(r.total, 2);
      assert.equal(good.checked, true, "a good field was lost to a bad one");
      assert.equal(r.errors[0]!.ref, "r1");
    } finally {
      dispose();
    }
  });
});
