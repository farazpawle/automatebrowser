/**
 * In-page automation engine — DEBUGGER-FREE.
 *
 * Everything runs through `chrome.scripting.executeScript` (no
 * `chrome.debugger`/CDP), so there is no "started debugging this browser"
 * banner, no attach latency, and no CDP-into-contenteditable hang. Snapshot and
 * interactions run in the extension's ISOLATED world (shares the page DOM);
 * `eval` and console capture run in the page's MAIN world.
 *
 * Element references survive between a snapshot and a later click/type because
 * the snapshot tags each interactive element with a `data-bmcp-ref` attribute —
 * the DOM itself is the registry, so no cross-call global state is needed.
 *
 * Injected functions MUST be self-contained: `executeScript` serialises a
 * function by its source, so each `func` defines all of its own helpers inline
 * and references no module-scope bindings.
 */

import { getPreserved } from "../preserved-logs";
import { waitMultiplier } from "./emulate";
import { requestSince } from "./network";
import { runFunc, runFuncAllFrames, unwrap } from "./run-func";

// ── snapshot ────────────────────────────────────────────────────────────────

/** Self-contained page walker: tags interactive elements + returns a readable tree. */
/**
 * `verbose` relaxes the lean filters rather than building a second tree: the same
 * walk, with the caps and minimums that make the default readable turned off, plus
 * structural landmarks. Refs are UNAFFECTED — they are derived from each element's
 * own signature, not from how much of the tree was printed — so a ref taken from a
 * verbose snapshot is the same ref a lean one would give, and the two are
 * interchangeable mid-task.
 */
function snapshotPage(verbose: boolean): { url: string; title: string; snapshot: string } {
  const REF_ATTR = "data-bmcp-ref";
  document
    .querySelectorAll("[" + REF_ATTR + "]")
    .forEach((e) => e.removeAttribute(REF_ATTR));

  let textBlocks = 0;
  const lines: string[] = [];

  // ── stable refs (B12) ──────────────────────────────────────────────────────
  // Refs used to be `e1, e2, …` in walk order, so inserting ONE element anywhere
  // renumbered every ref after it: anything an agent cached across a snapshot
  // silently pointed at a different element. A ref is now derived from the
  // element's own identity, so it is the same ref on the next snapshot of a page
  // that has merely re-rendered — which is what makes recovering a stale ref
  // meaningful rather than a coin flip.
  //
  // The signature deliberately reads ATTRIBUTES, not the computed accessible
  // name: the name can carry live content (a `<select>` names itself "3 options")
  // and would change the ref when the page changed nothing structural.
  const sigOf = (el: Element): string => {
    const a = (n: string) => el.getAttribute(n) || "";
    let t = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent || "";
    }
    return [
      el.tagName.toLowerCase(),
      a("id"),
      a("name"),
      a("type"),
      a("role"),
      a("aria-label"),
      a("placeholder"),
      (el as HTMLAnchorElement).getAttribute?.("href") || "",
      t.replace(/\s+/g, " ").trim().slice(0, 40),
    ].join("|");
  };
  // FNV-1a → exactly 4 base36 chars (36^4 ≈ 1.7M). A collision degrades to the
  // OLD behaviour for those two elements (ordered, not identified) — never worse.
  const hashOf = (s: string): string => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1679616).toString(36).padStart(4, "0");
  };
  const seen = new Map<string, number>();
  const refFor = (el: Element): string => {
    const h = hashOf(sigOf(el));
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return "e" + h + (n ? "." + n : "");
  };
  // Lean caps exist so a big SPA cannot fill the context window. Verbose is the
  // explicit "I need everything" escape hatch, so they lift rather than stretch.
  const MAX_TEXT_BLOCKS = verbose ? Number.POSITIVE_INFINITY : 80;
  const MIN_TEXT_LEN = verbose ? 1 : 24;
  const CLIP_LEN = verbose ? 400 : 160;
  /** Structural context, emitted only in verbose: noise in the lean tree. */
  const LANDMARKS: Record<string, string> = {
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", table: "table", ul: "list",
    ol: "list", li: "listitem", section: "region", article: "article",
  };

  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (!he.getClientRects || !he.getClientRects().length) return false;
    const st = getComputedStyle(he);
    return (
      st.visibility !== "hidden" &&
      st.display !== "none" &&
      Number(st.opacity || "1") !== 0
    );
  };

  const clip = (s: string): string => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > CLIP_LEN ? t.slice(0, CLIP_LEN - 3) + "…" : t;
  };

  const accName = (el: Element): string => {
    const he = el as HTMLElement;
    const label = he.getAttribute("aria-label");
    if (label) return clip(label);
    const lb = he.getAttribute("aria-labelledby");
    if (lb) {
      const txt = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (txt.trim()) return clip(txt);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const selected = Array.from(sel.selectedOptions)
        .map((o) => o.label || o.text || o.value)
        .filter(Boolean)
        .join(", ");
      const count = sel.options.length;
      return clip(selected ? `${selected} (${count} options)` : `${count} options`);
    }
    if (tag === "input") {
      const inp = el as HTMLInputElement;
      if (inp.labels && inp.labels.length)
        return clip(inp.labels[0]?.textContent || "");
      if (inp.placeholder) return clip(inp.placeholder);
      if (
        (inp.type === "button" || inp.type === "submit" || inp.type === "reset") &&
        inp.value
      )
        return clip(inp.value);
      if (inp.name) return clip(inp.name);
      return "";
    }
    if (tag === "img") return clip((el as HTMLImageElement).alt || "");
    return clip((he.innerText || he.textContent || "") as string);
  };
  // An icon-only control (`<button><i class="fa fa-cog"></i></button>`) has no
  // text, and a bare `- button` cannot be told from its neighbours (F12). Used
  // for controls only, never in `sigOf`: refs must not move with this.
  const fallbackName = (el: Element): string => {
    const title = el.getAttribute("title");
    if (title) return clip(title);
    const alt = el.querySelector("img[alt]")?.getAttribute("alt");
    if (alt) return clip(alt);
    const id = el.getAttribute("id");
    return id ? clip("#" + id) : "";
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset") return "button";
      return "textbox";
    }
    const map: Record<string, string> = {
      a: "link",
      button: "button",
      select: "combobox",
      textarea: "textbox",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      img: "img",
    };
    return map[tag] || "";
  };

  const interactiveTags = new Set(["a", "button", "input", "select", "textarea"]);
  const interactiveRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "switch",
    "combobox",
    "textbox",
    "option",
    "searchbox",
    "slider",
  ]);
  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (interactiveTags.has(tag)) return true;
    const role = el.getAttribute("role");
    if (role && interactiveRoles.has(role)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;
    if ((el as HTMLElement).tabIndex >= 0 && el.getAttribute("tabindex") != null)
      return true;
    return false;
  };

  const directText = (el: Element): string => {
    const chunks: string[] = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) chunks.push(node.textContent || "");
    }
    return clip(chunks.join(" "));
  };

  const walk = (el: Element, depth = 0): void => {
    const tag = el.tagName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "noscript" ||
      tag === "template" ||
      tag === "head"
    )
      return;
    if (!isVisible(el)) return;

    const indent = "  ".repeat(Math.min(depth, 8));
    // Depth advances only for an element that actually EMITS a line. A wrapper
    // <div> renders nothing of its own, so letting it indent its children made a
    // button inside two wrappers read as a CHILD of the button before it — the
    // tree misreported structure, which is exactly what sends an agent to the
    // wrong element. The top document's <body> is the one exception: it emits
    // nothing but anchors the snapshot's top level, so its children keep the base
    // indent. An INLINED frame's body is deliberately not an anchor — the
    // `- iframe` line above it already set that level, and counting both put the
    // frame's contents two levels deep instead of one.
    let emitted = el === document.body;

    if (isInteractive(el)) {
      const ref = refFor(el);
      el.setAttribute(REF_ATTR, ref);
      const role = roleOf(el) || tag;
      const name = accName(el) || fallbackName(el);
      const extra =
        tag === "input" && (el as HTMLInputElement).value && role === "textbox"
          ? ` value="${clip((el as HTMLInputElement).value)}"`
          : "";
      lines.push(`${indent}- ${role}${name ? ` "${name}"` : ""}${extra} [ref=${ref}]`);
      emitted = true;
    } else if (roleOf(el) === "heading") {
      const lvl = tag.match(/^h([1-6])$/)?.[1];
      const name = accName(el);
      if (name) {
        lines.push(`${indent}- heading "${name}"${lvl ? ` [level=${lvl}]` : ""}`);
        emitted = true;
      }
    } else if (
      textBlocks < MAX_TEXT_BLOCKS &&
      (verbose || !["body", "main", "section", "article", "div", "span"].includes(tag))
    ) {
      const text = directText(el);
      if (text.length >= MIN_TEXT_LEN) {
        textBlocks++;
        lines.push(`${indent}- text "${text}"`);
        emitted = true;
      } else if (verbose && LANDMARKS[tag]) {
        lines.push(`${indent}- ${LANDMARKS[tag]}`);
        emitted = true;
      }
    }

    if (tag === "iframe") {
      // At `indent`, NOT `indent + 2`. An <iframe> emits no line of its own (it
      // is neither interactive nor a heading nor a text block), so THIS is the
      // element's line and it must sit level with its siblings.
      //
      // The walk marks the frame and STOPS. It does not descend into
      // `contentDocument`, even when it could reach it (B08 follow-up).
      //
      // It used to. Every same-origin frame was then walked TWICE — inline by
      // this walk, and again by its own injection, since `snapshotFrames` injects
      // into every frame regardless. Two walks tag the same element with two
      // different refs (the second walk starts its disambiguation counter fresh),
      // and whichever ran last is the one the DOM keeps — so the snapshot could
      // print a ref that no longer resolved to anything. A frame NESTED inside a
      // cross-origin frame showed it plainly: both spellings were printed, and
      // only one worked.
      //
      // Walking each document exactly once removes the whole class. It also
      // removes the content-comparing de-duplication this used to need, which
      // could only ever compare against the TOP tree and so never saw this case.
      //
      // Not descending costs one thing, so it is paid for here: the old branch
      // dropped the marker when the frame's walk found nothing, which silently
      // hid the tracking pixels an ad page carries by the dozen. Without a walk
      // there is no "found nothing" to test, so the test becomes whether the
      // frame is VISIBLE AT ALL — which is what a 0x0 or `display:none` tracker
      // fails, and what a real embedded widget passes. Its contents are listed
      // below under their own frame block either way; this line is only the
      // marker saying an embedded document sits here.
      if (isVisible(el)) {
        lines.push(`${indent}- iframe`);
        emitted = true;
      }
    }

    const childDepth = emitted ? depth + 1 : depth;
    const childIndent = "  ".repeat(Math.min(childDepth, 8));

    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) {
      lines.push(`${childIndent}- shadow-root`);
      for (const child of Array.from(shadow.children)) walk(child, childDepth + 1);
    }

    for (const child of Array.from(el.children)) walk(child, childDepth);
  };

  if (document.body) walk(document.body);

  return {
    url: location.href,
    title: document.title,
    snapshot: lines.join("\n") || "(no visible interactive elements found)",
  };
}

