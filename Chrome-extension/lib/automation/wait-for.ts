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
      // A `/.../` pattern is a regex; anything else, or a regex that does not
      // compile, is a substring (F13: `text` takes the same form as `urlPattern`).
      const matches = (hay: string, pat: string): boolean => {
        if (pat.length > 1 && pat.startsWith("/") && pat.endsWith("/")) {
          try {
            return new RegExp(pat.slice(1, -1)).test(hay);
          } catch {
            /* fall through to a substring */
          }
        }
        return hay.includes(pat);
      };
      const check = (): boolean => {
        if (a.selector) {
          const el = document.querySelector(a.selector);
          if (state === "attached") return !!el;
          if (state === "detached") return !el;
          if (state === "hidden") return !isVisible(el);
          return isVisible(el); // visible (default)
        }
        if (a.text) {
          // "Gone" is the only useful reading of hidden/detached for text: wait
          // for "Loading" to clear, or "Result: n/a" to be replaced.
          const has = !!document.body && matches(document.body.innerText, a.text);
          return state === "detached" || state === "hidden" ? !has : has;
        }
        if (a.urlPattern) return matches(location.href, a.urlPattern);
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
