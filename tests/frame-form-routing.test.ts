/**
 * Form fills and clears reach the frame that holds the field (B08).
 *
 * The bug: `browser_fill_form { ref: "f3:e1a2" }` searched the TOP document for a
 * literal `data-bmcp-ref="f3:e1a2"` attribute. Nothing has that attribute — the
 * real field inside frame 3 carries the bare `e1a2` — so the tool filled zero
 * fields and reported a per-field "not found", advising a fresh snapshot that
 * would hand back the very same ref.
 *
 * These cases assert the three things that make a routed batch trustworthy: it
 * runs in the right frame with the prefix off, it preserves the caller's input
 * ORDER across frames, and it reports back the refs the caller actually wrote.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

const FORMS = "Chrome-extension/lib/automation/forms.ts";

interface FormsModule {
  fillForm(
    tabId: number,
    args: { fields: Array<{ ref: string; value: string }> },
  ): Promise<{ filled: number; total: number; errors: Array<{ ref: string; error?: string }> }>;
  clear(tabId: number, args: { ref: string }): Promise<{ ok: true }>;
}

/**
 * One injection: the frame it went to, and the refs it carried.
 *
 * `frameId` is normalised from omitted to 0 when recorded. `runFunc` already
 * treats the two identically (`frameId != null && frameId !== 0 ? ... : {tabId}`),
 * so an assertion that distinguished them would be testing the call's spelling
 * rather than where the fill landed - and the unchanged-behaviour cases below
 * would then fail against the old code for no behavioural reason.
 */
interface Injection {
  frameId: number;
  refs: string[];
  values: string[];
}

/**
 * Load the real forms module with the injection boundary replaced.
 *
 * `forms.ts` imports `./driver` for `parseRef`, and the harness resolves that to
 * real source — so `driver.ts`'s own three imports are mocked here too. One mocks
 * map covers the whole graph because it is keyed by specifier.
 *
 * `failBare` names bare refs the injected function should report as not found, so
 * failure attribution can be checked without a browser.
 */
function loadForms(failBare: string[] = []) {
  const injections: Injection[] = [];
  const mod = loadExtensionModule<FormsModule>(FORMS, {
    globals: { chrome: {} },
    mocks: {
      "../preserved-logs": { getPreserved: async () => [] },
      "./emulate": { waitMultiplier: () => 1 },
      "./run-func": {
        runFunc: async (
          _tabId: number,
          _fn: unknown,
          args: unknown[],
          _world?: string,
          frameId?: number,
        ) => {
          // `fillFormFn` takes an array of fields; `clearFn` takes one ref string.
          if (Array.isArray(args[0])) {
            const fields = args[0] as Array<{ ref: string; value: string }>;
            injections.push({
              frameId: frameId ?? 0,
              refs: fields.map((f) => f.ref),
              values: fields.map((f) => f.value),
            });
            return {
              results: fields.map((f) =>
                failBare.includes(f.ref)
                  ? {
                      ref: f.ref,
                      ok: false,
                      error: `ref "${f.ref}" not found — take a fresh browser_snapshot/browser_find.`,
                    }
                  : { ref: f.ref, ok: true },
              ),
            };
          }
          const ref = args[0] as string;
          injections.push({ frameId: frameId ?? 0, refs: [ref], values: [] });
          return failBare.includes(ref)
            ? {
                ok: false,
                error: `Element ref "${ref}" not found — take a fresh browser_snapshot.`,
              }
            : { ok: true };
        },
        runFuncAllFrames: async () => [],
        unwrap: <T>(r: T) => r,
      },
    },
  });
  return { ...mod, injections };
}

