/**
 * A tiny hand-built DOM for running injected page functions in Node - see
 * `form-radio-values.test.ts` for why not jsdom. It has only what the page
 * functions under test touch; add to it when a test needs more.
 */

export interface El {
  tagName: string;
  parentElement: El | null;
  children: El[];
  childNodes: Array<{ nodeType: number; textContent: string }>;
  attrs: Record<string, string>;
  innerText: string;
  textContent: string;
  getAttribute(n: string): string | null;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
  hasAttribute(n: string): boolean;
  getClientRects(): unknown[];
  /** Only `tag` and `tag[attr]`. */
  querySelector(sel: string): El | null;
}

/** Every element under `root`, `root` first, in document order. */
export function all(root: El): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    out.push(e);
    e.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** True when `el` matches a `tag` or `tag[attr]` selector. */
function matches(el: El, sel: string): boolean {
  const m = /^([a-z0-9-]+)(?:\[([a-z-]+)\])?$/.exec(sel);
  if (!m) throw new Error(`fake DOM: unsupported selector "${sel}"`);
  return el.tagName === m[1]!.toUpperCase() && (!m[2] || m[2] in el.attrs);
}

/** `h("a", {href: "/login"}, "Sign in")` - children are elements or one text string. */
export function h(tag: string, attrs: Record<string, string>, ...kids: Array<El | string>): El {
  const el: El = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    childNodes: [],
    attrs: { ...attrs },
    get innerText(): string {
      return kids.map((k) => (typeof k === "string" ? k : k.innerText)).join(" ");
    },
    get textContent(): string {
      return kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
    },
    getAttribute: (n) => el.attrs[n] ?? null,
    setAttribute: (n, v) => {
      el.attrs[n] = v;
    },
    removeAttribute: (n) => {
      delete el.attrs[n];
    },
    hasAttribute: (n) => n in el.attrs,
    // As in a browser: nothing inside <head> is rendered.
    getClientRects: () => {
      for (let p: El | null = el; p; p = p.parentElement) if (p.tagName === "HEAD") return [];
      return [{}];
    },
    querySelector: (sel) =>
      all(el)
        .slice(1)
        .find((d) => matches(d, sel)) ?? null,
  };
  for (const k of kids) {
    if (typeof k === "string") el.childNodes.push({ nodeType: 3, textContent: k });
    else {
      k.parentElement = el;
      el.children.push(k);
      el.childNodes.push({ nodeType: 1, textContent: k.innerText });
    }
  }
  return el;
}