// ── page quiet (F14) ────────────────────────────────────────────────────────

/**
 * Whether the page has stopped changing: true after `quietMs` with no DOM
 * mutation, false at `capMs`. The load event fires before a script-rendered
 * page (YouTube) has drawn anything, so a snapshot taken on it reads a shell.
 * Its own copy of refOpPage's post-action settle - an injected function cannot
 * call shared code.
 */
export function domQuietPage(quietMs: number, capMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let obs: MutationObserver | null = null;
    const done = (v: boolean) => {
      obs?.disconnect();
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve(v);
    };
    const hard = setTimeout(() => done(false), capMs);
    try {
      obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => done(true), quietMs);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      return done(true); // no observer → nothing to wait for
    }
    quiet = setTimeout(() => done(true), quietMs);
  });
}

// ── frames (B5) ─────────────────────────────────────────────────────────────

/**
 * A ref from a non-top frame is prefixed `f<frameId>:` — e.g. `f3:e7k2f`.
 *
 * The prefix is applied and stripped entirely in the WORKER: the injected walk
 * neither knows nor needs to know which frame it ran in, so cross-origin support
 * adds no new copy of the in-page resolver, and the `data-bmcp-ref` attribute
 * inside the frame stays exactly what a same-frame resolver expects.
 *
 * A BARE ref means the top frame — which is what every caller before B5 meant, so
 * nothing that worked before has to change.
 */
const FRAME_REF = /^f(\d+):(.+)$/;

export function parseRef(ref: string): { frameId: number; bare: string } {
  const raw = ref ?? "";
  const m = FRAME_REF.exec(raw);
  if (m) return { frameId: Number(m[1]), bare: m[2]! };
  // A ref carrying a colon that did NOT parse (`f3:`, `fx:e1a2`, `frame3:e1a2`) is
  // a MALFORMED frame prefix, not a bare ref — a snapshot never puts a colon in
  // one. Falling through would hand the whole string to the TOP frame as a literal
  // ref, so a typo'd frame number silently retargets the call at a different
  // document instead of saying so (B07). Refuse, and say what a ref looks like.
  if (raw.includes(":")) {
    throw new Error(
      `BAD_ARGS: "${raw}" is not a usable element ref. A ref from an embedded frame looks ` +
        `like "f3:e1a2"; a ref from the top page carries no prefix at all. Take a fresh ` +
        `browser_snapshot and copy the ref exactly as it is printed.`,
    );
  }
  return { frameId: 0, bare: raw };
}

