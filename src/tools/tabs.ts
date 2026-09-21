import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Context } from "@/context";

import type { Tool } from "./tool";

export const TabRef = z
  .object({
    tabId: z.number().int().optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .refine(
    (v) => v.tabId !== undefined || v.index !== undefined,
    "Provide either `tabId` or `index`",
  );

/**
 * `browser_select_tab` accepts everything `TabRef` does plus a `url`/`title`
 * substring, so an agent can target "its" tab by context (e.g. the app's dev URL)
 * in a single call instead of listing tabs and eyeballing the id.
 */
export const SelectTabRef = z
  .object({
    tabId: z.number().int().optional(),
    index: z.number().int().nonnegative().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  })
  .refine(
    (v) => v.tabId !== undefined || v.index !== undefined || !!v.url?.trim() || !!v.title?.trim(),
    "Provide `tabId`, `index`, `url`, or `title`",
  );

export const NewTabArgs = z.object({
  url: z.string().url().optional(),
  active: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Bring the tab to the front, stealing the user's focus. Default false " +
        "(background) — pass true only if the user asked to be shown it.",
    ),
  incognito: z
    .boolean()
    .optional()
    .describe("Open a private window: no logins, no history. Needs a one-off setting."),
});

const NoArgs = z.object({}).strict();
const TabsOutput = z.object({
  tabs: z.array(z.record(z.unknown())),
});
const TabResultOutput = z.object({
  tabId: z.number().optional(),
  index: z.number().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
});

/**
 * Resolve a `url`/`title` substring (case-insensitive) to exactly one open tab's
 * id so `browser_select_tab` can pick a tab by context. Uses the `noClaim`
 * discovery path; throws a readable listing when nothing — or more than one tab —
 * matches, so the agent can narrow it.
 */
async function resolveTabByMatch(context: Context, url?: string, title?: string): Promise<number> {
  const tabs = (await context.sendSocketMessage(
    "browser_list_tabs",
    {},
    {
      noClaim: true,
    },
  )) as Array<{
    index: number;
    tabId: number;
    url: string;
    title: string;
    active: boolean;
    incognito?: boolean;
  }>;
  const u = url?.trim().toLowerCase();
  const t = title?.trim().toLowerCase();
  const matches = tabs.filter(
    (tab) =>
      (u ? (tab.url ?? "").toLowerCase().includes(u) : true) &&
      (t ? (tab.title ?? "").toLowerCase().includes(t) : true),
  );
  const render = (list: typeof tabs) =>
    list
      .map(
        (tab) =>
          `  [${tab.index}] tabId=${tab.tabId}${tab.incognito ? " (private)" : ""} ${tab.title} — ${tab.url}`,
      )
      .join("\n");
  if (matches.length === 0) {
    throw new Error(
      `No open tab matches ${JSON.stringify({ url, title })}. Open tabs:\n${render(tabs)}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} tabs match ${JSON.stringify({ url, title })} — narrow it or pass tabId. Matches:\n${render(matches)}`,
    );
  }
  return matches[0].tabId;
}

export const listTabs: Tool = {
  schema: {
    name: "browser_list_tabs",
    description:
      "List the connected browser's open tabs. Returns an array of " +
      "{ index, tabId, url, title, active, incognito } objects.",
    inputSchema: zodToJsonSchema(NoArgs),
    outputSchema: zodToJsonSchema(TabsOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context) => {
    // Pure discovery — must not grab a lease, or it would lock out another IDE.
    const tabs = (await context.sendSocketMessage(
      "browser_list_tabs",
      {},
      {
        noClaim: true,
      },
    )) as Array<{
      index: number;
      tabId: number;
      url: string;
      title: string;
      active: boolean;
      incognito?: boolean;
    }>;
    return {
      content: [
        {
          type: "text",
          text: tabs
            .map(
              (t) =>
                `${t.active ? "* " : "  "}[${t.index}] tabId=${t.tabId}${t.incognito ? " (private)" : ""} ${t.title} — ${t.url}`,
            )
            .join("\n"),
        },
      ],
      structuredContent: { tabs },
    };
  },
};

export const newTab: Tool = {
  schema: {
    name: "browser_new_tab",
    description:
      "Open a new tab IN THE BACKGROUND and drive it — no focus stealing. Optional " +
      "`url` navigates immediately.",
    inputSchema: zodToJsonSchema(NewTabArgs),
    outputSchema: zodToJsonSchema(TabResultOutput),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const { url, active, incognito } = NewTabArgs.parse(params);
    // Creating a tab is not tab-exclusive — skip the claim gate, then adopt the
    // new tab as this controller's target so subsequent drives ride it.
    const result = (await context.sendSocketMessage(
      "browser_new_tab",
      { url, active, incognito },
      { noClaim: true },
    )) as { tabId: number; index: number; incognito?: boolean };
    // Flagged as OURS: a tab the agent opened is closed again on release, unlike
    // one it adopted from the user with browser_select_tab.
    if (typeof result?.tabId === "number") {
      context.setActiveTab(result.tabId, { created: true });
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Opened new tab tabId=${result.tabId} index=${result.index}${url ? ` url=${url}` : ""}` +
            // Say it back rather than echoing the request: a private window is a
            // DIFFERENT session, and an agent that assumed it got one when it did
            // not would read the user's real logins as a stranger's.
            (result.incognito ? " [private window — no logins, no history]" : ""),
        },
      ],
      structuredContent: result,
    };
  },
};

export const switchTab: Tool = {
  schema: {
    name: "browser_switch_tab",
    description:
      "STEALS THE USER'S FOCUS: brings a tab to the front and drives it, by `tabId` " +
      '(preferred) or `index`. Only for an explicit "show me" request — otherwise use ' +
      "browser_select_tab, which drives a tab without disturbing them.",
    inputSchema: zodToJsonSchema(TabRef),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = TabRef.parse(params);
    // The extension resolves index→tabId and focuses the tab; adopt the result so
    // this controller drives it next. noClaim — the claim lands on the first drive.
    const result = (await context.sendSocketMessage("browser_switch_tab", args, {
      noClaim: true,
    })) as { tabId?: number } | undefined;
    const tabId = typeof result?.tabId === "number" ? result.tabId : args.tabId;
    if (typeof tabId === "number") context.setActiveTab(tabId);
    return {
      content: [
        {
          type: "text",
          text: `Switched to tab ${args.tabId !== undefined ? `tabId=${args.tabId}` : `index=${args.index}`}`,
        },
      ],
    };
  },
};

export const selectTab: Tool = {
  schema: {
    name: "browser_select_tab",
    description:
      "TAKE OVER a tab the user already has open, WITHOUT focusing it — the tool for " +
      '"pick up the testing I started". Identify it by `tabId` (preferred) or `index` ' +
      'from browser_list_tabs, or by a `url`/`title` substring (e.g. { url: "localhost:3000" }). ' +
      "Two agents can each take over a different tab and drive them concurrently. " +
      "Subsequent actions run against this tab until you select/switch another.",
    inputSchema: zodToJsonSchema(SelectTabRef),
    outputSchema: zodToJsonSchema(TabResultOutput),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = SelectTabRef.parse(params);
    // A url/title matcher resolves to one tab id first (target a tab by context);
    // tabId/index pass straight through.
    let tabId = args.tabId;
    if (tabId === undefined && args.index === undefined) {
      tabId = await resolveTabByMatch(context, args.url, args.title);
    }
    const target = tabId !== undefined ? { tabId } : { index: args.index };
    // Resolve/validate the tab WITHOUT claiming (so two IDEs can each select a
    // different tab); the claim happens on the first drive. Adopt it as the
    // controller's target — this is per-controller state, not a browser global.
    const result = (await context.sendSocketMessage("browser_select_tab", target, {
      noClaim: true,
    })) as { tabId?: number; url?: string; title?: string };
    const resolved = typeof result?.tabId === "number" ? result.tabId : tabId;
    if (typeof resolved === "number") context.setActiveTab(resolved);
    return {
      content: [
        {
          type: "text",
          text: `Now driving tabId=${resolved}${result?.title ? ` — ${result.title}` : ""}${result?.url ? ` ${result.url}` : ""}`,
        },
      ],
      structuredContent: { ...result, tabId: resolved },
    };
  },
};

export const closeTab: Tool = {
  schema: {
    name: "browser_close_tab",
    description: "Close a tab by `tabId` or `index`.",
    inputSchema: zodToJsonSchema(TabRef),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  skipConsoleDelta: true,
  handle: async (context, params) => {
    const args = TabRef.parse(params);
    await context.sendSocketMessage("browser_close_tab", args, { noClaim: true });
    // If we just closed the tab we were driving, drop the selection so the next
    // drive falls back instead of targeting a dead id.
    if (typeof args.tabId === "number") context.clearActiveTab(args.tabId);
    return {
      content: [
        {
          type: "text",
          text: `Closed tab ${args.tabId !== undefined ? `tabId=${args.tabId}` : `index=${args.index}`}`,
        },
      ],
    };
  },
};
