/**
 * Shared `chrome.scripting` injection helper used by every debugger-free engine
 * module (driver, content-ops, forms, state, dialog).
 *
 * Injected functions are serialised by source, so any function passed here MUST
 * be fully self-contained (define its own helpers inline, reference no
 * module-scope bindings).
 */

export type World = "MAIN" | "ISOLATED";

/**
 * Run a self-contained function in the page and return its single-frame result.
 *
 * `frameId` targets ONE frame — that is how a cross-origin iframe is driven (B5).
 * Omitted, it means the top frame, which is what every caller before B5 meant, so
 * it is an optional TRAILING parameter and no existing call site moved. (`runFunc`
 * has 18 direct callers across 8 tool families and a CRITICAL blast radius; the
 * mitigation is to add, never to change.)
 */
export async function runFunc<A extends any[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
  world: World = "ISOLATED",
  frameId?: number,
): Promise<R> {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target:
        frameId != null && frameId !== 0 ? { tabId, frameIds: [frameId] } : { tabId },
      func: func as (...a: any[]) => any,
      args: args as any[],
      world,
    });
  } catch (e: any) {
    throw new Error(
      `RESTRICTED_PAGE: Cannot run on this page (${e?.message || e}). It may be a restricted page (chrome://, the Web Store, a PDF) — open a normal http(s) page.`,
    );
  }
  const top = frames?.[0];
  if (!top) throw new Error("Injection returned no result (restricted page?)");
  return top.result as R;
}

/**
 * Run the same function in EVERY frame of the tab and keep each frame's result
 * with the frame it came from (B5).
 *
 * This is what reaches a cross-origin iframe at all: the top document cannot read
 * `contentDocument` across an origin boundary, but the extension can inject into
 * that frame directly because its host permissions cover it. `frameId` comes back
 * on each `InjectionResult` (Chrome 90+), so frame identity is established in the
 * WORKER — the injected code neither knows nor needs to know which frame it is in,
 * which is why B5 adds no new copy of the in-page resolver.
 *
 * Never throws for a frame that refuses injection: an ad frame or one that
 * navigated mid-call drops out of the list rather than failing the whole call.
 */
export async function runFuncAllFrames<A extends any[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
  world: World = "ISOLATED",
): Promise<Array<{ frameId: number; result: R }>> {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: func as (...a: any[]) => any,
      args: args as any[],
      world,
    });
  } catch (e: any) {
    throw new Error(
      `RESTRICTED_PAGE: Cannot run on this page (${e?.message || e}). It may be a restricted page (chrome://, the Web Store, a PDF) — open a normal http(s) page.`,
    );
  }
  return (frames ?? [])
    .filter((f) => f && f.result != null)
    .map((f) => ({ frameId: f.frameId, result: f.result as R }));
}

/** Unwrap the `{ ok, error }` envelope the injected ops return. */
export function unwrap<T extends { ok: boolean; error?: string }>(r: T): T {
  if (!r || !r.ok) throw new Error(r?.error || "Action failed");
  return r;
}
