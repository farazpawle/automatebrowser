/**
 * Browser-state ops — DEBUGGER-FREE.
 *
 *   - cookies: read/write via the `chrome.cookies` API (background side), scoped
 *     to the driven tab's URL.
 *   - web storage: read/write localStorage & sessionStorage via an injected
 *     ISOLATED-world script (content scripts share the page's origin storage).
 *
 * These are powerful (sessions/auth surface) — the server tools describe the risk.
 */
import { runFunc } from "./run-func";

interface CookieView {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
}

function toView(c: chrome.cookies.Cookie): CookieView {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: String(c.sameSite),
    session: c.session,
    expirationDate: c.expirationDate,
  };
}

async function tabUrl(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  if (!/^https?:/.test(url)) {
    throw new Error(
      `Active tab is not an http(s) page (${url || "no url"}); cookies are unavailable here.`,
    );
  }
  return url;
}

/**
 * The cookie store the DRIVEN TAB belongs to.
 *
 * A private-browsing window has its OWN store, and `chrome.cookies` with no
 * `storeId` uses the extension's own context — the normal one. Measured in Chrome
 * and Edge on 2026-09-05: driving an incognito tab, a `set` with no `storeId`
 * landed in store "0" (normal) while the tab's own store "1" stayed empty, and a
 * `getAll` read back the ordinary profile's cookies. The agent would have been
 * shown the user's real session while believing it was looking at a clean one —
 * the exact confusion a logged-out session exists to avoid.
 *
 * For an ordinary tab this resolves to the same store as before, so nothing
 * changes for the 99% case. Returns undefined when the tab is in no listed store,
 * which falls back to the old behaviour rather than failing the call.
 */
async function storeIdFor(tabId: number): Promise<string | undefined> {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((s) => s.tabIds?.includes(tabId))?.id;
  } catch {
    return undefined;
  }
}

export async function getCookies(
  tabId: number,
  args: { name?: string },
): Promise<CookieView[]> {
  if (!chrome.cookies) throw new Error("cookies permission not granted in the extension.");
  const url = await tabUrl(tabId);
  const all = await chrome.cookies.getAll({ url, storeId: await storeIdFor(tabId) });
  const list = args.name ? all.filter((c) => c.name === args.name) : all;
  return list.map(toView);
}

export async function setCookie(
  tabId: number,
  args: {
    name: string;
    value: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
    sameSite?: "no_restriction" | "lax" | "strict";
  },
): Promise<CookieView> {
  if (!chrome.cookies) throw new Error("cookies permission not granted in the extension.");
  if (!args.name) throw new Error("browser_set_cookie requires a `name`.");
  const url = await tabUrl(tabId);
  const sameSiteMap: Record<string, chrome.cookies.SameSiteStatus> = {
    no_restriction: "no_restriction" as chrome.cookies.SameSiteStatus,
    lax: "lax" as chrome.cookies.SameSiteStatus,
    strict: "strict" as chrome.cookies.SameSiteStatus,
  };
  const set = await chrome.cookies.set({
    url,
    storeId: await storeIdFor(tabId),
    name: args.name,
    value: args.value ?? "",
    path: args.path,
    secure: args.secure,
    httpOnly: args.httpOnly,
    expirationDate: args.expirationDate,
    sameSite: args.sameSite ? sameSiteMap[args.sameSite] : undefined,
  });
  if (!set) throw new Error(`Failed to set cookie "${args.name}".`);
  return toView(set);
}

// ── web storage (injected) ────────────────────────────────────────────────────

function storageFn(
  area: "local" | "session",
  action: "get" | "set" | "remove" | "clear",
  key: string | null,
  value: string | null,
): { ok: boolean; value?: unknown; error?: string } {
  try {
    const s = area === "session" ? sessionStorage : localStorage;
    if (action === "get") {
      if (key) return { ok: true, value: s.getItem(key) };
      const all: Record<string, string | null> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k != null) all[k] = s.getItem(k);
      }
      return { ok: true, value: all };
    }
    if (action === "set") {
      if (!key) return { ok: false, error: "`key` is required for set" };
      s.setItem(key, value ?? "");
      return { ok: true };
    }
    if (action === "remove") {
      if (!key) return { ok: false, error: "`key` is required for remove" };
      s.removeItem(key);
      return { ok: true };
    }
    if (action === "clear") {
      s.clear();
      return { ok: true };
    }
    return { ok: false, error: `unknown action "${action}"` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function storage(
  tabId: number,
  args: {
    area?: "local" | "session";
    action: "get" | "set" | "remove" | "clear";
    key?: string;
    value?: string;
  },
): Promise<unknown> {
  const r = await runFunc(tabId, storageFn, [
    args.area === "session" ? "session" : "local",
    args.action,
    args.key ?? null,
    args.value ?? null,
  ]);
  if (!r.ok) throw new Error(r.error || "storage op failed");
  return r.value ?? { ok: true };
}
