/**
 * Form ops — DEBUGGER-FREE (chrome.scripting, ISOLATED world).
 *
 *   - `fillForm` — set many fields in ONE round-trip (inputs, textareas, selects,
 *     checkboxes, radios, contenteditable). Mirrors Chrome DevTools MCP's
 *     `fill_form`: far fewer turns than one `browser_type` per field.
 *   - `clear`    — empty an input/textarea/contenteditable.
 *
 * Injected functions are self-contained (serialised by source).
 *
 * Both tools take refs that may name a FRAME (`f3:e1a2`), and both route into it
 * rather than searching the top document for a literal prefixed attribute — which
 * is what they used to do, finding nothing and filling zero fields while the real
 * field sat in frame 3 under the bare ref (B08). `parseRef` is imported rather
 * than re-derived so there is one definition of what a ref means; the direction is
 * acyclic, as `driver.ts` imports nothing from here.
 */
import { parseRef } from "./driver";
import { runFunc } from "./run-func";

interface FieldResult {
  ref: string;
  ok: boolean;
  error?: string;
}

function fillFormFn(
  fields: Array<{ ref: string; value: string }>,
): { results: FieldResult[] } {
  // Shadow roots and same-origin iframes, same as the interaction engine's
  // resolver. A bare `querySelector` misses a field inside a web component, so a
  // design-system input that `browser_type` can reach was unfillable here.
  // `executeScript` serialises this function by SOURCE and cannot see module
  // scope, so the walk has to be inline — it is not a copy by choice.
  const findEl = (ref: string, root: Document | ShadowRoot): HTMLElement | null => {
    const direct = root.querySelector(`[data-bmcp-ref="${ref}"]`) as HTMLElement | null;
    if (direct) return direct;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) {
        const found = findEl(ref, shadow);
        if (found) return found;
      }
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const found = findEl(ref, doc as unknown as Document);
            if (found) return found;
          }
        } catch {
          /* cross-origin frame — reached by its own injection, not from here */
        }
      }
    }
    return null;
  };

  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      el.tagName.toLowerCase() === "input"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else (el as any).value = value;
  };

  const fire = (el: Element, type: string, init?: any) =>
    el.dispatchEvent(
      type === "input"
        ? new InputEvent("input", { bubbles: true, ...(init || {}) })
        : new Event(type, { bubbles: true }),
    );

  const one = (field: { ref: string; value: string }): FieldResult => {
    const el = findEl(field.ref, document);
    if (!el)
      return {
        ref: field.ref,
        ok: false,
        error: `ref "${field.ref}" not found — take a fresh browser_snapshot/browser_find.`,
      };
    const tag = el.tagName.toLowerCase();
    try {
      el.scrollIntoView({ block: "center" });
    } catch {
      /* ignore */
    }

    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const want = field.value;
      let matched = false;
      for (const opt of Array.from(sel.options)) {
        const on = opt.value === want || opt.label === want || opt.text === want;
        opt.selected = sel.multiple ? on || opt.selected : on;
        if (on) matched = true;
      }
      if (!matched)
        return { ref: field.ref, ok: false, error: `no <option> matched "${want}"` };
      fire(sel, "input");
      fire(sel, "change");
      return { ref: field.ref, ok: true };
    }

    if (tag === "input") {
      const inp = el as HTMLInputElement;
      if (inp.type === "checkbox" || inp.type === "radio") {
        // BOTH halves of the convention are spelled out, because a value in
        // neither half is a mistake rather than a false (B10). A radio used to
        // be set `checked = true` whatever it was given, so `value: "false"`
        // selected the option it was asked to leave alone and reported success;
        // answering that by silently leaving it unselected would be the same
        // silence pointing the other way. `{ value: "Male" }` is how a <select>
        // is filled twenty lines above, so it is the mistake to expect.
        const on = /^(true|1|on|yes|checked)$/i.test(field.value);
        const off = /^(false|0|off|no|unchecked)$/i.test(field.value);
        if (!on && !off) {
          return {
            ref: field.ref,
            ok: false,
            error:
              `"${field.value}" is not a ${inp.type} value — use "true" or "false". ` +
              `To choose one option of a group, fill THAT option's own ref with "true".`,
          };
        }
        const was = inp.checked;
        inp.checked = on;
        // Only when it actually changed. A `change` event for a change that did
        // not happen is a real event to whatever framework is listening, and on
        // the new false path that is not merely noisy: a radio's `onChange`
        // handler commonly reads `event.target.value` and selects that option,
        // so firing it for an already-unselected radio would re-select the very
        // option the caller asked to clear.
        if (was !== on) {
          fire(inp, "input");
          fire(inp, "change");
        }
        return { ref: field.ref, ok: true };
      }
      try {
        inp.focus();
      } catch {
        /* ignore */
      }
      setNativeValue(inp, field.value);
      fire(inp, "input", { inputType: "insertText", data: field.value });
      fire(inp, "change");
      return { ref: field.ref, ok: true };
    }

    if (tag === "textarea") {
      const ta = el as HTMLTextAreaElement;
      try {
        ta.focus();
      } catch {
        /* ignore */
      }
      setNativeValue(ta, field.value);
      fire(ta, "input", { inputType: "insertText", data: field.value });
      fire(ta, "change");
      return { ref: field.ref, ok: true };
    }

    if ((el as HTMLElement).isContentEditable) {
      el.textContent = field.value;
      fire(el, "input", { inputType: "insertText", data: field.value });
      return { ref: field.ref, ok: true };
    }

    return { ref: field.ref, ok: false, error: `<${tag}> is not a fillable field` };
  };

  return { results: (fields || []).map(one) };
}

