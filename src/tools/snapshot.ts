import { writeFileSync } from "node:fs";

import zodToJsonSchema from "zod-to-json-schema";
import { z } from "zod";

import { snapshotEachAction } from "@repo/config/mcp.config";
import {
  ClickTool,
  DragTool,
  HoverTool,
  SelectOptionTool,
  SnapshotTool,
  TypeTool,
} from "@repo/types/mcp/tool";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import { actionabilityEnabled, callTimeout, includeArg, timeoutArg } from "./args";
import type { ToolMessageMap } from "./messages";
import type { Tool, ToolResult } from "./tool";

const settleArgs = {
  waitUntil: z
    .enum(["none", "auto", "load", "networkidle"])
    .optional()
    .describe("Page-settle mode; default auto, none is fastest."),
  settleMs: z
    .number()
    .int()
    .nonnegative()
    .max(15000)
    .optional()
    .describe("Cap the settle wait, ms; default 2000."),
};
/**
 * A2: a canvas, a map, a PDF viewer and an `<area>` map have no addressable
 * element, so no snapshot ref can reach them. Rather than a 43rd tool schema,
 * `browser_click` takes a POINT as an alternative address — measured at a third
 * of the cost of a separate tool, and `dblClick` then works on both paths for
 * the price of one param. `element`/`ref` become optional so the point form can
 * omit them; the refine keeps exactly one of the two addresses required.
 */
export const ClickArgs = ClickTool.shape.arguments
  .extend({
    element: z.string().optional().describe("What you are clicking, in a few words."),
    ref: z.string().optional().describe("Element ref from a snapshot."),
    x: z.number().optional().describe("Viewport x — for a canvas/map/PDF with no ref."),
    y: z.number().optional().describe("Viewport y (with x)."),
    dblClick: z.boolean().optional().describe("Double-click."),
    ...settleArgs,
    ...timeoutArg,
    ...includeArg,
  })
  .refine(
    (v) => (v.ref !== undefined) !== (v.x !== undefined && v.y !== undefined),
    "Give either `ref` (from browser_snapshot) or both `x` and `y` — not both, and not neither.",
  );
export const TypeArgs = TypeTool.shape.arguments.extend({
  ...settleArgs,
  ...timeoutArg,
  ...includeArg,
});
export const DragArgs = DragTool.shape.arguments.extend(timeoutArg);
export const HoverArgs = HoverTool.shape.arguments.extend(timeoutArg);
export const SelectOptionArgs = SelectOptionTool.shape.arguments.extend(timeoutArg);

/**
 * Send one interaction and surface what the engine had to do to complete it.
 *
 * The actionability flag rides in the PAYLOAD, not the tool schema: it is a
 * server-side switch (`AUTOMATE_BROWSER_ACTIONABILITY=off`), so it costs no
 * schema tokens on any of the five tools that would otherwise each carry it.
 */
type ActionType =
  "browser_click" | "browser_drag" | "browser_hover" | "browser_type" | "browser_select_option";

async function sendAction(
  context: Context,
  type: ActionType,
  params: ToolMessageMap[ActionType]["payload"],
): Promise<Record<string, unknown>> {
  const payload = actionabilityEnabled() ? params : { ...params, actionability: false };
  return (await context.sendSocketMessage(type, payload, {
    timeoutMs: callTimeout(params),
  })) as Record<string, unknown>;
}

/**
 * A ref that had gone stale and was recovered is REPORTED, never swallowed (B2).
 * The action succeeded, but the page moved under the agent — silently succeeding
 * would leave it holding a map it has no reason to distrust.
 */
function recoveryNote(result: Record<string, unknown> | undefined): string {
  return result && result.recovered
    ? " — note: that ref had gone stale, so the page was re-tagged and the ref re-resolved. " +
        "Take a fresh browser_snapshot before relying on other refs."
    : "";
}

/**
 * Interactions are LEAN by default — they return a short confirmation, not a
 * full page snapshot. The agent calls `browser_snapshot` only when it needs
 * fresh element refs, and can verify state cheaply via `browser_eval` /
 * `browser_get_console_logs` in between. Pass `includeSnapshot: true` (or set
 * `AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION=1`) to re-bundle a snapshot per action.
 */
function shouldIncludeSnapshot(params: Record<string, unknown> | undefined): boolean {
  const v = params?.includeSnapshot;
  if (v !== undefined) return v !== false;
  return snapshotEachAction();
}

async function withOptionalSnapshot(
  context: Context,
  params: Record<string, unknown> | undefined,
  actionText: string,
  structuredContent?: Record<string, unknown>,
): Promise<ToolResult> {
  if (!shouldIncludeSnapshot(params)) {
    return { content: [{ type: "text", text: actionText }], structuredContent };
  }
  const snap = await captureAriaSnapshot(context);
  return {
    content: [{ type: "text", text: actionText }, ...snap.content],
    structuredContent: { ...(structuredContent ?? {}), snapshot: snap.structuredContent },
  };
}

