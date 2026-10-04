import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { mcpConfig, snapshotEachAction } from "@repo/config/mcp.config";
import { GoBackTool, GoForwardTool, NavigateTool, WaitTool } from "@repo/types/mcp/tool";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import { callTimeout, includeArg, timeoutArg } from "./args";
import { ToolError } from "./errors";
import type { Tool, ToolFactory } from "./tool";

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "about:"]);
const settleArgs = {
  waitUntil: z
    .enum(["none", "auto", "load", "networkidle"])
    .optional()
    .describe("Page-settle mode; default auto."),
  settleMs: z
    .number()
    .int()
    .nonnegative()
    .max(15000)
    .optional()
    .describe("Cap the settle wait, ms."),
};
export const NavigateArgs = NavigateTool.shape.arguments.extend({
  ...settleArgs,
  ...timeoutArg,
  ...includeArg,
  // `url` is required by the vendored schema, but a reload has nothing to point
  // at. Relaxed here and enforced in the handler, so the common case still reads
  // as "url is what you pass" without an enum whose other value is the default.
  url: z.string().optional().describe("URL to open. Omit only when reload is true."),
  reload: z
    .boolean()
    .optional()
    .describe("Reload the current page instead of navigating to a URL."),
  ignoreCache: z
    .boolean()
    .optional()
    .describe("With reload, bypass the cache — the hard reload for 'but I already fixed that'."),
  initScript: z
    .string()
    .optional()
    .describe(
      "JS to run before any page script, this navigation only (stub Date.now, mock fetch). " +
        "Needs browser_advanced_mode.",
    ),
  handleBeforeUnload: z
    .enum(["accept", "dismiss"])
    .optional()
    .describe(
      "Auto-answer a 'Leave site?' prompt so navigation cannot hang. Needs browser_advanced_mode.",
    ),
});
export const GoArgs = z.object({ ...settleArgs, ...timeoutArg }).strict();

/**
 * Browser-internal pages: no extension may script or capture them, so every tool
 * refuses them with one sentence (plan 14, F3). The extension's screenshot keeps
 * its own copy of this list — the two bundles share no code.
 */
const SETTINGS_SCHEMES =
  /^(chrome|edge|brave|opera|vivaldi|chrome-extension|chrome-untrusted|devtools):$/;

