import { writeFileSync } from "node:fs";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { callTimeout, timeoutArg } from "./args";
import type { Tool } from "./tool";

export const EvalArgs = z
  .object({
    expression: z
      .string()
      .optional()
      .describe(
        "A JavaScript expression, e.g. `document.title` or " +
          "`[...document.querySelectorAll('a')].length`.",
      ),
    function: z
      .string()
      .optional()
      .describe("A function called with the refs in `args`, e.g. `(el) => el.innerText`."),
    args: z.array(z.string()).optional().describe("Element refs passed to `function`, in order."),
    filePath: z.string().optional().describe("Write the result here instead of inlining it."),
    dialogAction: z
      .enum(["accept", "dismiss"])
      .optional()
      .describe("Answer a dialog raised by this code instead of hanging on it."),
    ...timeoutArg,
  })
  // Argument validation lives HERE, not in the extension: it costs no round trip,
  // no browser, and it is the same check whichever entry point called. Refinements
  // do not appear in the generated JSON schema, so none of this costs tokens.
  .refine((a) => !(a.expression && a.function), {
    message:
      "browser_eval takes either `expression` or `function`, not both. Use `function` when you " +
      "want to pass element refs in `args`; `expression` otherwise.",
  })
  .refine((a) => !!(a.expression?.trim() || a.function?.trim()), {
    message: "browser_eval requires a non-empty `expression` or `function`.",
  })
  .refine((a) => !(a.args?.length && !a.function), {
    message: "browser_eval `args` only applies to the `function` form.",
  });

/**
 * A cheap, targeted alternative to `browser_snapshot` for verifying page state
 * after an action (read text/attributes/counts/URL) without shipping a whole
 * accessibility tree. Mirrors Chrome DevTools MCP's `evaluate_script`.
 *
 * The `function` form (C19) closes the gap its own doc-comment used to admit:
 * an agent holding a good ref had to re-query by selector inside the expression,
 * which is exactly the fragility refs exist to remove — doubly so now that refs
 * are stable across re-renders.
 */
export const evaluate: Tool = {
  // filePath is a write target: routed through the same sandbox as every other
  // write path, before the tool can act on it.
  pathParams: [{ param: "filePath", mode: "write" }],
  schema: {
    name: "browser_eval",
    description:
      "Evaluate JavaScript in the tab you are driving and return the result. Pass `expression` for a quick " +
      "page-state check (text, attributes, counts, URL) instead of a full browser_snapshot, or " +
      "`function` plus `args` of element refs to work with elements you already have.",
    inputSchema: zodToJsonSchema(EvalArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = EvalArgs.parse(params ?? {});
    const result = await context.sendSocketMessage("browser_eval", args, {
      timeoutMs: callTimeout(params),
    });
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const rendered = text === undefined ? "undefined" : text;

    if (args.filePath) {
      writeFileSync(args.filePath, rendered, "utf8");
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${rendered.length} chars to ${args.filePath}`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: rendered }] };
  },
};
