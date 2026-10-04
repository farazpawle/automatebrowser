/**
 * Content-reading & query ops — DEBUGGER-FREE (chrome.scripting, ISOLATED world).
 *
 * These give the agent cheap, token-efficient alternatives to a full
 * `browser_snapshot`:
 *   - `readPage`  — clean main text / Markdown of the page (read-only tasks).
 *   - `getHtml`   — raw outerHTML of the page or a `ref`'d element.
 *   - `find`      — locate elements by text/role/selector and return fresh refs
 *                   WITHOUT serialising the whole accessibility tree.
 *   - `scroll`    — scroll the window or a `ref`'d element.
 *
 * Injected functions are serialised by source, so each is fully self-contained.
 */
import { runFunc } from "./run-func";

// ── read_page ─────────────────────────────────────────────────────────────────

function readPageFn(format: "text" | "markdown"): {
  url: string;
  title: string;
  content: string;
} {
  const root =
    (document.querySelector("main, article, [role=main]") as HTMLElement) ||
    document.body;

  if (format !== "markdown") {
    const text = ((root as HTMLElement).innerText || root.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { url: location.href, title: document.title, content: text };
  }

  // Lightweight DOM → Markdown for common block/inline elements.
  const skip = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "NAV",
    "HEADER",
    "FOOTER",
    "ASIDE",
    "IFRAME",
  ]);
  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (!he.getClientRects || !he.getClientRects().length) return false;
    const st = getComputedStyle(he);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const inline = (el: Element): string => {
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += (n.textContent || "").replace(/\s+/g, " ");
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const c = n as HTMLElement;
        if (skip.has(c.tagName)) return;
        const tag = c.tagName.toLowerCase();
        const inner = inline(c);
        if (tag === "a") {
          const href = c.getAttribute("href") || "";
          out += href ? `[${inner.trim()}](${href})` : inner;
        } else if (tag === "strong" || tag === "b") out += `**${inner.trim()}**`;
        else if (tag === "em" || tag === "i") out += `*${inner.trim()}*`;
        else if (tag === "code") out += `\`${inner.trim()}\``;
        else if (tag === "br") out += "\n";
        else out += inner;
      }
    });
    return out;
  };
  const blocks: string[] = [];
  const walk = (el: Element): void => {
    if (skip.has(el.tagName) || !isVisible(el)) return;
    const tag = el.tagName.toLowerCase();
    const h = tag.match(/^h([1-6])$/);
    if (h) {
      const t = inline(el).trim();
      if (t) blocks.push(`${"#".repeat(Number(h[1]))} ${t}`);
      return;
    }
    if (tag === "p" || tag === "blockquote") {
      const t = inline(el).trim();
      if (t) blocks.push(tag === "blockquote" ? `> ${t}` : t);
      return;
    }
    if (tag === "li") {
      const t = inline(el).trim();
      if (t) blocks.push(`- ${t}`);
      return;
    }
    if (tag === "pre") {
      const t = (el.textContent || "").replace(/\n+$/, "");
      if (t.trim()) blocks.push("```\n" + t + "\n```");
      return;
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);
  const content = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return { url: location.href, title: document.title, content };
}

export async function readPage(
  tabId: number,
  args: { format?: "text" | "markdown"; maxLength?: number },
): Promise<{ url: string; title: string; content: string; truncated: boolean }> {
  const r = await runFunc(tabId, readPageFn, [args.format === "markdown" ? "markdown" : "text"]);
  const max = args.maxLength && args.maxLength > 0 ? args.maxLength : 0;
  let truncated = false;
  let content = r.content;
  if (max && content.length > max) {
    content = content.slice(0, max);
    truncated = true;
  }
  return { ...r, content, truncated };
}

// ── get_html ──────────────────────────────────────────────────────────────────

function getHtmlFn(
  ref: string | null,
): { ok: boolean; html?: string; error?: string } {
  const el = ref
    ? (document.querySelector(`[data-bmcp-ref="${ref}"]`) as HTMLElement | null)
    : (document.documentElement as HTMLElement);
  if (!el)
    return {
      ok: false,
      error: `Element ref "${ref}" not found — take a fresh browser_snapshot or browser_find.`,
    };
  return { ok: true, html: el.outerHTML || "" };
}