export async function fillForm(
  tabId: number,
  args: { fields: Array<{ ref: string; value: string }> },
): Promise<{ filled: number; total: number; errors: FieldResult[] }> {
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new Error("browser_fill_form requires a non-empty `fields` array.");
  }

  // EVERY address is parsed before ANY field is written. A malformed prefix in
  // field nine used to be discovered after eight fields had already been set,
  // leaving the form half-filled with no way to tell how far it got; `parseRef`
  // throws here instead, before the first mutation.
  const parsed = args.fields.map((f) => {
    const { frameId, bare } = parseRef(f.ref);
    return { frameId, bare, original: f.ref, value: f.value };
  });

  // Grouped into CONSECUTIVE runs of one frame, not one group per frame. A batch
  // of [top, frame, top] is three injections in that order — because form fields
  // depend on each other (a country select that reveals a state select), and
  // gathering all of one frame's fields together would silently reorder them.
  // Consecutive runs are the coarsest grouping that cannot change input order.
  const runs: Array<{ frameId: number; items: typeof parsed }> = [];
  for (const item of parsed) {
    const last = runs[runs.length - 1];
    if (last && last.frameId === item.frameId) last.items.push(item);
    else runs.push({ frameId: item.frameId, items: [item] });
  }

  const results: FieldResult[] = [];
  for (const run of runs) {
    let r: { results: FieldResult[] };
    try {
      r = await runFunc(
        tabId,
        fillFormFn,
        [run.items.map((i) => ({ ref: i.bare, value: i.value }))],
        "ISOLATED",
        run.frameId,
      );
    } catch (e: any) {
      // A frame that cannot be injected into — it named an id that does not
      // exist, or it navigated away mid-batch — fails ITS OWN fields and no
      // others. Letting the throw escape made one bad ref discard the results of
      // every field in the batch, including those already written, so an agent
      // was told the whole form failed when most of it had succeeded.
      for (const item of run.items) {
        results.push({
          ref: item.original,
          ok: false,
          error:
            run.frameId === 0
              ? String(e?.message || e)
              : `frame ${run.frameId} could not be reached (${e?.message || e}). ` +
                `Take a fresh browser_snapshot — the frame may have gone.`,
        });
      }
      continue;
    }
    // The injected function answers with the BARE ref it was given. An agent has
    // only ever seen the prefixed one, so every result is mapped back to the ref
    // the caller actually wrote — by position, since a frame could in principle
    // hold two fields with the same ref and a lookup by name could not tell them
    // apart.
    run.items.forEach((item, i) => {
      const got = r.results[i];
      results.push({
        ref: item.original,
        ok: got?.ok === true,
        ...(got?.ok === true
          ? {}
          : {
              error:
                got?.error?.replaceAll(item.bare, item.original) ?? "no result for this field",
            }),
      });
    });
  }

  const errors = results.filter((x) => !x.ok);
  return { filled: results.length - errors.length, total: results.length, errors };
}

// ── clear ─────────────────────────────────────────────────────────────────────

function clearFn(ref: string): { ok: boolean; error?: string } {
  // Same resolver as `fillFormFn`, and inline for the same reason: an injected
  // function is serialised by source and sees no module scope.
  const findEl = (root: Document | ShadowRoot): HTMLElement | null => {
    const direct = root.querySelector(`[data-bmcp-ref="${ref}"]`) as HTMLElement | null;
    if (direct) return direct;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) {
        const found = findEl(shadow);
        if (found) return found;
      }
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const found = findEl(doc as unknown as Document);
            if (found) return found;
          }
        } catch {
          /* cross-origin frame — reached by its own injection, not from here */
        }
      }
    }
    return null;
  };
  const el = findEl(document);
  if (!el)
    return { ok: false, error: `Element ref "${ref}" not found — take a fresh browser_snapshot.` };
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const inp = el as HTMLInputElement | HTMLTextAreaElement;
    const proto =
      tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try {
      inp.focus();
    } catch {
      /* ignore */
    }
    if (setter) setter.call(inp, "");
    else (inp as any).value = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" } as any));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }
  if ((el as HTMLElement).isContentEditable) {
    el.textContent = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" } as any));
    return { ok: true };
  }
  return { ok: false, error: `<${tag}> is not clearable` };
}

export async function clear(tabId: number, args: { ref: string }): Promise<{ ok: true }> {
  // Same reference rules as a fill: a `fN:` ref runs in that frame with the
  // prefix off, and the message an agent reads names the ref it actually passed.
  const { frameId, bare } = parseRef(args.ref);
  const r = await runFunc(tabId, clearFn, [bare], "ISOLATED", frameId);
  if (!r.ok) throw new Error(r.error?.replaceAll(bare, args.ref) || "clear failed");
  return { ok: true };
}
