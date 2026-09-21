/**
 * `browser_wait_for` — resolve as soon as a page condition becomes true instead
 * of sleeping a fixed time. Implemented by injecting a poller into the target
 * tab via chrome.scripting. New in the rebuild (absent from the v1.3.4 bundle).
 */

export interface WaitForArgs {
  selector?: string;
  text?: string;
  urlPattern?: string;
  state?: "visible" | "hidden" | "attached" | "detached";
  timeoutMs?: number;
}

export async function waitForCondition(
  tabId: number,
  args: WaitForArgs,
): Promise<{ ok: true }> {
  const [{ result } = { result: false }] = await chrome.scripting.executeScript({
    target: { tabId },
    // Runs in the page. Keep self-contained (no outer references).
    func: (a: WaitForArgs) => {
      const deadline = Date.now() + (a.timeoutMs ?? 15000);
      const state = a.state ?? "visible";
      const isVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const he = el as HTMLElement;
        const box = !!(he.offsetWidth || he.offsetHeight || el.getClientRects().length);
        return box && getComputedStyle(he).visibility !== "hidden";
      };
      const check = (): boolean => {
        if (a.selector) {
          const el = document.querySelector(a.selector);
          if (state === "attached") return !!el;
          if (state === "detached") return !el;
          if (state === "hidden") return !isVisible(el);
          return isVisible(el); // visible (default)
        }
        if (a.text) return !!document.body && document.body.innerText.includes(a.text);
        if (a.urlPattern) {
          const u = location.href;
          if (a.urlPattern.length > 1 && a.urlPattern.startsWith("/") && a.urlPattern.endsWith("/")) {
            try {
              return new RegExp(a.urlPattern.slice(1, -1)).test(u);
            } catch {
              return u.includes(a.urlPattern);
            }
          }
          return u.includes(a.urlPattern);
        }
        return false;
      };
      return new Promise<boolean>((resolve, reject) => {
        const tick = () => {
          let ok = false;
          try {
            ok = check();
          } catch {
            /* ignore transient errors */
          }
          if (ok) return resolve(true);
          if (Date.now() > deadline) return reject(new Error("wait_for: condition not met before timeout"));
          setTimeout(tick, 100);
        };
        tick();
      });
    },
    args: [args],
  });
  if (!result) throw new Error("wait_for: condition not met");
  return { ok: true };
}
