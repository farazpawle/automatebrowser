import { mcpConfig } from "@repo/config/mcp.config";

import type { Context } from "@/context";
import type { ToolResult } from "@/tools/tool";

type FullSnapshot = { url: string; title: string; snapshot: string };

/** Fetch URL, title, and snapshot. Prefer the single-message full snapshot and
 * fall back to the older three-message protocol for older extension builds. */
export async function captureAriaSnapshot(
  context: Context,
  status: string = "",
  /** Full tree instead of the lean one (C6). Refs are identical either way. */
  verbose = false,
): Promise<ToolResult> {
  let full: FullSnapshot | undefined;
  try {
    const result = (await context.sendSocketMessage(
      "browser_snapshot_full",
      { verbose },
      { timeoutMs: mcpConfig.timeouts.snapshot },
    )) as Partial<FullSnapshot>;
    if (
      typeof result?.url === "string" &&
      typeof result?.title === "string" &&
      typeof result?.snapshot === "string"
    ) {
      full = result as { url: string; title: string; snapshot: string };
    }
  } catch {
    /* Older extension builds only support the three-message form below. */
  }

  if (!full) {
    const [url, title, snapshot] = (await Promise.all([
      context.sendSocketMessage("getUrl", {}, { timeoutMs: mcpConfig.timeouts.default }),
      context.sendSocketMessage("getTitle", {}, { timeoutMs: mcpConfig.timeouts.default }),
      context.sendSocketMessage(
        "browser_snapshot",
        { verbose },
        {
          timeoutMs: mcpConfig.timeouts.snapshot,
        },
      ),
    ])) as [string, string, string];
    full = { url, title, snapshot };
  }

  const { url, title, snapshot } = full;

  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}
- Page URL: ${url}
- Page Title: ${title}
- Page Snapshot
\`\`\`yaml
${snapshot}
\`\`\`
`,
      },
    ],
    structuredContent: { url, title, snapshot },
  };
}
