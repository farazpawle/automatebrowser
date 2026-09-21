import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { ToolError } from "./errors";
import type { Tool } from "./tool";

/**
 * Tools the PAGE declares about itself, rather than tools we bring to the page.
 *
 * One tool with an `action`, not two — the `browser_storage` / `browser_perf_trace`
 * precedent: two names for one capability cost every request twice and give an
 * agent a choice it does not need to make.
 *
 * Two conventions are read at once, and the reader lives in the extension
 * (`Chrome-extension/lib/automation/page-tools.ts`), which is also where the
 * verified findings about each are written down. The honest summary: the
 * discovery-event half works today in every browser tested, the WebMCP half
 * depends on a draft API whose availability differs between builds of the same
 * Chrome version, and almost no live site declares anything through either.
 *
 * `readOnlyHint` is false because a page tool can do anything the page can —
 * that is the point of it — so read-only mode (B9) must be able to refuse it.
 */

/**
 * The argument names of a page tool's JSON Schema, required ones starred — the
 * same shorthand the shipped tool reference uses. Without this an agent has to
 * read the whole schema out of `structuredContent` before it can call anything,
 * which is the one thing `list` exists to save it.
 */
function argNames(schema: unknown): string {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  if (!props || typeof props !== "object") return "";
  const required = new Set(
    ((schema as { required?: unknown }).required as string[] | undefined) ?? [],
  );
  return Object.keys(props)
    .map((k) => (required.has(k) ? `${k}*` : k))
    .join(", ");
}

export const PageToolsArgs = z.object({
  action: z.enum(["list", "call"]).describe("List what the page offers, or call one."),
  name: z.string().optional().describe("Which tool to call."),
  args: z.string().optional().describe("Its arguments, as a JSON object string."),
});

export const pageTools: Tool = {
  schema: {
    name: "browser_page_tools",
    description:
      "List and call actions a page declares about itself (WebMCP). They survive redesigns that " +
      "break clicking, but most sites declare none — list then says so rather than failing.",
    inputSchema: zodToJsonSchema(PageToolsArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = PageToolsArgs.parse(params ?? {});

    if (args.action === "call") {
      if (!args.name?.trim()) {
        throw new ToolError(
          "BAD_ARGS",
          'browser_page_tools action="call" needs the `name` of a tool. Call action="list" first.',
        );
      }
      // Validate here rather than in the page: a JSON typo should come back as a
      // named argument problem, not as a page-side exception the agent has to
      // guess the cause of.
      if (args.args !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.args);
        } catch (e) {
          throw new ToolError(
            "BAD_ARGS",
            `\`args\` is not valid JSON: ${(e as Error).message}. Pass a JSON object string, ` +
              `e.g. {"query":"socks"}.`,
          );
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ToolError(
            "BAD_ARGS",
            "`args` must be a JSON OBJECT string — a tool's arguments are named, so an array or a " +
              "bare value cannot be matched to them.",
          );
        }
      }

      const r = (await context.sendSocketMessage("browser_page_tools", {
        action: "call",
        name: args.name,
        args: args.args ?? "{}",
      })) as { name: string; source: string; resultJson: string | null };

      const text =
        r.resultJson == null
          ? `${r.name} ran, but its result would not encode as JSON (a DOM node, or a circular ` +
            `object). Read what changed with browser_snapshot, or call ` +
            `window.__dtmcp.executeTool("${r.name}", {...}) through browser_eval to keep the live value.`
          : r.resultJson;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          name: r.name,
          source: r.source,
          result: r.resultJson == null ? null : JSON.parse(r.resultJson),
        },
      };
    }

    const list = (await context.sendSocketMessage("browser_page_tools", {
      action: "list",
    })) as {
      tools: Array<Record<string, unknown>>;
      reason: string;
    };

    const text = list.tools.length
      ? list.tools
          .map((t) => {
            const where = t.group ? `${String(t.source)}:${String(t.group)}` : String(t.source);
            const params = argNames(t.inputSchema);
            return (
              `${String(t.name)}  [${where}]  ${String(t.description ?? "")}` +
              (params ? `\n    args: ${params}` : "")
            ).trim();
          })
          .join("\n")
      : list.reason;
    return {
      content: [{ type: "text", text }],
      structuredContent: { tools: list.tools, reason: list.reason },
    };
  },
};