/** Refuse a URL no tool may open. Shared by `browser_navigate` and `browser_new_tab`. */
export function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (SETTINGS_SCHEMES.test(parsed.protocol)) {
    throw new ToolError(
      "RESTRICTED_PAGE",
      `${rawUrl}: a browser settings page cannot be read by the agent; a person must look at it.`,
    );
  }
  if (!SAFE_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to navigate to ${parsed.protocol} URL. Allowed schemes: ${[...SAFE_URL_SCHEMES].join(", ")}`,
    );
  }
}

/**
 * Decide whether a tool re-bundles a full snapshot. Precedence:
 *   1. explicit `includeSnapshot` on the call always wins;
 *   2. the global `AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION` override forces it on;
 *   3. otherwise the tool's factory default (navigation defaults on because it
 *      always invalidates element refs; interactions default off — lean).
 */
function resolveIncludeSnapshot(
  params: Record<string, unknown> | undefined,
  factoryDefault: boolean,
): boolean {
  const v = params?.includeSnapshot;
  if (v !== undefined) return v !== false;
  if (snapshotEachAction()) return true;
  return factoryDefault;
}

/**
 * How long a suspected miss is given to prove itself wrong, and how often the
 * tab is asked. Paid ONLY on a call already reported as having gone nowhere, so
 * a navigation that worked never waits for this.
 *
 * Read per call rather than at module load so a slow network can be given more
 * room without a restart — and so the suite can run it at a tenth of a second
 * instead of adding eight seconds to a gate for assertions about wording.
 */
const NAV_CONFIRM_STEP_MS = 200;
function navConfirmMs(): number {
  const raw = Number(process.env.AUTOMATE_BROWSER_NAV_CONFIRM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
}

/**
 * One address, allowing for the browser's own normalisation — `http://a.test`
 * and `http://a.test/` are the same page, and a caller may type either.
 */
function sameUrl(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * F1: the extension reports `loadError` when the load ended on Chrome's own error
 * page. Thrown before any snapshot — that page has nothing to read, and the
 * snapshot's failure on it used to arrive as RESTRICTED_PAGE with chrome://
 * advice, which sent agents looking for the wrong problem.
 *
 * Only the error's PRESENCE decides; its text is Chrome's and is passed through.
 * The http-to-https note reads the two urls, never the error.
 */
function assertLoaded(result: Record<string, unknown>, asked: string | undefined): void {
  if (typeof result.loadError !== "string") return;
  const failed = typeof result.failedUrl === "string" ? result.failedUrl : (asked ?? "the page");
  let upgraded = false;
  try {
    upgraded =
      !!asked &&
      new URL(asked).protocol === "http:" &&
      new URL(failed).protocol === "https:" &&
      new URL(asked).host === new URL(failed).host;
  } catch {
    // An unparseable url cannot have been upgraded; say nothing about it.
  }
  throw new ToolError(
    "NAVIGATION_FAILED",
    `${asked ?? failed} did not load — Chrome showed its error page instead (${result.loadError}` +
      `${sameUrl(failed, asked) ? "" : ` for ${failed}`}). ` +
      (upgraded
        ? `You asked for http://; Chrome upgraded it to https ("Always use secure connections") ` +
          `and the https version failed. Only a person can allow the http site in Chrome. `
        : "") +
      `Nothing on that page can be read or clicked.`,
  );
}

/**
 * Whether the tab really has not moved — confirmed against the browser, never
 * assumed from the first answer.
 *
 * The extension stops waiting if nothing has begun loading within its start
 * grace, so a first report of "nothing moved" means "nothing had moved YET",
 * which is not the same thing. Measured on a real Chrome: a page the browser is
 * slow to commit — an interstitial is the reliable example — reports exactly
 * that and then lands about 700 ms later. Announcing a failure on the first
 * answer would replace one false sentence with another; it did, in the first
 * version of this fix, on two visits out of three. So the tab is asked again
 * until it moves or {@link navConfirmMs} is up.
 *
 * Returns false whenever it cannot tell, because silence is the safe answer:
 * saying nothing costs a caller the old behaviour, accusing wrongly costs it a
 * retry of something that already worked.
 */
async function navigationReallyMissed(context: Context, urlBefore: unknown): Promise<boolean> {
  if (typeof urlBefore !== "string") return false;
  const deadline = Date.now() + navConfirmMs();
  for (;;) {
    let now: unknown;
    try {
      now = await context.sendSocketMessage(
        "getUrl",
        {},
        { timeoutMs: mcpConfig.timeouts.default },
      );
    } catch {
      return false;
    }
    if (typeof now === "string" && now !== urlBefore) return false;
    if (Date.now() >= deadline) return true;
    await new Promise((r) => setTimeout(r, NAV_CONFIRM_STEP_MS));
  }
}

export const navigate: ToolFactory = (snapshot) => ({
  schema: {
    name: NavigateTool.shape.name.value,
    description: NavigateTool.shape.description.value,
    inputSchema: zodToJsonSchema(NavigateArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = NavigateArgs.parse(params);
    const { url, reload } = args;
    if (reload) {
      if (url) throw new Error("Pass either url or reload:true, not both.");
    } else {
      if (!url) throw new Error("browser_navigate needs a url (or reload:true).");
      assertSafeUrl(url);
    }
    const result = (await context.sendSocketMessage("browser_navigate", args, {
      timeoutMs: callTimeout(params, mcpConfig.timeouts.navigation),
    })) as Record<string, unknown>;
    assertLoaded(result, url);
    // The extension reports where the tab actually ended up, and a navigation
    // that never happened still answers `ok`. "Navigated to X" is therefore a
    // claim, not a report — and it is the sentence B09's regression hid behind:
    // the only trace of the miss was `navigated: false` inside
    // `structuredContent`, which the snapshot branch below discards entirely, so
    // the caller was handed the OLD page under a success message.
    //
    // The question is not "did the browser settle" — it answers that about
    // whatever document is in front of it, and on a dropped navigation it
    // cheerfully settles on the OLD one, which is how this was first written and
    // why it stayed silent on two visits out of six. The question is whether the
    // tab is where the call asked it to go.
    //
    // Excluded, because the url legitimately does not change for them: a reload;
    // `waitUntil: "none"`, which asked not to wait and so cannot know; and a
    // navigation to the page already open, which is a reload by another name.
    // An older extension that reports no url is excluded too, by
    // `navigationReallyMissed` refusing to guess.
    const stalled =
      !reload &&
      args.waitUntil !== "none" &&
      result.navigated === false &&
      !sameUrl(result.urlBefore, url) &&
      (await navigationReallyMissed(context, result.urlBefore));
    // Worded as an OBSERVATION over a named window, not as a verdict, because a
    // verdict is not available: the browser is still moving while this is read,
    // and a page that lands a moment after the window would make "did not
    // navigate" false. "Had not left X after 2.0s" stays true either way, and it
    // is the sentence a caller can act on — read again, or stop trusting the
    // page in front of it.
    const stillAt = typeof result.urlAfter === "string" ? result.urlAfter : undefined;
    const missed =
      `Did NOT reach ${url} — after ${(navConfirmMs() / 1000).toFixed(1)}s the tab was still on ` +
      `${stillAt ?? "the page it started from"}, so anything you read now is that OLD page, not ` +
      `${url}. The call itself was accepted; the browser simply did not go. If the site is merely ` +
      `slow, look again in a moment; if this repeats, the navigation is being dropped — a page ` +
      `refusing to be left (a certificate interstitial, a beforeunload prompt) does it every time.`;
    if (resolveIncludeSnapshot(params, snapshot)) {
      return captureAriaSnapshot(context, stalled ? missed : "");
    }
    return {
      content: [
        {
          type: "text",
          text: reload
            ? `Reloaded${args.ignoreCache ? " (cache bypassed)" : ""}`
            : stalled
              ? missed
              : `Navigated to ${url}`,
        },
      ],
      structuredContent: { action: result },
    };
  },
});

export const goBack: ToolFactory = (snapshot) => ({
  schema: {
    name: GoBackTool.shape.name.value,
    description: GoBackTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = GoArgs.parse(params ?? {});
    const result = (await context.sendSocketMessage("browser_go_back", args, {
      timeoutMs: callTimeout(params, mcpConfig.timeouts.navigation),
    })) as Record<string, unknown>;
    if (resolveIncludeSnapshot(params, snapshot)) {
      return captureAriaSnapshot(context);
    }
    return {
      content: [
        {
          type: "text",
          text: "Navigated back",
        },
      ],
      structuredContent: { action: result },
    };
  },
});

export const goForward: ToolFactory = (snapshot) => ({
  schema: {
    name: GoForwardTool.shape.name.value,
    description: GoForwardTool.shape.description.value,
    inputSchema: zodToJsonSchema(GoArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = GoArgs.parse(params ?? {});
    const result = (await context.sendSocketMessage("browser_go_forward", args, {
      timeoutMs: callTimeout(params, mcpConfig.timeouts.navigation),
    })) as Record<string, unknown>;
    if (resolveIncludeSnapshot(params, snapshot)) {
      return captureAriaSnapshot(context);
    }
    return {
      content: [
        {
          type: "text",
          text: "Navigated forward",
        },
      ],
      structuredContent: { action: result },
    };
  },
});

export const wait: Tool = {
  schema: {
    name: WaitTool.shape.name.value,
    description: WaitTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitTool.shape.arguments),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const { time } = WaitTool.shape.arguments.parse(params);
    // Allow the WS round-trip to exceed the wait duration without spuriously
    // timing out. 5s of headroom covers extension-side processing.
    const timeoutMs = Math.ceil(time * 1000) + 5_000;
    await context.sendSocketMessage("browser_wait", { time }, { timeoutMs });
    return {
      content: [
        {
          type: "text",
          text: `Waited for ${time} seconds`,
        },
      ],
    };
  },
};

export const PressKeyArgs = z.object({
  ...timeoutArg,
  key: z
    .string()
    .min(1)
    .describe(
      "A key or modifier combo dispatched to the focused element. Single keys: a named key " +
        "(Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown) " +
        'or a single character. Combos use \'+\': e.g. "Control+A", "Shift+Tab", "Control+Shift+R", ' +
        '"Meta+K". Modifiers: Control, Shift, Alt, Meta. Synthetic events drive in-page/SPA shortcuts; ' +
        "native browser shortcuts (e.g. real clipboard) need the debugger mode.",
    ),
  ...settleArgs,
});

export const pressKey: Tool = {
  blockedByDialog: true,
  schema: {
    name: "browser_press_key",
    description:
      'Press a key or modifier combo (e.g. Enter, Tab, "Control+A", "Shift+Tab") on the focused element.',
    inputSchema: zodToJsonSchema(PressKeyArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = PressKeyArgs.parse(params);
    const { key } = args;
    const result = (await context.sendSocketMessage("browser_press_key", args, {
      timeoutMs: callTimeout(params),
    })) as Record<string, unknown>;
    return {
      content: [
        {
          type: "text",
          text: `Pressed key ${key}`,
        },
      ],
      structuredContent: { action: result },
    };
  },
};