/** Copy a value out of the module's realm — `node:vm` gives it its own prototypes. */
const own = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("frame form routing", () => {
  it("fills a frame-scoped field inside its frame, with the prefix stripped", async () => {
    const forms = loadForms();
    try {
      // The reproduction: this used to inject into the top document with the
      // prefix still attached and fill nothing at all.
      const r = await forms.exports.fillForm(1, {
        fields: [{ ref: "f3:e1a2", value: "hello" }],
      });
      assert.equal(forms.injections.length, 1);
      assert.equal(forms.injections[0]!.frameId, 3, "the fill must run inside frame 3");
      assert.deepEqual(own(forms.injections[0]!.refs), ["e1a2"], "the prefix is stripped");
      assert.equal(r.filled, 1);
      assert.equal(r.total, 1);
    } finally {
      forms.dispose();
    }
  });

  it("reports the ref the caller wrote, not the bare one it injected", async () => {
    const forms = loadForms(["e1a2"]);
    try {
      const r = await forms.exports.fillForm(1, {
        fields: [{ ref: "f3:e1a2", value: "hello" }],
      });
      assert.equal(r.filled, 0);
      assert.equal(own(r.errors).length, 1);
      assert.equal(
        own(r.errors)[0]!.ref,
        "f3:e1a2",
        "an agent has only ever seen the prefixed ref; the bare one would be unrecognisable",
      );
      assert.match(
        own(r.errors)[0]!.error!,
        /"f3:e1a2"/,
        "the message text must name the caller's ref too, not the internal one",
      );
    } finally {
      forms.dispose();
    }
  });

  it("keeps a single-frame batch to ONE injection", async () => {
    const forms = loadForms();
    try {
      // The whole point of the tool is one round-trip. Grouping must not turn a
      // three-field form into three calls.
      await forms.exports.fillForm(1, {
        fields: [
          { ref: "f3:e1a2", value: "a" },
          { ref: "f3:e9c4", value: "b" },
          { ref: "f3:eaaa", value: "c" },
        ],
      });
      assert.equal(forms.injections.length, 1);
      assert.deepEqual(own(forms.injections[0]!.refs), ["e1a2", "e9c4", "eaaa"]);
    } finally {
      forms.dispose();
    }
  });

  it("preserves input order across frames rather than gathering each frame's fields", async () => {
    const forms = loadForms();
    try {
      // A country select in the top page can reveal a state select in the widget,
      // which then feeds a postcode back in the top page. Grouping all top-page
      // fields together would fill the third before the second, so the batch is
      // split into CONSECUTIVE runs instead.
      await forms.exports.fillForm(1, {
        fields: [
          { ref: "e1a2", value: "first" },
          { ref: "f3:e9c4", value: "second" },
          { ref: "eaaa", value: "third" },
        ],
      });
      assert.equal(forms.injections.length, 3, "three runs, in the caller's order");
      assert.deepEqual(
        own(forms.injections).map((i) => [i.frameId, i.refs, i.values]),
        [
          [0, ["e1a2"], ["first"]],
          [3, ["e9c4"], ["second"]],
          [0, ["eaaa"], ["third"]],
        ],
      );
    } finally {
      forms.dispose();
    }
  });

  it("returns every field's result in the caller's order, across frames", async () => {
    const forms = loadForms(["e9c4"]);
    try {
      const r = await forms.exports.fillForm(1, {
        fields: [
          { ref: "e1a2", value: "first" },
          { ref: "f3:e9c4", value: "second" },
          { ref: "eaaa", value: "third" },
        ],
      });
      assert.equal(r.total, 3);
      assert.equal(r.filled, 2);
      assert.deepEqual(
        own(r.errors).map((e) => e.ref),
        ["f3:e9c4"],
        "the failure is attributed to the field that actually failed",
      );
    } finally {
      forms.dispose();
    }
  });

  it("runs two adjacent fields of the same frame together, and a third frame separately", async () => {
    const forms = loadForms();
    try {
      await forms.exports.fillForm(1, {
        fields: [
          { ref: "f3:e1a2", value: "a" },
          { ref: "f3:e9c4", value: "b" },
          { ref: "f4:eaaa", value: "c" },
        ],
      });
      assert.deepEqual(
        own(forms.injections).map((i) => [i.frameId, i.refs]),
        [
          [3, ["e1a2", "e9c4"]],
          [4, ["eaaa"]],
        ],
      );
    } finally {
      forms.dispose();
    }
  });

  it("refuses a malformed prefix before writing ANY field", async () => {
    const forms = loadForms();
    try {
      // Discovered on field three, the old code would already have written two —
      // a half-filled form with no way to tell how far it got. Every address is
      // parsed before the first mutation.
      const err = await forms.exports
        .fillForm(1, {
          fields: [
            { ref: "e1a2", value: "a" },
            { ref: "f3:e9c4", value: "b" },
            { ref: "fx:eaaa", value: "c" },
          ],
        })
        .then(
          () => {
            throw new assert.AssertionError({ message: "expected a refusal, got success" });
          },
          (e: Error) => e,
        );
      assert.match(err.message, /^BAD_ARGS: /);
      assert.match(err.message, /not a usable element ref/);
      assert.equal(forms.injections.length, 0, "no field may be written before the refusal");
    } finally {
      forms.dispose();
    }
  });

  it("still fills a plain top-page batch exactly as before", async () => {
    const forms = loadForms();
    try {
      const r = await forms.exports.fillForm(1, {
        fields: [
          { ref: "e1a2", value: "a" },
          { ref: "e9c4", value: "b" },
        ],
      });
      assert.equal(forms.injections.length, 1);
      assert.equal(forms.injections[0]!.frameId, 0);
      assert.deepEqual(own(forms.injections[0]!.refs), ["e1a2", "e9c4"]);
      assert.equal(r.filled, 2);
    } finally {
      forms.dispose();
    }
  });

  it("clears a frame-scoped field inside its frame", async () => {
    const forms = loadForms();
    try {
      await forms.exports.clear(1, { ref: "f3:e1a2" });
      assert.equal(forms.injections[0]!.frameId, 3);
      assert.deepEqual(own(forms.injections[0]!.refs), ["e1a2"]);
    } finally {
      forms.dispose();
    }
  });

  it("names the caller's ref when a frame-scoped clear fails", async () => {
    const forms = loadForms(["e1a2"]);
    try {
      const err = await forms.exports.clear(1, { ref: "f3:e1a2" }).then(
        () => {
          throw new assert.AssertionError({ message: "expected a refusal, got success" });
        },
        (e: Error) => e,
      );
      assert.match(err.message, /"f3:e1a2"/);
    } finally {
      forms.dispose();
    }
  });

  it("refuses a malformed prefix on clear", async () => {
    const forms = loadForms();
    try {
      const err = await forms.exports.clear(1, { ref: "f3:" }).then(
        () => {
          throw new assert.AssertionError({ message: "expected a refusal, got success" });
        },
        (e: Error) => e,
      );
      assert.match(err.message, /^BAD_ARGS: /);
      assert.equal(forms.injections.length, 0);
    } finally {
      forms.dispose();
    }
  });

  it("still clears a top-page field exactly as before", async () => {
    const forms = loadForms();
    try {
      await forms.exports.clear(1, { ref: "e1a2" });
      assert.equal(forms.injections[0]!.frameId, 0);
      assert.deepEqual(own(forms.injections[0]!.refs), ["e1a2"]);
    } finally {
      forms.dispose();
    }
  });
});