/** The frame every ref in this call targets, and the refs with the prefix off. */
function frameOf(refs: string[]): { frameId: number; bare: string[] } {
  const parsed = refs.map(parseRef);
  const frameId = parsed[0]?.frameId ?? 0;
  // Every ref in ONE injected operation has to name the SAME frame, because the
  // operation is injected into exactly one. A bare ref means the TOP page — never
  // "whichever frame the other ref happened to name" — so `e1a2` alongside
  // `f3:e9c4` is a genuine mismatch rather than a shorthand.
  //
  // This used to take the first PREFIXED frame and run the whole op there, which
  // resolved every other ref inside it too: a same-named element in that frame
  // quietly stood in for the one the caller meant, and the call reported success
  // (B07). The refusal happens HERE, before injection, so nothing is clicked,
  // typed, dragged or re-tagged on the way to discovering the mismatch — and
  // cross-frame dragging, which no injected op could perform anyway, is refused
  // by the same check rather than half-done.
  if (parsed.some((p) => p.frameId !== frameId)) {
    throw new Error(
      `BAD_ARGS: every element ref in one call must come from the same frame, but ` +
        `${refs.map((r) => `"${r}"`).join(" and ")} do not. A ref with no prefix means the ` +
        `top page. Nothing on the page was changed — act on one frame at a time.`,
    );
  }
  return { frameId, bare: parsed.map((p) => p.bare) };
}

/**
 * How many frames a snapshot will include beyond the top one. An ad-heavy page
 * can carry dozens; without a cap the snapshot an agent has to read is mostly
 * tracking pixels. Frames with nothing interactive in them are dropped first, so
 * the cap almost never bites on a real page.
 *
 * It counts SAME-ORIGIN frames too, since the B08 follow-up — they are separate
 * blocks now rather than inline subtrees. A page with more than ten frames that
 * each hold something interactive will say the cap bit, where before the
 * same-origin ones were free. That is the deliberate cost of every document
 * being walked exactly once; the alternative was printing refs that do not
 * resolve.
 */
const MAX_FRAMES = 10;

/**
 * Snapshot the top document AND every frame the extension can reach, including
 * cross-origin ones (B5).
 *
 * EVERY frame is its own block, same-origin ones included, because each document
 * is walked exactly once — by its own injection. See `snapshotPage`'s iframe
 * branch for why walking one twice was worse than the extra block.
 */
async function snapshotFrames(
  tabId: number,
  verbose: boolean,
): Promise<{ url: string; title: string; snapshot: string }> {
  const results = await runFuncAllFrames(tabId, snapshotPage, [verbose]);
  const top = results.find((r) => r.frameId === 0)?.result;
  if (!top) {
    // No top frame means no page to snapshot — fall back to the single-frame path
    // so the failure is the same one callers already handle.
    return runFunc(tabId, snapshotPage, [verbose]);
  }

  const EMPTY = "(no visible interactive elements found)";
  const extra: string[] = [];
  let included = 0;
  for (const { frameId, result } of results) {
    if (frameId === 0 || !result) continue;
    if (!result.snapshot || result.snapshot === EMPTY) continue;
    if (included >= MAX_FRAMES) {
      extra.push(`- (more frames not shown — cap ${MAX_FRAMES})`);
      break;
    }
    included++;
    // Namespace every ref in this frame's tree, so two frames cannot mint the
    // same ref and an agent can hand the ref straight back.
    const namespaced = result.snapshot.replace(
      /\[ref=([^\]]+)\]/g,
      (_m, r) => `[ref=f${frameId}:${r}]`,
    );
    extra.push(`- frame ${result.url || `#${frameId}`}`, namespaced);
  }

  return {
    url: top.url,
    title: top.title,
    snapshot: extra.length ? `${top.snapshot}\n${extra.join("\n")}` : top.snapshot,
  };
}

export async function snapshot(tabId: number, verbose = false): Promise<string> {
  const r = await snapshotFrames(tabId, verbose);
  return r.snapshot;
}

export async function snapshotFull(
  tabId: number,
  verbose = false,
): Promise<{ url: string; title: string; snapshot: string }> {
  return snapshotFrames(tabId, verbose);
}

// ── eval (the caller's code runs as a chrome.userScripts injection) ──────────

/**
 * Packaged half of browser_eval (MAIN world, through `executeScript`): arms the
 * dialog policy and resolves element refs, parking the elements for the user
 * script. The CALLER's code never passes through here. It runs as a
 * `chrome.userScripts` injection (see `evaluate`), because the Web Store's MV3
 * policy permits code the extension did not ship ONLY through that API or the
 * debugger, and names `eval` of a supplied string as a violation.
 *
 * Refs cross the world boundary for free: `data-bmcp-ref` is a DOM ATTRIBUTE, so
 * an element tagged by the ISOLATED-world snapshot walk is findable from MAIN.
 */
function evalPrepPage(
  refs: string[],
  dialogAction: string | null,
): { ok: true } | { ok: false; error: string; code?: string } {
  // A dialog raised BY the evaluated code pauses the renderer, so nothing here
  // can answer it afterwards — the call would burn its whole timeout. Arming the
  // content script's existing policy for the duration is the only point at which
  // it can be answered, and `evalRestorePage` puts it back afterwards so this
  // cannot silently change how the page behaves for the next call.
  const w = window as any;
  w.__bmcpEvalPrior = w.__bmcpDialogPolicy ?? null;
  if (dialogAction) w.__bmcpDialogPolicy = { action: dialogAction };
  const REF_ATTR = "data-bmcp-ref";
  // KEEP IDENTICAL to the resolver in refOpPage / findFn — a smoke assertion
  // compares all three byte for byte. `executeScript` serialises by source, so
  // they physically cannot share it.
  const find = (ref: string, root: Document | ShadowRoot): HTMLElement | null => {
    const direct = root.querySelector(`[${REF_ATTR}="${ref}"]`) as HTMLElement | null;
    if (direct) return direct;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) {
        const found = find(ref, shadow);
        if (found) return found;
      }
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const found = find(ref, doc as unknown as Document);
            if (found) return found;
          }
        } catch {
          /* cross-origin frame */
        }
      }
    }
    return null;
  };

  const els: HTMLElement[] = [];
  for (const ref of refs) {
    const el = find(ref, document);
    if (!el) {
      if (dialogAction) w.__bmcpDialogPolicy = w.__bmcpEvalPrior;
      delete w.__bmcpEvalPrior;
      return { ok: false, code: "REF_NOT_FOUND", error: `Element ref "${ref}" not found.` };
    }
    els.push(el);
  }
  w.__bmcpEvalEls = els;
  return { ok: true };
}

