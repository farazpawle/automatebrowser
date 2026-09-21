import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * C12 — proxy control (`chrome.proxy`), the one tool here that changes the WHOLE
 * browser rather than the driven tab.
 *
 * Kept as its own tool rather than an option on `browser_emulate` — which would
 * have been far cheaper in schema tokens, and where a "route my traffic through
 * X" option superficially fits. The reason is scope: every option on
 * `browser_emulate` is per-tab and evaporates when the tab does, and burying a
 * setting that changes the human's own browsing among them is exactly how a
 * browser-wide change gets made by accident.
 *
 * `chrome.proxy` is extension-only; CDP has no clean equivalent.
 */

const WHOLE_BROWSER =
  "⚠ This is the WHOLE browser, not just the automated tab — the human sharing this browser is " +
  "now routed the same way, and it stays that way until it is cleared. Call browser_proxy " +
  "{clear:true} to hand the setting back.";

export const ProxyArgs = z.object({
  mode: z
    .enum(["direct", "system", "auto_detect", "fixed_servers", "pac_script"])
    .optional()
    .describe("Omit to just report the current setting."),
  server: z.string().optional().describe("host:port, for fixed_servers."),
  pacUrl: z.string().optional().describe("PAC file URL, for pac_script."),
  bypass: z.array(z.string()).optional().describe("Hosts that skip the proxy."),
  clear: z.boolean().optional().describe("Restore the browser's own setting."),
});

export const proxy: Tool = {
  schema: {
    name: "browser_proxy",
    description:
      "Route the browser through a proxy. AFFECTS THE WHOLE BROWSER, not just the automated tab " +
      "(Chrome has no per-tab proxy). No arguments reports what is in force; {clear:true} gives the " +
      "setting back to the user.",
    inputSchema: zodToJsonSchema(ProxyArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = ProxyArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_proxy", args)) as {
      mode: string;
      levelOfControl: string;
      changed: boolean;
      detail?: string;
      warning?: string;
    };

    const head = args.clear
      ? "Proxy setting released back to the browser."
      : args.mode
        ? "Proxy set."
        : "Current proxy setting:";
    const lines = [
      `${head}\n  ${r.detail ?? r.mode}\n  control: ${r.levelOfControl.replace(/_/g, " ")}`,
    ];
    if (r.warning) lines.push(`⚠ ${r.warning}`);
    // The warning rides on every call that CHANGES the setting, not just on the
    // description: an agent reads a description once and a result every time.
    if (r.changed && !args.clear) lines.push(WHOLE_BROWSER);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
};
