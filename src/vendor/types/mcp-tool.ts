/**
 * Local replacement for `@repo/types/mcp/tool`. Zod schemas describing each
 * browser tool's name, description, and arguments. The MCP server reads
 * `<Tool>.shape.name.value` / `.shape.description.value` as the exposed tool's
 * name/description and `.shape.arguments` for input validation, so `name` and
 * `description` are `z.literal`s.
 *
 * Shapes mirror the v1.3.4 extension exactly (interaction tools take
 * `{ element, ref }` from a snapshot — NOT a CSS selector), so the server and
 * extension agree on every payload.
 */
import { z } from "zod";

/** Shared `{ element, ref }` argument block for interaction tools. */
const elementRef = {
  element: z
    .string()
    .describe(
      "Human-readable element description used to obtain permission to interact with the element",
    ),
  ref: z.string().describe("Exact target element reference from the page snapshot"),
};

/**
 * Optional per-call snapshot control. Interactions are lean by default (no
 * snapshot); navigation bundles one by default. Set true to force a snapshot,
 * false to suppress it. Prefer calling `browser_snapshot` explicitly when you
 * need fresh element refs, or `browser_eval` for a cheap state check.
 *
 * THE PARAGRAPH ABOVE USED TO BE THE `.describe()` TEXT, and it was the single
 * most expensive sentence this server shipped: 29 tokens on each of six tools,
 * re-sent on every request, saying the same thing six times. It now lives in the
 * shipped skill's `page-interaction` reference, which an agent reads once per
 * task instead of once per turn — design principle 1, applied to the largest
 * repeat in the budget.
 */
const includeSnapshotArg = {
  includeSnapshot: z
    .boolean()
    .optional()
    .describe("Bundle an accessibility snapshot into the reply."),
};

export const NavigateTool = z.object({
  name: z.literal("browser_navigate"),
  description: z.literal(
    "Navigate to a URL in YOUR OWN tab, opened in the background if you have none. " +
      "Never touches the tab the user is viewing; to drive one they already have " +
      "open, call browser_select_tab first.",
  ),
  arguments: z.object({
    url: z.string().describe("The URL to navigate to"),
    ...includeSnapshotArg,
  }),
});

export const GoBackTool = z.object({
  name: z.literal("browser_go_back"),
  description: z.literal("Go back to the previous page"),
  arguments: z.object({ ...includeSnapshotArg }),
});

export const GoForwardTool = z.object({
  name: z.literal("browser_go_forward"),
  description: z.literal("Go forward to the next page"),
  arguments: z.object({ ...includeSnapshotArg }),
});

export const WaitTool = z.object({
  name: z.literal("browser_wait"),
  description: z.literal("Wait for a specified time in seconds"),
  arguments: z.object({
    time: z.number().describe("The time to wait in seconds"),
  }),
});

export const PressKeyTool = z.object({
  name: z.literal("browser_press_key"),
  description: z.literal("Press a key on the keyboard"),
  arguments: z.object({
    key: z
      .string()
      .describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"),
  }),
});

export const SnapshotTool = z.object({
  name: z.literal("browser_snapshot"),
  description: z.literal(
    "Capture accessibility snapshot of the current page. Use this for getting references to elements to interact with.",
  ),
  arguments: z.object({}),
});

export const ClickTool = z.object({
  name: z.literal("browser_click"),
  description: z.literal("Click an element by ref, or a viewport point by x/y."),
  arguments: z.object({ ...elementRef, ...includeSnapshotArg }),
});

export const DragTool = z.object({
  name: z.literal("browser_drag"),
  description: z.literal("Perform drag and drop between two elements"),
  arguments: z.object({
    startElement: z
      .string()
      .describe(
        "Human-readable source element description used to obtain the permission to interact with the element",
      ),
    startRef: z.string().describe("Exact source element reference from the page snapshot"),
    endElement: z
      .string()
      .describe(
        "Human-readable target element description used to obtain the permission to interact with the element",
      ),
    endRef: z.string().describe("Exact target element reference from the page snapshot"),
    ...includeSnapshotArg,
  }),
});

export const HoverTool = z.object({
  name: z.literal("browser_hover"),
  description: z.literal("Hover over element on page"),
  arguments: z.object({ ...elementRef, ...includeSnapshotArg }),
});

export const TypeTool = z.object({
  name: z.literal("browser_type"),
  description: z.literal("Type text into editable element"),
  arguments: z.object({
    ...elementRef,
    text: z.string().describe("Text to type into the element"),
    submit: z.boolean().describe("Whether to submit entered text (press Enter after)"),
    ...includeSnapshotArg,
  }),
});

export const SelectOptionTool = z.object({
  name: z.literal("browser_select_option"),
  description: z.literal("Select an option in a dropdown"),
  arguments: z.object({
    ...elementRef,
    values: z
      .array(z.string())
      .describe(
        "Array of values to select in the dropdown. This can be a single value or multiple values.",
      ),
    ...includeSnapshotArg,
  }),
});

export const ScreenshotTool = z.object({
  name: z.literal("browser_screenshot"),
  description: z.literal("Take a screenshot of the current page"),
  arguments: z.object({}),
});

export const GetConsoleLogsTool = z.object({
  name: z.literal("browser_get_console_logs"),
  description: z.literal(
    "Console logs, uncaught errors with stacks, and service-worker lifecycle " +
      "(register/state/messages). A service worker's OWN console.log is not included — no " +
      "debugger-free API exposes it.",
  ),
  arguments: z.object({}),
});