/** Undo `evalPrepPage`, whatever the caller's code did in between. */
function evalRestorePage(dialogAction: string | null): void {
  const w = window as any;
  if (dialogAction) w.__bmcpDialogPolicy = w.__bmcpEvalPrior ?? null;
  delete w.__bmcpEvalPrior;
  delete w.__bmcpEvalEls;
}

const USER_SCRIPTS_TOGGLE =
  "open the extension's details page (chrome://extensions or edge://extensions, click \"Details\" " +
  'on AutomateBrowser) and turn on "Allow User Scripts" — before Chrome 138 the switch is ' +
  '"Developer mode" at the top of chrome://extensions instead. Only a person can do that.';

/**
 * Chrome leaves `chrome.userScripts` undefined until a person turns the toggle
 * on, and if it is revoked while the worker runs, every call throws instead.
 * Calling a method catches both — the check Chrome's own docs recommend.
 */
function userScriptsReady(): boolean {
  try {
    void chrome.userScripts.getScripts().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function evaluate(
  tabId: number,
  args: {
    expression?: string;
    function?: string;
    args?: string[];
    dialogAction?: "accept" | "dismiss";
  },
): Promise<unknown> {
  const fnSource = typeof args.function === "string" ? args.function.trim() : "";
  const expression = typeof args.expression === "string" ? args.expression.trim() : "";
  if (fnSource && expression) {
    throw new Error(
      "browser_eval takes either `expression` or `function`, not both. Use `function` when you " +
        "want to pass element refs in `args`; `expression` otherwise.",
    );
  }
  if (!fnSource && !expression) {
    throw new Error("browser_eval requires a non-empty `expression` or `function` string");
  }
  const refs = Array.isArray(args.args) ? args.args : [];
  if (refs.length && !fnSource) {
    throw new Error("browser_eval `args` only applies to the `function` form.");
  }

  // Element refs may name a frame (B5); the evaluated code then runs in it.
  const { frameId, bare } = frameOf(refs);
  if (!userScriptsReady()) {
    throw new Error(
      "USER_SCRIPTS_DISABLED: browser_eval runs your JavaScript through Chrome's user-scripts " +
        `feature, which is switched off for this extension. To fix it, ${USER_SCRIPTS_TOGGLE}`,
    );
  }
  const dialog = args.dialogAction ?? null;
  const prep = () => runFunc(tabId, evalPrepPage, [bare, dialog], "MAIN", frameId);

  let p = await prep();
  // Same recovery contract as an interaction (B2): a ref can go stale between the
  // snapshot and the call, so re-tag with the CANONICAL walk and try once more.
  // Only meaningful because refs are signature-derived — a re-tag hands the same
  // element the same ref.
  if (!p.ok && p.code === "REF_NOT_FOUND") {
    try {
      await runFunc(tabId, snapshotPage, [false], "ISOLATED", frameId);
      p = await prep();
    } catch {
      /* a page that cannot be snapshotted is not recoverable */
    }
    if (!p.ok && p.code === "REF_NOT_FOUND") {
      throw new Error(
        `STALE_REF: ${p.error} Re-resolving it failed — take a fresh browser_snapshot and use the new ref.`,
      );
    }
  }
  if (!p.ok) throw new Error(`eval failed: ${p.error}`);

  // The function form is inlined as SOURCE and called with the parked elements;
  // awaited, because an async page function must not come back as `{}`. The
  // expression form runs inside a block: a top-level let/const in a classic script
  // stays on the page for good, so the next call reusing the name would throw,
  // while a block scopes it and still completes with its last statement's value.
  // Chrome awaits a script that evaluates to a promise, as `await eval` did.
  const code = fnSource
    ? `(async () => {\n  const fn = (\n${fnSource}\n);\n` +
      '  if (typeof fn !== "function") throw new Error("`function` did not evaluate to a function.");\n' +
      "  return await fn(...(window.__bmcpEvalEls || []));\n})()"
    : `{\n${expression}\n}`;

  let out: chrome.userScripts.InjectionResult | undefined;
  try {
    [out] = await chrome.userScripts.execute({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      js: [{ code }],
    });
  } catch (e: any) {
    throw new Error(`eval failed: ${String(e?.message || e)}`);
  } finally {
    // A navigation the code started has already taken the page this would clean.
    await runFunc(tabId, evalRestorePage, [dialog], "MAIN", frameId).catch(() => {});
  }
  if (out?.error) throw new Error(`eval failed: ${out.error}`);
  return out?.result;
}

// ── interactions ─────────────────────────────────────────────────────────────

type Envelope = { ok: boolean; error?: string };
type WaitUntil = "none" | "auto" | "load" | "networkidle";
// Exported for `advanced.ts`: the TRUSTED input path has to return the same
// shape as this one, or the reply an agent gets changes because an unrelated
// mode is on. driver.ts imports nothing from advanced.ts, so this direction is
// the one that stays acyclic.
export type SettleOptions = { waitUntil?: WaitUntil; settleMs?: number };
export type ActionResult = {
  ok: true;
  navigated: boolean;
  urlBefore?: string;
  urlAfter?: string;
  settled: boolean;
  elapsedMs: number;
};

export async function currentUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

export async function settleAfterAction(
  tabId: number,
  urlBefore: string | undefined,
  opts: SettleOptions = {},
): Promise<ActionResult> {
  const startedAt = Date.now();
  const waitUntil = opts.waitUntil ?? "auto";
  // A5/B3: a 4x CPU throttle makes every FIXED wait wrong, so scale by whatever
  // this tab is currently throttled to (1 when nothing is emulated).
  const settleMs = Math.max(
    0,
    Math.min((opts.settleMs ?? 2_000) * waitMultiplier(tabId), 15_000),
  );
  if (waitUntil === "none" || settleMs === 0) {
    const urlAfter = await currentUrl(tabId);
    return {
      ok: true,
      navigated: !!urlBefore && !!urlAfter && urlBefore !== urlAfter,
      urlBefore,
      urlAfter,
      settled: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const deadline = Date.now() + settleMs;
  let lastUrl = urlBefore;
  let stableSince = Date.now();
  let urlAfter = urlBefore;
  let settled = false;
  const requiredStableMs = waitUntil === "networkidle" ? 500 : 250;
  while (Date.now() <= deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      urlAfter = tab.url;
      if (urlAfter !== lastUrl) {
        lastUrl = urlAfter;
        stableSince = Date.now();
      }
      const urlStable = Date.now() - stableSince >= requiredStableMs;
      if (tab.status === "complete" && urlStable) {
        settled = true;
        break;
      }
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    ok: true,
    navigated: !!urlBefore && !!urlAfter && urlBefore !== urlAfter,
    urlBefore,
    urlAfter,
    settled,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The ONE injected interaction op (B2 + B3).
 *
 * There used to be five of these — `clickRef`, `hoverRef`, `typeRef`,
 * `selectOptionRef`, `dragRef` — each carrying a byte-identical private copy of
 * the shadow-DOM/iframe ref resolver, because `executeScript` serialises a
 * function by source and cannot see module scope. Adding actionability checks to
 * five copies would have been five chances to diverge, so they collapse into this
 * one entry point: the resolver, the pre-action gate and the post-action settle
 * exist exactly once.
 *
 * Returns an envelope rather than throwing, so the caller can tell a REF miss
 * (recoverable — the server re-tags and retries once) from a refusal (the element
 * is there and is not actionable) from a genuine failure.
 */
async function refOpPage(
  op: string,
  refs: string[],
  o: {
    text?: string;
    submit?: boolean;
    values?: string[];
    /** Server-side kill switch (AUTOMATE_BROWSER_ACTIONABILITY=off). */
    actionability?: boolean;
    dblClick?: boolean;
    /** Throttle multiplier for every fixed wait in here (A5/B3). */
    slowdown?: number;
  },
): Promise<{
  ok: boolean;
  error?: string;
  /** REF_NOT_FOUND is the one the server can recover from. */
  code?: string;
  /** Which actionability check refused, when one did. */
  failed?: string;
  /** Whether the DOM went quiet before returning (false = it never stopped). */
  domSettled?: boolean;
  /** Click only: whether the page reacted at all (F5). Absent = not measured. */
  mutated?: boolean;
}> {
  const REF_ATTR = "data-bmcp-ref";
  const slow = Math.max(1, Math.min(o.slowdown ?? 1, 8));
  const GATE_MS = 1000 * slow; // how long a failing check is waited out (a fade-in, a layout settle)
  const QUIET_MS = 100; // mutation-free window that counts as "the DOM settled"
  const SETTLE_CAP_MS = 1000 * slow; // a page that never stops mutating must not hold the call

  const find = (ref: string, root: Document | ShadowRoot): HTMLElement | null => {
    const direct = root.querySelector(`[${REF_ATTR}="${ref}"]`) as HTMLElement | null;
    if (direct) return direct;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const shadow = (node as HTMLElement).shadowRoot;
      if (shadow) {
        const found = find(ref, shadow);
        if (found) return found;
      }
      if (node instanceof HTMLIFrameElement) {
        try {
          const doc = node.contentDocument;
          if (doc) {
            const found = find(ref, doc as unknown as Document);
            if (found) return found;
          }
        } catch {
          /* cross-origin frame */
        }
      }
    }
    return null;
  };

  const el = find(refs[0]!, document);
  if (!el) {
    return {
      ok: false,
      code: "REF_NOT_FOUND",
      error: `Element ref "${refs[0]}" not found.`,
    };
  }
  const other = op === "drag" ? find(refs[1]!, document) : null;
  if (op === "drag" && !other) {
    return { ok: false, code: "REF_NOT_FOUND", error: `Element ref "${refs[1]}" not found.` };
  }

  el.scrollIntoView({ block: "center", inline: "center" });

  // ── actionability gate (B3, pre) ───────────────────────────────────────────
  // Without this the engine dispatches at whatever querySelector returned:
  // invisible, disabled, mid-animation, or covered by a modal. The failure is not
  // an error — it is a click that lands on the overlay and a result saying
  // "Clicked".
  // rAF NEVER fires while the document is hidden — a MINIMISED window or a
  // backgrounded tab — so awaiting it bare hangs the entire injected op until the
  // socket times out, and the timeout then blames an open dialog. Found on a real
  // browser 2026-08-27: `browser_type` timed out at 8 s against an element that
  // was visible, enabled and hit-testable, with `document.hidden === true`.
  //
  // Racing a short timer degrades correctly: the stability check then compares two
  // rects ~1 frame apart WITHOUT a paint in between, which is exactly right for a
  // document that is not painting at all.
  const frame = () =>
    new Promise((r) => {
      const t = setTimeout(() => r(null), 50);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r(null);
      });
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Centre of the element's VISIBLE part; null when none of it is on screen. */
  const hitPoint = (r: DOMRect): { x: number; y: number } | null => {
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    if (right <= left || bottom <= top) return null;
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  };

  /** The check that refused (with what was in the way), or null when ready. */
  const gate = async (
    target: HTMLElement,
    hitTest: boolean,
  ): Promise<{ failed: string; blocker: Element | null } | null> => {
    const deadline = Date.now() + GATE_MS;
    for (;;) {
      let failed: string | null = null;
      let blocker: Element | null = null;

      const st = getComputedStyle(target);
      if (
        !target.getClientRects().length ||
        st.visibility === "hidden" ||
        st.display === "none" ||
        Number(st.opacity || "1") === 0
      ) {
        failed = "visible";
      } else if (
        (target as HTMLInputElement).disabled === true ||
        target.getAttribute("aria-disabled") === "true" ||
        (target as HTMLElement).inert === true ||
        !!target.closest("[inert], fieldset[disabled]")
      ) {
        failed = "enabled";
      } else {
        // Two boxes one frame apart: an element still animating into place would
        // otherwise be clicked where it WAS.
        const a = target.getBoundingClientRect();
        await frame();
        const b = target.getBoundingClientRect();
        if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) {
          failed = "stable";
        } else if (hitTest) {
          const p = hitPoint(b);
          if (!p) {
            failed = "visible";
          } else {
            // Query the element's OWN root: document.elementFromPoint does not
            // pierce a shadow boundary and would report the host instead.
            const root = target.getRootNode() as unknown as DocumentOrShadowRoot;
            const rootDoc: DocumentOrShadowRoot =
              typeof (root as any)?.elementFromPoint === "function" ? root : document;
            const hit = rootDoc.elementFromPoint(p.x, p.y);
            if (!hit) {
              failed = "hit-testable";
            } else if (hit !== target && !target.contains(hit) && !hit.contains(target)) {
              failed = "hit-testable";
              blocker = hit;
            }
          }
        }
      }

      if (!failed) return null;
      if (Date.now() >= deadline) return { failed, blocker };
      await sleep(50);
    }
  };

  if (o.actionability !== false) {
    // Hit-testing is for POINTER ops only. `type` and `select_option` route
    // through focus(), so something covering the element does not misdirect them —
    // refusing there would break flows that work today.
    const refusal = await gate(el, op === "click" || op === "drag");
    if (refusal) {
      const { failed, blocker } = refusal;
      const name =
        blocker &&
        (blocker.getAttribute("aria-label") ||
          (blocker as HTMLElement).innerText ||
          blocker.textContent ||
          "");
      const covering = blocker
        ? ` It is covered by <${blocker.tagName.toLowerCase()}${
            (blocker as HTMLElement).id ? "#" + (blocker as HTMLElement).id : ""
          }>${name ? ` "${String(name).replace(/\s+/g, " ").trim().slice(0, 60)}"` : ""}.`
        : "";
      return {
        ok: false,
        code: "NOT_ACTIONABLE",
        failed,
        error:
          `Element "${refs[0]}" is not actionable: failed the "${failed}" check after ${GATE_MS}ms.` +
          covering,
      };
    }
  }

  // ── did the page react? (F5) ───────────────────────────────────────────────
  // A synthetic click some pages ignore used to come back as "Clicked". Watched
  // from BEFORE the dispatch: a synchronous handler's changes land during it,
  // where an observer started afterwards (like the settle one below) never sees
  // them. Click only — it is the op whose reply carries the note.
  let changed = false;
  let watch: MutationObserver | null = null;
  const focusBefore = document.activeElement;
  const toggle = (el as any).control ?? el; // a <label> flips its input, not itself
  const checkedBefore = toggle.checked;
  if (op === "click") {
    try {
      watch = new MutationObserver(() => {
        changed = true;
      });
      // The element's own root too: a shadow tree or a frame is not in `document`.
      for (const root of new Set<Node>([document.documentElement, el.getRootNode()])) {
        watch.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    } catch {
      watch = null; // no observer → report nothing rather than guess
    }
  }

  // ── the action itself ──────────────────────────────────────────────────────
  const rect = el.getBoundingClientRect();
  const pointer: any = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };

  if (op === "click") {
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    } catch {
      /* PointerEvent may be unavailable */
    }
    el.dispatchEvent(new MouseEvent("mousedown", pointer));
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new PointerEvent("pointerup", pointer));
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new MouseEvent("mouseup", pointer));
    // Canonical activation (follows links, toggles checkboxes, submits buttons).
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", pointer));
    if (o.dblClick) {
      if (typeof el.click === "function") el.click();
      else el.dispatchEvent(new MouseEvent("click", { ...pointer, detail: 2 }));
      el.dispatchEvent(new MouseEvent("dblclick", { ...pointer, detail: 2 }));
    }
  } else if (op === "hover") {
    el.dispatchEvent(new MouseEvent("mouseover", pointer));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...pointer, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove", pointer));
  } else if (op === "type") {
    const text = o.text ?? "";
    const tag = el.tagName.toLowerCase();
    try {
      el.focus();
    } catch {
      /* ignore */
    }
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      try {
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }),
        );
      } catch {
        /* ignore */
      }
      if (setter) setter.call(input, text);
      else (input as any).value = text;
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text } as any),
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      try {
        el.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          }),
        );
      } catch {
        /* ignore */
      }
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) el.textContent = (el.textContent || "") + text;
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text } as any),
      );
    } else {
      return { ok: false, error: `Element <${tag}> is not editable.` };
    }

    if (o.submit) {
      const k: any = {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        view: window,
      };
      el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keypress", k));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
      const form = (el as HTMLInputElement).form;
      if (form) {
        try {
          if (typeof (form as any).requestSubmit === "function") form.requestSubmit();
          else form.submit();
        } catch {
          /* ignore */
        }
      }
    }
  } else if (op === "select") {
    if (el.tagName.toLowerCase() !== "select") {
      return { ok: false, error: "Target is not a <select> element." };
    }
    const select = el as unknown as HTMLSelectElement;
    const wanted = new Set(o.values ?? []);
    let matched = 0;
    for (const opt of Array.from(select.options)) {
      const on = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.text);
      opt.selected = select.multiple ? on || opt.selected : on;
      if (on) matched++;
    }
    if (!matched) {
      return { ok: false, error: `No option matched ${JSON.stringify(o.values ?? [])}.` };
    }
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (op === "drag") {
    const to = other as HTMLElement;
    const r2 = to.getBoundingClientRect();
    const p1: any = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const p2: any = { clientX: r2.left + r2.width / 2, clientY: r2.top + r2.height / 2 };
    const dt = new DataTransfer();
    const fire = (target: Element, type: string, p: any) =>
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dt,
          ...p,
        }),
      );
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...p1 }));
    fire(el, "dragstart", p1);
    fire(to, "dragenter", p2);
    fire(to, "dragover", p2);
    fire(to, "drop", p2);
    fire(el, "dragend", p2);
    to.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, ...p2 }));
  } else {
    return { ok: false, error: `Unknown interaction "${op}".` };
  }

  // ── post-action DOM settle (B3, post) ──────────────────────────────────────
  // The half that causes stale snapshots: return the instant the click is
  // dispatched and the agent's next snapshot is of a page mid-re-render.
  // `settleAfterAction` in the worker still handles the NAVIGATION half; this is
  // in-page and costs no extra round trip.
  if (o.actionability === false) {
    watch?.disconnect(); // no settle wait, so a later reaction would be missed: say nothing
    return { ok: true };
  }
  const domSettled = await new Promise<boolean>((resolve) => {
    let quiet: any;
    let hard: any;
    let obs: MutationObserver | null = null;
    const done = (v: boolean) => {
      try {
        obs?.disconnect();
      } catch {
        /* ignore */
      }
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve(v);
    };
    try {
      obs = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(() => done(true), QUIET_MS);
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      return done(true); // no observer → nothing to wait for
    }
    quiet = setTimeout(() => done(true), QUIET_MS);
    hard = setTimeout(() => done(false), SETTLE_CAP_MS);
  });
  if (!watch) return { ok: true, domSettled };
  // Not DOM changes, and each one a click that worked: a checkbox flipping, and
  // focus moving somewhere other than the button we focused ourselves.
  const focus = document.activeElement;
  const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
  const mutated =
    changed ||
    watch.takeRecords().length > 0 ||
    toggle.checked !== checkedBefore ||
    (focus !== focusBefore && (focus !== el || field));
  watch.disconnect();
  return { ok: true, domSettled, mutated };
}