export async function getHtml(
  tabId: number,
  args: { ref?: string; maxLength?: number },
): Promise<{ html: string; truncated: boolean }> {
  const r = await runFunc(tabId, getHtmlFn, [args.ref ?? null]);
  if (!r.ok) throw new Error(r.error || "get_html failed");
  let html = r.html || "";
  const max = args.maxLength && args.maxLength > 0 ? args.maxLength : 50000;
  let truncated = false;
  if (html.length > max) {
    html = html.slice(0, max);
    truncated = true;
  }
  return { html, truncated };
}

// ── find ──────────────────────────────────────────────────────────────────────

type FindMatch = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  /** Only the data-carrying attributes that are present (F11). */
  attrs?: Record<string, string>;
  /** Not drawn - only an explicit selector returns these. */
  hidden?: true;
};

function findFn(
  text: string | null,
  role: string | null,
  selector: string | null,
  max: number,
): { matches: FindMatch[] } {
  const REF_ATTR = "data-bmcp-ref";

  // ── stable refs (B12) ──────────────────────────────────────────────────────
  // This used to CLEAR every ref on the page and renumber from e1, so calling
  // browser_find silently invalidated every ref from the last browser_snapshot —
  // the agent's whole map of the page, thrown away by a read-only query. Now
  // refs are left alone: an element that already carries one keeps it (it is the
  // same element), and only newly matched elements are tagged.
  //
  // The derivation is a verbatim copy of driver.ts's. `executeScript` serialises
  // a function by source and cannot see module scope, so the two injected walks
  // physically cannot share it — keep them identical when either changes.
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
  // Seed the per-signature counter from refs ALREADY on the page, or a newly
  // matched twin of an already-tagged element would be handed an identical ref
  // and querySelector would then only ever reach the first of the two.
  const seen = new Map<string, number>();
  document.querySelectorAll("[" + REF_ATTR + "]").forEach((e) => {
    const m = /^e([a-z0-9]{4})(?:\.(\d+))?$/.exec(e.getAttribute(REF_ATTR) || "");
    if (m) {
      const n = m[2] ? Number(m[2]) : 0;
      seen.set(m[1]!, Math.max(seen.get(m[1]!) ?? 0, n + 1));
    }
  });
  const refFor = (el: Element): string => {
    const existing = el.getAttribute(REF_ATTR);
    if (existing) return existing;
    const h = hashOf(sigOf(el));
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    const ref = "e" + h + (n ? "." + n : "");
    el.setAttribute(REF_ATTR, ref);
    return ref;
  };

  const clip = (s: string): string => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > 120 ? t.slice(0, 117) + "…" : t;
  };
  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (!he.getClientRects || !he.getClientRects().length) return false;
    const st = getComputedStyle(he);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  // The data a page keeps in attributes, not text: a <relative-time>'s date,
  // a <meta>'s value, a link's target (F11).
  const attrsOf = (el: Element): { attrs?: Record<string, string> } => {
    const attrs: Record<string, string> = {};
    for (const n of ["id", "href", "title", "datetime", "content"]) {
      const v = el.getAttribute(n);
      if (v) attrs[n] = clip(v);
    }
    return Object.keys(attrs).length ? { attrs } : {};
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
      img: "img",
    };
    return map[tag] || "";
  };
  const nameOf = (el: Element): string => {
    const he = el as HTMLElement;
    const label = he.getAttribute("aria-label");
    if (label) return clip(label);
    if (el.tagName.toLowerCase() === "input") {
      const inp = el as HTMLInputElement;
      if (inp.placeholder) return clip(inp.placeholder);
      if (inp.value && (inp.type === "button" || inp.type === "submit"))
        return clip(inp.value);
    }
    return clip((he.innerText || he.textContent || "") as string);
  };

  const CONTROLS = ["link", "button", "checkbox", "radio", "combobox", "textbox", "menuitem", "tab", "option", "switch"];
  // An icon-only control is named by its image (F12). Its id and title already
  // print as attributes, so they are not repeated as a name here.
  const altOf = (el: Element): string => clip(el.querySelector("img[alt]")?.getAttribute("alt") || "");

  const candidates: Element[] = selector
    ? Array.from(document.querySelectorAll(selector))
    : Array.from(document.querySelectorAll("*"));
  const needle = text ? text.toLowerCase() : null;
  const hits: Array<{ el: Element; role: string; name: string; hidden: boolean }> = [];
  for (const el of candidates) {
    // A text search scans everything: the cut comes after the innermost filter.
    if (!needle && hits.length >= max) break;
    // An explicit selector names what it wants - a <meta> in <head>, a hidden
    // input - and those are never drawn (F11). Text and role searches stay
    // with what a person can see.
    const visible = isVisible(el);
    if (!visible && !selector) continue;
    const r = roleOf(el) || el.tagName.toLowerCase();
    if (role && r.toLowerCase() !== role.toLowerCase()) continue;
    const name = nameOf(el) || (CONTROLS.includes(r) ? altOf(el) : "");
    if (needle) {
      const hay = (name + " " + (el.getAttribute("value") || "")).toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    hits.push({ el, role: r, name, hidden: !visible });
  }

  // Text is matched against the whole subtree, so every ancestor of the real
  // target matches too (html, body, wrappers - F10). Keep the innermost, except
  // that a control absorbs the label text inside it: <button><span>Go</span>
  // </button> is the button, not the span.
  let kept = hits;
  if (needle) {
    const hitSet = new Set(hits.map((x) => x.el));
    const inControl = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (hitSet.has(p) && CONTROLS.includes(roleOf(p))) return true;
      }
      return false;
    };
    kept = hits.filter((x) => !inControl(x.el));
    const outer = new Set<Element>();
    for (const x of kept) {
      for (let p = x.el.parentElement; p && !outer.has(p); p = p.parentElement) outer.add(p);
    }
    kept = kept.filter((x) => !outer.has(x.el));
  }
  // Refs only for what is returned - a dropped wrapper is left untagged.
  const matches = kept.slice(0, max).map((x) => ({
    ref: refFor(x.el),
    role: x.role,
    name: x.name,
    tag: x.el.tagName.toLowerCase(),
    ...attrsOf(x.el),
    ...(x.hidden ? { hidden: true as const } : {}),
  }));
  return { matches };
}

