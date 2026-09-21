/**
 * Which tab the agent drives. Two layers:
 *   - an OPTIONAL explicit selection (set via `browser_select_tab`, the popup,
 *     or implicitly by `browser_switch_tab`/`browser_new_tab`), persisted in
 *     chrome.storage.local so it survives service-worker restarts;
 *   - an active-tab FALLBACK (`resolveTargetTabId`) so automation works
 *     immediately with zero ceremony when nothing is explicitly selected.
 *
 * Connection no longer depends on any of this — the socket is always on; this
 * only decides where commands land.
 */
const KEY = "selectedTab";

export async function getSelectedTabId(): Promise<number | null> {
  const v = await chrome.storage.local.get(KEY);
  const id = v[KEY];
  if (typeof id !== "number") return null;
  // Drop the selection if the tab has since closed.
  try {
    await chrome.tabs.get(id);
    return id;
  } catch {
    await chrome.storage.local.remove(KEY);
    return null;
  }
}

export async function setSelectedTabId(id: number): Promise<void> {
  await chrome.storage.local.set({ [KEY]: id });
}

export async function clearSelectedTab(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/**
 * The tab commands target right now: the explicit selection if one is set and
 * still open, otherwise the active tab of the last-focused normal window. Only
 * throws when the browser genuinely has no drivable tab.
 */
export async function resolveTargetTabId(): Promise<number> {
  const selected = await getSelectedTabId();
  if (selected != null) return selected;

  const [focused] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (focused?.id != null) return focused.id;

  const [anyActive] = await chrome.tabs.query({ active: true });
  if (anyActive?.id != null) return anyActive.id;

  throw new Error("No drivable tab found — open a tab in the browser.");
}

export function watchSelectedTab(
  cb: (id: number | null) => void,
): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local" || !(KEY in changes)) return;
    const next = changes[KEY].newValue;
    cb(typeof next === "number" ? next : null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
