import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * JS dialog handling (alert/confirm/prompt). Debugger-free PARTIAL: the extension
 * overrides the dialog functions at document_start, so it ARMS a policy for
 * FUTURE dialogs and reports the recent dialog log. A dialog fired synchronously
 * during initial load may be missed (full reliability needs CDP — Milestone 3).
 */

export const DialogArgs = z.object({
  action: z
    .enum(["accept", "dismiss", "native"])
    .optional()
    .describe(
      "How to auto-handle future dialogs: accept, dismiss, or native (reset to the browser default). " +
        "Omit to just read the recent dialog log without changing the policy.",
    ),
  promptText: z
    .string()
    .optional()
    .describe("Text to enter for window.prompt() when action=accept."),
});

export const handleDialog: Tool = {
  schema: {
    name: "browser_handle_dialog",
    description:
      "Control JS dialogs (alert/confirm/prompt). Arm an auto-response policy for future dialogs " +
      "(accept/dismiss/native) and/or read the recent dialog log. A dialog ALREADY blocking the page " +
      "can only be answered with browser_advanced_mode on; without it, reload the tab to clear one.",
    inputSchema: zodToJsonSchema(DialogArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = DialogArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_handle_dialog", args)) as {
      dialogs: Array<{ type: string; message: string; ts: number }>;
      policy: unknown;
      open?: { type: string; message: string } | null;
      cleared?: boolean;
    };
    const policyText = r.policy
      ? `Policy: ${JSON.stringify(r.policy)}`
      : "Policy: native (default)";
    const log =
      r.dialogs.length === 0
        ? "Recent dialogs: (none)"
        : "Recent dialogs:\n" + r.dialogs.map((d) => `  - ${d.type}: ${d.message}`).join("\n");
    return { content: [{ type: "text", text: `${policyText}\n${log}` }] };
  },
};
