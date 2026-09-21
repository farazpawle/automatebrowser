import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { callTimeout, timeoutArg } from "./args";
import type { Tool } from "./tool";

/**
 * Form / input convenience tools. `fill_form` mirrors Chrome DevTools MCP's
 * batch fill (one round-trip for many fields); `scroll` and `clear` round out
 * the debugger-free interaction set.
 */

export const FillFormArgs = z.object({
  ...timeoutArg,
  fields: z
    .array(
      z.object({
        ref: z.string().describe("Element ref from a snapshot/find."),
        value: z.string().describe(
          // Every word here is paid for on EVERY request (design principle 1),
          // and the budget had two tokens of room. So this says only what the
          // contract IS; the refusal message itself tells an agent that got it
          // wrong to set the chosen option's own ref to "true", which is
          // principle 4 doing the teaching at no cost to anyone else.
          'Value to set. Checkboxes/radios: "true" or "false" only. ' +
            "For <select>, the option value/label/text.",
        ),
      }),
    )
    .min(1)
    .describe("The fields to fill, each { ref, value }."),
});

export const fillForm: Tool = {
  blockedByDialog: true,
  schema: {
    name: "browser_fill_form",
    description:
      "Fill multiple form fields (inputs, textareas, selects, checkboxes, radios, contenteditable) " +
      "in ONE call. Prefer this over many browser_type/browser_click calls for forms — far fewer turns. " +
      "Take a browser_snapshot first to get the refs.",
    inputSchema: zodToJsonSchema(FillFormArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = FillFormArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_fill_form", args, {
      timeoutMs: callTimeout(params),
    })) as { filled: number; total: number; errors: Array<{ ref: string; error?: string }> };
    const errs = r.errors.length
      ? `\n${r.errors.map((e) => `  ✗ ${e.ref}: ${e.error ?? "failed"}`).join("\n")}`
      : "";
    // Three outcomes, not two. `isError` alone reported "filled 2 of 3" as an
    // unqualified success, so an agent reading the flag rather than the count
    // moved on with a third of the form empty. The per-field verdicts ride
    // along structured as well as in prose — this tool declares no
    // `outputSchema`, so nothing validates them away (I04).
    const failedAll = r.errors.length > 0 && r.filled === 0;
    return {
      content: [{ type: "text", text: `Filled ${r.filled}/${r.total} field(s)${errs}` }],
      structuredContent: { filled: r.filled, total: r.total, errors: r.errors },
      isError: failedAll,
      outcome: failedAll ? "failed" : r.errors.length > 0 ? "partial" : "success",
    };
  },
};

export const ClearArgs = z.object({
  ...timeoutArg,
  ref: z.string().describe("Element ref of the input/textarea/contenteditable to clear."),
});

export const clear: Tool = {
  blockedByDialog: true,
  schema: {
    name: "browser_clear",
    description: "Clear the value of an input, textarea, or contenteditable element by `ref`.",
    inputSchema: zodToJsonSchema(ClearArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = ClearArgs.parse(params ?? {});
    await context.sendSocketMessage("browser_clear", args, {
      timeoutMs: callTimeout(params),
    });
    return { content: [{ type: "text", text: `Cleared ${args.ref}` }] };
  },
};

export const ScrollArgs = z.object({
  ...timeoutArg,
  ref: z.string().optional().describe("Scroll this element into view (by ref)."),
  to: z.enum(["top", "bottom"]).optional().describe("Scroll the page to the top or bottom."),
  dx: z.number().optional().describe("Horizontal pixels to scroll by."),
  dy: z.number().optional().describe("Vertical pixels to scroll by."),
});

export const scroll: Tool = {
  blockedByDialog: true,
  schema: {
    name: "browser_scroll",
    description:
      "Scroll the page or an element. With no arguments, scrolls down ~one viewport. " +
      "Use `ref` to bring an element into view, `to` for top/bottom, or `dx`/`dy` for a precise delta.",
    inputSchema: zodToJsonSchema(ScrollArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = ScrollArgs.parse(params ?? {});
    await context.sendSocketMessage("browser_scroll", args, {
      timeoutMs: callTimeout(params),
    });
    const where = args.ref
      ? `to ${args.ref}`
      : args.to
        ? `to ${args.to}`
        : args.dx != null || args.dy != null
          ? `by (${args.dx ?? 0}, ${args.dy ?? 0})`
          : "down one viewport";
    return { content: [{ type: "text", text: `Scrolled ${where}` }] };
  },
};
