/**
 * Tab-management handlers — the browser side of the server's `tools/tabs.ts`.
 * These were missing from the v1.3.4 bundle; here they are clean source.
 *
 * Tabs are enumerated across all normal windows in a stable order so the
 * `index` returned by `browser_list_tabs` round-trips back through
 * `browser_switch_tab` / `browser_close_tab`.
 */
import { runFunc } from "./run-func";

export interface TabInfo {
  index: number;
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  /**
   * True for a private-browsing tab. `chrome.tabs.query` returns these once the
   * extension is allowed in Incognito/InPrivate (verified in Chrome and Edge,
   * 2026-09-05), and a roster that did not mark them would show a clean-session
   * tab as an ordinary one — which is the difference between "logged out" and
   * "logged in" to anyone reading the list.
   */
  incognito: boolean;
}

interface TabRef {
  tabId?: number;
  index?: number;
}

async function enumerateTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  // Stable order: by window, then by position within the window.
  return tabs.sort((a, b) =>
    a.windowId === b.windowId
      ? (a.index ?? 0) - (b.index ?? 0)
      : (a.windowId ?? 0) - (b.windowId ?? 0),
  );
}

export async function resolveTabRef(ref: TabRef): Promise<number> {
  if (ref.tabId != null) return ref.tabId;
  if (ref.index != null) {
    const tabs = await enumerateTabs();
    const tab = tabs[ref.index];
    if (!tab?.id) throw new Error(`No tab at index ${ref.index}`);
    return tab.id;
  }
  throw new Error("Provide either `tabId` or `index`");
}

export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await enumerateTabs();
  return tabs.map((t, index) => ({
    index,
    tabId: t.id ?? -1,
    url: t.url ?? "",
    title: t.title ?? "",
    active: !!t.active,
    incognito: !!t.incognito,
  }));
}

/**
 * The exact toggle a person has to tick, named for both browsers because one
 * extension serves both and an agent cannot tell the user which words to look
 * for if we only know one of them. Both strings were read off the live settings
 * pages on 2026-09-05, not remembered.
 */
const INCOGNITO_TOGGLE =
  'open the extension\'s details page (chrome://extensions or edge://extensions, click "Details" ' +
  'on AutomateBrowser) and turn on "Allow in Incognito" — Edge calls it "Allow in InPrivate". ' +
  "Only a person can do that, and the extension restarts when they do.";

export async function newTab(payload: {
  url?: string;
  active?: boolean;
  incognito?: boolean;
}): Promise<{ tabId: number; index: number; incognito: boolean }> {
  // Background by DEFAULT: focus belongs to the person at the keyboard, and an
  // agent opening a tab is not a reason to yank them out of what they are doing.
  // `active: true` is the explicit opt-in, for when the user asked to be shown
  // something. An absent flag means background, so an older server build (which
  // sends no flag) also stops stealing focus.
  const active = payload?.active === true;

  if (payload?.incognito === true) {
    // A private tab needs a private WINDOW — there is no way to move a tab into
    // one. Ask permission first: verified in Chrome 152 and Edge on 2026-09-05,
    // `chrome.windows.create({incognito:true})` without access RESOLVES NULL
    // rather than rejecting, so a caller that trusts the promise gets "success"
    // and no window. This check is the only thing between that and a
    // "cannot read properties of null" landing in an agent's lap.
    if (!(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new Error(
        `INCOGNITO_BLOCKED: This extension is not allowed in private browsing. To fix it, ${INCOGNITO_TOGGLE}`,
      );
    }
    const win = await chrome.windows.create({
      url: payload?.url,
      incognito: true,
      focused: active,
    });
    const tab = win?.tabs?.[0];
    if (!win || tab?.id == null) {
      throw new Error(
        `INCOGNITO_BLOCKED: The browser returned no private window. Check that ${INCOGNITO_TOGGLE}`,
      );
    }
    return { tabId: tab.id, index: tab.index ?? -1, incognito: true };
  }

  const tab = await chrome.tabs.create({ url: payload?.url, active });
  if (active && tab.id != null && tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { tabId: tab.id ?? -1, index: tab.index ?? -1, incognito: !!tab.incognito };
}

/**
 * Runs in the page: its own visibility, waiting up to `ms` for it to become
 * visible, because a window that was just restored reports "hidden" for a beat.
 */
function visibleWithin(ms: number): Promise<string> {
  if (document.visibilityState === "visible") return Promise.resolve("visible");
  return new Promise((done) => {
    const answer = () => done(document.visibilityState);
    document.addEventListener("visibilitychange", answer, { once: true });
    setTimeout(answer, ms);
  });
}

export async function switchTab(
  ref: TabRef,
): Promise<{ tabId: number; visibilityState?: string }> {
  const tabId = await resolveTabRef(ref);
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId != null) {
    // Focusing does NOT un-minimise a window (Chrome documents it, and the plan 13
    // benchmark hit it): restore first, then focus. Only on this explicit switch,
    // which already takes the user's screen (decision D1).
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") {
      await chrome.windows.update(tab.windowId, { state: "normal" });
    }
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  // Report what the PAGE says, never what was asked for: OS focus rules can keep
  // the window behind others. A page that cannot be asked (a settings page) gets
  // no claim either way.
  try {
    return { tabId, visibilityState: await runFunc(tabId, visibleWithin, [1000]) };
  } catch {
    return { tabId };
  }
}

export async function closeTab(ref: TabRef): Promise<{ tabId: number }> {
  const tabId = await resolveTabRef(ref);
  await chrome.tabs.remove(tabId);
  return { tabId };
}