export async function find(
  tabId: number,
  args: { text?: string; role?: string; selector?: string; max?: number },
): Promise<FindMatch[]> {
  if (!args.text && !args.role && !args.selector) {
    throw new Error("browser_find needs at least one of: text, role, selector.");
  }
  const r = await runFunc(tabId, findFn, [
    args.text ?? null,
    args.role ?? null,
    args.selector ?? null,
    args.max && args.max > 0 ? args.max : 20,
  ]);
  return r.matches;
}

// ── scroll ──────────────────────────────────────────────────────────────────

function scrollFn(
  ref: string | null,
  to: string | null,
  dx: number,
  dy: number,
  oneViewport: boolean,
): { ok: boolean; error?: string } {
  if (ref) {
    const el = document.querySelector(`[data-bmcp-ref="${ref}"]`) as HTMLElement | null;
    if (!el)
      return {
        ok: false,
        error: `Element ref "${ref}" not found — take a fresh browser_snapshot.`,
      };
    el.scrollIntoView({ block: "center", inline: "center" });
    return { ok: true };
  }
  if (to === "top") {
    window.scrollTo(0, 0);
    return { ok: true };
  }
  if (to === "bottom") {
    window.scrollTo(0, document.body.scrollHeight);
    return { ok: true };
  }
  // No ref / no `to` / no explicit delta → scroll ~one viewport down.
  const stepY = oneViewport ? Math.round(window.innerHeight * 0.9) : dy || 0;
  window.scrollBy(dx || 0, stepY);
  return { ok: true };
}

export async function scroll(
  tabId: number,
  args: { ref?: string; to?: "top" | "bottom"; dx?: number; dy?: number },
): Promise<{ ok: true }> {
  const oneViewport =
    !args.ref && !args.to && args.dx == null && args.dy == null;
  const r = await runFunc(tabId, scrollFn, [
    args.ref ?? null,
    args.to ?? null,
    args.dx ?? 0,
    args.dy ?? 0,
    oneViewport,
  ]);
  if (!r.ok) throw new Error(r.error || "scroll failed");
  return { ok: true };
}
