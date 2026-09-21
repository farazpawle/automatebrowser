import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

export const WaitForArgs = z
  .object({
    selector: z
      .string()
      .optional()
      .describe("CSS selector to wait for. Combined with `state` to control what 'ready' means."),
    text: z
      .string()
      .optional()
      .describe("Text substring to wait for in the page body. Case-sensitive."),
    urlPattern: z
      .string()
      .optional()
      .describe("Substring or regex (anchored with /.../ ) the page URL must match."),
    state: z
      .enum(["visible", "hidden", "attached", "detached"])
      .optional()
      .describe(
        "Required selector state. Defaults to 'visible'. Ignored when only `text` or `urlPattern` is provided.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe("Max time to wait in milliseconds. Default 15000."),
  })
  .refine(
    (v) => v.selector || v.text || v.urlPattern,
    "Provide at least one of: selector, text, urlPattern",
  );

export const waitFor: Tool = {
  schema: {
    name: "browser_wait_for",
    description:
      "Wait for a page condition to become true (element appears/disappears, text appears, URL changes). " +
      "Prefer this over `browser_wait` whenever the condition is observable — it returns immediately when ready " +
      "instead of always sleeping for a fixed duration. Provide one of: selector, text, urlPattern.",
    inputSchema: zodToJsonSchema(WaitForArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = WaitForArgs.parse(params);
    const timeoutMs = args.timeoutMs ?? 15_000;
    await context.sendSocketMessage(
      "browser_wait_for",
      {
        selector: args.selector,
        text: args.text,
        urlPattern: args.urlPattern,
        state: args.state ?? "visible",
        timeoutMs,
      },
      { timeoutMs: timeoutMs + 5_000 },
    );
    const target = args.selector ?? args.text ?? args.urlPattern ?? "(condition)";
    return {
      content: [{ type: "text", text: `Condition met: ${target}` }],
    };
  },
};