const SnapshotArgs = SnapshotTool.shape.arguments.extend({
  verbose: z
    .boolean()
    .optional()
    .describe(
      "Return the full tree (all text and structure), not just interactive elements. Refs are unchanged.",
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "Write the snapshot to this file and return a summary — for pages too large to inline.",
    ),
});

export const snapshot: Tool = {
  schema: {
    name: SnapshotTool.shape.name.value,
    description: SnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(SnapshotArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  // Routed through the same choke point as every other write path: containment
  // against the negotiated roots AND the parent-directory check happen before
  // `handle` runs, and `filePath` is rewritten to the resolved absolute path.
  pathParams: [{ param: "filePath", mode: "write" }],
  handle: async (context: Context, params) => {
    const { filePath, verbose } = SnapshotArgs.parse(params ?? {});
    const snap = await captureAriaSnapshot(context, "", verbose === true);
    if (!filePath) return snap;
    const {
      url,
      title,
      snapshot: tree,
    } = (snap.structuredContent ?? {}) as {
      url?: string;
      title?: string;
      snapshot?: string;
    };
    writeFileSync(filePath, tree ?? "", "utf8");
    const lines = (tree ?? "").split("\n").length;
    return {
      content: [
        {
          type: "text",
          text:
            `Snapshot written to ${filePath} (${lines} lines).\n` +
            `- Page URL: ${url ?? "?"}\n- Page Title: ${title ?? "?"}`,
        },
      ],
      structuredContent: { url, title, filePath, lines },
    };
  },
};

export const click: Tool = {
  blockedByDialog: true,
  schema: {
    name: ClickTool.shape.name.value,
    description: ClickTool.shape.description.value,
    inputSchema: zodToJsonSchema(ClickArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context: Context, params) => {
    const validatedParams = ClickArgs.parse(params);
    const result = await sendAction(context, "browser_click", validatedParams);
    // A coordinate click that lands on the wrong thing is otherwise silent, so
    // the point form reports what was under the point.
    const hit = (result as { hit?: string }).hit;
    const what =
      validatedParams.ref !== undefined
        ? `"${validatedParams.element}"`
        : `(${validatedParams.x}, ${validatedParams.y})${hit ? ` — hit ${hit}` : ""}`;
    const how = validatedParams.dblClick ? "Double-clicked" : "Clicked";
    return withOptionalSnapshot(context, params, `${how} ${what}${recoveryNote(result)}`, {
      action: result,
    });
  },
};

export const drag: Tool = {
  blockedByDialog: true,
  schema: {
    name: DragTool.shape.name.value,
    description: DragTool.shape.description.value,
    inputSchema: zodToJsonSchema(DragArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context: Context, params) => {
    const validatedParams = DragArgs.parse(params);
    const result = await sendAction(context, "browser_drag", validatedParams);
    return withOptionalSnapshot(
      context,
      params,
      `Dragged "${validatedParams.startElement}" to "${validatedParams.endElement}"` +
        recoveryNote(result),
    );
  },
};

export const hover: Tool = {
  blockedByDialog: true,
  schema: {
    name: HoverTool.shape.name.value,
    description: HoverTool.shape.description.value,
    inputSchema: zodToJsonSchema(HoverArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context: Context, params) => {
    const validatedParams = HoverArgs.parse(params);
    const result = await sendAction(context, "browser_hover", validatedParams);
    return withOptionalSnapshot(
      context,
      params,
      `Hovered over "${validatedParams.element}"` + recoveryNote(result),
    );
  },
};

export const type: Tool = {
  blockedByDialog: true,
  schema: {
    name: TypeTool.shape.name.value,
    description: TypeTool.shape.description.value,
    inputSchema: zodToJsonSchema(TypeArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context: Context, params) => {
    const validatedParams = TypeArgs.parse(params);
    const result = await sendAction(context, "browser_type", validatedParams);
    return withOptionalSnapshot(
      context,
      params,
      `Typed "${validatedParams.text}" into "${validatedParams.element}"${recoveryNote(result)}`,
      { action: result },
    );
  },
};

export const selectOption: Tool = {
  blockedByDialog: true,
  schema: {
    name: SelectOptionTool.shape.name.value,
    description: SelectOptionTool.shape.description.value,
    inputSchema: zodToJsonSchema(SelectOptionArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context: Context, params) => {
    const validatedParams = SelectOptionArgs.parse(params);
    const result = await sendAction(context, "browser_select_option", validatedParams);
    return withOptionalSnapshot(
      context,
      params,
      `Selected option in "${validatedParams.element}"` + recoveryNote(result),
    );
  },
};