function pressKeyPage(combo: string): Envelope {
  const target = (document.activeElement as HTMLElement) || document.body;

  // Parse modifier combos like "Control+A", "Shift+Tab", "Control+Shift+R".
  // Trailing "+" means the literal plus key (e.g. "Control++").
  let key = combo;
  const mods: string[] = [];
  if (combo.length > 1 && combo.includes("+")) {
    if (combo.endsWith("++")) {
      key = "+";
      combo.slice(0, -2).split("+").forEach((m) => m && mods.push(m));
    } else {
      const parts = combo.split("+").map((s) => s.trim()).filter(Boolean);
      key = parts.pop() ?? combo;
      mods.push(...parts);
    }
  }
  const low = mods.map((m) => m.toLowerCase());
  const ctrlKey = low.includes("control") || low.includes("ctrl");
  const shiftKey = low.includes("shift");
  const altKey = low.includes("alt") || low.includes("option");
  const metaKey =
    low.includes("meta") || low.includes("cmd") || low.includes("command") || low.includes("super");

  const named: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    " ": 32,
  };
  const keyCode = named[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const code =
    key.length === 1 ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key;
  const o: any = {
    bubbles: true,
    cancelable: true,
    key,
    code,
    keyCode,
    which: keyCode,
    view: window,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", o));
  // keypress only fires for character-producing keys without Ctrl/Meta held.
  if (key.length === 1 && !ctrlKey && !metaKey)
    target.dispatchEvent(new KeyboardEvent("keypress", o));
  target.dispatchEvent(new KeyboardEvent("keyup", o));
  return { ok: true };
}

type RefOpArgs = {
  actionability?: boolean;
  text?: string;
  submit?: boolean;
  values?: string[];
  /** A2: one param, so it works on the ref path as well as the point path. */
  dblClick?: boolean;
};

/** Envelope of one interaction, before the worker-side navigation settle. */
type OpEnvelope = {
  ok: boolean;
  error?: string;
  code?: string;
  failed?: string;
  domSettled?: boolean;
  mutated?: boolean;
};

/**
 * Inject the ref op, but stop waiting once the tab starts loading a new document
 * (F4). Chrome never settles `executeScript` for a document that unloads while
 * the injected promise is pending — measured 2026-10-02: still pending after
 * 10 s — and the op's in-page DOM settle is exactly such a promise. So a click
 * that followed a link held the call to the socket deadline, and the server then
 * blamed a dialog. The load means the action landed; `settleAfterAction` reports
 * the navigation.
 */
async function injectRefOp(
  tabId: number,
  args: Parameters<typeof refOpPage>,
  frameId: number,
): Promise<OpEnvelope> {
  let onUpdated!: (id: number, info: chrome.tabs.OnUpdatedInfo) => void;
  const unloaded = new Promise<OpEnvelope>((resolve) => {
    onUpdated = (id, info) => {
      if (id === tabId && info.status === "loading") resolve({ ok: true });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  try {
    return await Promise.race([runFunc(tabId, refOpPage, args, "ISOLATED", frameId), unloaded]);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

/**
 * Run one interaction, recovering ONCE from a ref that has gone stale (B2).
 *
 * Recovery re-tags the page by taking a snapshot — the canonical tagging walk —
 * rather than duplicating the ref derivation a third time inside the injected op.
 * That only works because refs are now derived from an element's own signature
 * (B12): re-tagging hands the same element the same ref, so the retry is aimed at
 * the element the agent meant. Under the old walk-order numbering it would have
 * hit whatever was in that position, which is worse than failing.
 */
async function runRefOp(
  tabId: number,
  op: string,
  refs: string[],
  args: RefOpArgs,
): Promise<OpEnvelope & { recovered?: boolean }> {
  const opts = {
    text: args.text,
    submit: args.submit,
    values: args.values,
    actionability: args.actionability,
    dblClick: args.dblClick,
    slowdown: waitMultiplier(tabId),
  };
  // A `fN:` prefix routes the whole op into that frame (B5). The injected op is
  // unchanged and sees plain refs — frame identity never leaves the worker.
  const { frameId, bare } = frameOf(refs);
  let r = await injectRefOp(tabId, [op, bare, opts], frameId);
  if (r.ok || r.code !== "REF_NOT_FOUND") return r;

  // Re-tag and try once more. A second attempt could not find anything the first
  // did not, and would only double the cost of a genuine miss.
  try {
    // Re-tag the SAME frame — re-tagging the top document would not restore a ref
    // that lives inside an iframe.
    await runFunc(tabId, snapshotPage, [false], "ISOLATED", frameId);
  } catch {
    // A page that cannot even be snapshotted is not recoverable; fall through and
    // report the original miss.
    return r;
  }
  r = await injectRefOp(tabId, [op, bare, opts], frameId);
  if (r.ok) return { ...r, recovered: true };
  if (r.code === "REF_NOT_FOUND") {
    throw new Error(
      `STALE_REF: element ref "${refs[0]}" no longer exists on this page, and re-resolving it ` +
        `failed. Take a fresh browser_snapshot and use the new ref.`,
    );
  }
  return r;
}

/**
 * Coordinate click (roadmap A2), injected. A canvas, a map, a PDF viewer and an
 * `<area>` map have no addressable element, so no ref can reach them.
 *
 * Deliberately NOT `el.click()`: the canonical activation path carries no
 * coordinates, and a canvas handler reads `clientX`/`clientY`. Clicking the
 * element without them is the failure this whole item exists to fix.
 *
 * The hit-test half of the actionability gate is skipped on purpose — the target
 * IS whatever `elementFromPoint` returned, so "is something covering it?" has
 * already been answered by construction. The visible/enabled checks still run.
 */
async function pointClickPage(
  x: number,
  y: number,
  dbl: boolean,
  actionability: boolean,
): Promise<{ ok: boolean; error?: string; code?: string; failed?: string; hit?: string }> {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!(x >= 0 && y >= 0 && x < w && y < h)) {
    return {
      ok: false,
      code: "NOT_ACTIONABLE",
      failed: "in-viewport",
      error: `Point (${x}, ${y}) is outside the viewport (${w}x${h}). Scroll it into view first.`,
    };
  }
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) {
    return {
      ok: false,
      code: "NOT_ACTIONABLE",
      failed: "hit-testable",
      error: `Nothing is at (${x}, ${y}).`,
    };
  }
  if (actionability) {
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) {
      return {
        ok: false,
        code: "NOT_ACTIONABLE",
        failed: "visible",
        error: `The element at (${x}, ${y}) is not visible.`,
      };
    }
    if (
      (el as HTMLInputElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      el.inert === true
    ) {
      return {
        ok: false,
        code: "NOT_ACTIONABLE",
        failed: "enabled",
        error: `The element at (${x}, ${y}) is disabled.`,
      };
    }
  }

  // A coordinate click that lands on the wrong thing is otherwise silent, so
  // report what was actually under the point.
  const name = (
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    el.innerText ||
    el.textContent ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const hit = `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}>${name ? ` "${name}"` : ""}`;

  const pointer: any = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
  };
  const press = (detail: number): void => {
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    } catch {
      /* PointerEvent may be unavailable */
    }
    el.dispatchEvent(new MouseEvent("mousedown", pointer));
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new PointerEvent("pointerup", pointer));
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new MouseEvent("mouseup", pointer));
    el.dispatchEvent(new MouseEvent("click", { ...pointer, detail }));
  };
  press(1);
  if (dbl) {
    press(2);
    el.dispatchEvent(new MouseEvent("dblclick", { ...pointer, detail: 2 }));
  }
  return { ok: true, hit };
}

/**
 * Throw the envelope's error, prefixed with its code (B6) so the server can
 * classify it without matching on prose. The message itself is unchanged.
 */
function unwrapOp(r: OpEnvelope): OpEnvelope {
  if (!r || !r.ok) {
    const message = r?.error || "Action failed";
    throw new Error(r?.code ? `${r.code}: ${message}` : message);
  }
  return r;
}

export async function click(
  tabId: number,
  args: { ref?: string; x?: number; y?: number; dblClick?: boolean } & SettleOptions & RefOpArgs,
): Promise<
  ActionResult & { recovered?: boolean; domSettled?: boolean; mutated?: boolean; hit?: string }
> {
  const startedAt = Date.now();
  const urlBefore = await currentUrl(tabId);
  // A2: a point needs no ref to resolve, so there is nothing that can go stale
  // and nothing to recover — the coordinate IS the address.
  if (typeof args.x === "number" && typeof args.y === "number") {
    const p = unwrapOp(
      (await runFunc(
        tabId,
        pointClickPage,
        [args.x, args.y, !!args.dblClick, args.actionability !== false],
        "ISOLATED",
      )) as OpEnvelope,
    ) as OpEnvelope & { hit?: string };
    return { ...(await settleAfterAction(tabId, urlBefore, args)), hit: p.hit };
  }
  const r = await runRefOp(tabId, "click", [args.ref!], args);
  unwrapOp(r);
  const settled = await settleAfterAction(tabId, urlBefore, args);
  // F5: a click that only sent a request (or opened a tab) changed nothing in the
  // DOM yet and still worked. Asked after the settle, which gave it time to go out.
  const mutated = r.mutated === false ? await requestSince(tabId, startedAt) : r.mutated;
  return { ...settled, recovered: r.recovered, domSettled: r.domSettled, mutated };
}

export async function hover(
  tabId: number,
  args: { ref: string } & RefOpArgs,
): Promise<{ ok: true; recovered?: boolean }> {
  const r = await runRefOp(tabId, "hover", [args.ref], args);
  unwrapOp(r);
  return { ok: true, recovered: r.recovered };
}

export async function type(
  tabId: number,
  args: { ref: string; text: string; submit?: boolean } & SettleOptions & RefOpArgs,
): Promise<ActionResult & { recovered?: boolean; domSettled?: boolean }> {
  const urlBefore = await currentUrl(tabId);
  const r = await runRefOp(tabId, "type", [args.ref], {
    ...args,
    text: args.text ?? "",
    submit: !!args.submit,
  });
  unwrapOp(r);
  return { ...(await settleAfterAction(tabId, urlBefore, args)), recovered: r.recovered, domSettled: r.domSettled };
}

export async function selectOption(
  tabId: number,
  args: { ref: string; values: string[] } & RefOpArgs,
): Promise<{ ok: true; recovered?: boolean }> {
  const r = await runRefOp(tabId, "select", [args.ref], {
    ...args,
    values: args.values ?? [],
  });
  unwrapOp(r);
  return { ok: true, recovered: r.recovered };
}

export async function drag(
  tabId: number,
  args: { startRef: string; endRef: string } & RefOpArgs,
): Promise<{ ok: true; recovered?: boolean }> {
  const r = await runRefOp(tabId, "drag", [args.startRef, args.endRef], args);
  unwrapOp(r);
  return { ok: true, recovered: r.recovered };
}

export async function pressKey(
  tabId: number,
  args: { key: string } & SettleOptions,
): Promise<ActionResult> {
  const urlBefore = await currentUrl(tabId);
  unwrap(await runFunc(tabId, pressKeyPage, [args.key]));
  return settleAfterAction(tabId, urlBefore, args);
}

// ── console logs (MAIN world; populated by the content script) ───────────────

export async function getConsoleLogs(
  tabId: number,
  args: { includePreserved?: boolean } = {},
): Promise<unknown[]> {
  const current = await currentConsoleLogs(tabId);
  if (!args.includePreserved) return current;

  // Preserved pages are prepended as ordinary entries behind a synthetic header,
  // rather than returned in a second field. One wire shape and one renderer: the
  // reader already knows how to print an entry, and the chronological order an
  // agent reads top-to-bottom stays true across the navigation boundary.
  const pages = await getPreserved(tabId);
  if (pages.length === 0) {
    return [
      {
        level: "info",
        ts: Date.now(),
        text: "[automate-browser] No preserved log for a previous page in this tab. (Handover happens on pagehide, so a crashed renderer, a closed tab, or a chrome:// navigation leaves none.)",
      },
      ...current,
    ];
  }
  const out: unknown[] = [];
  for (const p of pages) {
    out.push({
      level: "info",
      ts: p.ts,
      text: `[automate-browser] ─── preserved console from ${p.url}${p.title ? ` (${p.title})` : ""} ───`,
    });
    if (p.dropped > 0) {
      out.push({
        level: "info",
        ts: p.ts,
        text: `[automate-browser] ${p.dropped} earlier entries were dropped from that page's buffer.`,
      });
    }
    out.push(...p.entries);
  }
  out.push({
    level: "info",
    ts: Date.now(),
    text: "[automate-browser] ─── current page ───",
  });
  return [...out, ...current];
}

async function currentConsoleLogs(tabId: number): Promise<unknown[]> {
  return runFunc(
    tabId,
    () => {
      const w = window as any;
      const logs = ((w.__bmcpLogs ?? []) as unknown[]).slice();
      const dropped: number = w.__bmcpLogsMeta?.dropped ?? 0;
      if (dropped > 0) {
        logs.unshift({
          level: "info",
          ts: Date.now(),
          text: `[automate-browser] ${dropped} earlier console ${
            dropped === 1 ? "entry was" : "entries were"
          } dropped (ring buffer cap 500).`,
        });
      }
      return logs;
    },
    [],
    "MAIN",
  );
}
